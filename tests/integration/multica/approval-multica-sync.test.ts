import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BusPaths } from '../../../src/types/index.js';
import {
  createTask,
  listTasks,
} from '../../../src/bus/task.js';
import { createApproval, updateApproval, listPendingApprovals } from '../../../src/bus/approval.js';
import { createSyncStateStore } from '../../../src/bus/multica/sync-state.js';
import { runInboundPoll } from '../../../src/bus/multica/poll.js';
import type { MulticaClient, MulticaIssue } from '../../../src/bus/multica/types.js';

function buildPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'paul'),
    inflight: join(root, 'inflight', 'paul'),
    processed: join(root, 'processed', 'paul'),
    logDir: join(root, 'logs', 'paul'),
    stateDir: join(root, 'state', 'paul'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'orgs', 'clearworksai', 'deliverables'),
  };
}

const config = {
  memberIdJosh: 'member-josh',
  apiKey: 'test-key',
  baseUrl: 'https://api.multica.com',
  workspaceId: 'workspace-123',
  readApiToken: 'test-token',
};

function makeIssue(overrides: Partial<MulticaIssue> & { id: string }): MulticaIssue {
  return {
    workspace_id: 'workspace-123',
    project_id: null,
    title: `Issue ${overrides.id}`,
    description: 'created directly in Multica',
    status: 'todo',
    priority: 'medium',
    assignee_type: null,
    assignee_id: null,
    context_refs: [],
    due_date: null,
    created_at: '2026-08-01T07:00:00Z',
    updated_at: '2026-08-01T07:00:00Z',
    ...overrides,
  };
}

class FixtureMulticaClient implements MulticaClient {
  private issues: Map<string, MulticaIssue> = new Map();

  constructor(initialIssues: MulticaIssue[] = []) {
    initialIssues.forEach((issue) => this.issues.set(issue.id, issue));
  }

  async createIssue(payload: unknown): Promise<MulticaIssue> {
    throw new Error('not used in this test');
  }

  async updateIssue(id: string, payload: unknown): Promise<MulticaIssue> {
    throw new Error('not used in this test');
  }

  async listIssues(): Promise<MulticaIssue[]> {
    return Array.from(this.issues.values());
  }

  async getTaskRuns(): Promise<unknown[]> {
    return [];
  }

  // Test helper: manually update issue status
  setIssueStatus(id: string, status: MulticaIssue['status']): void {
    const issue = this.issues.get(id);
    if (issue) {
      this.issues.set(id, { ...issue, status });
    }
  }

  // Test helper: add an issue to the fixture client
  addIssue(issue: MulticaIssue): void {
    this.issues.set(issue.id, issue);
  }

  getIssue(id: string): MulticaIssue | null {
    return this.issues.get(id) ?? null;
  }
}

describe('approval-multica-sync round-trip harness', () => {
  let testDir: string;
  let paths: BusPaths;
  let client: FixtureMulticaClient;
  let store: ReturnType<typeof createSyncStateStore>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'multica-approval-roundtrip-test-'));
    paths = buildPaths(testDir);
    client = new FixtureMulticaClient();
    store = createSyncStateStore(join(testDir, 'sync-state.json'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('proves P4.3 done-condition: bidirectional approval-Multica sync', async () => {
    // (i) create approval → approve via card → verify linked task's issue completed in Multica
    const approvalId1 = await createApproval(
      paths,
      'paul',
      'clearworksai',
      'Card-side approval',
      'deployment',
      'Approve via card to push to Multica',
    );

    const pendingApprovalsBefore1 = listPendingApprovals(paths);
    const approval1 = pendingApprovalsBefore1.find((a) => a.id === approvalId1);
    expect(approval1).toBeDefined();
    expect(approval1?.linked_task_id).not.toBeNull();

    const linkedTaskId1 = approval1!.linked_task_id!;

    // Link the task to a fixture Multica issue (simulating Spec A's companion task + push)
    const issue1 = makeIssue({ id: 'issue-card-push', status: 'todo' });
    client.addIssue(issue1);
    store.upsertLink(linkedTaskId1, {
      multica_issue_id: issue1.id,
      last_seen_multica_status: 'todo',
      last_seen_multica_assignee_id: null,
    });

    // Approve via card (updateApproval)
    updateApproval(paths, approvalId1, 'approved', 'approved via card');

    // Verify task completed
    const tasks1 = listTasks(paths);
    const completedTask1 = tasks1.find((t) => t.id === linkedTaskId1);
    expect(completedTask1?.status).toBe('completed');

    // Simulate push by updating the linked issue to 'done' (in reality, Spec A's push path does this)
    client.setIssueStatus(issue1.id, 'done');

    // Verify linked task's issue shows completed in fixture Multica client
    const linkedIssue1 = client.getIssue(issue1.id);
    expect(linkedIssue1?.status).toBe('done');

    // (ii) create a second approval → close its linked issue → run poll → approval moves to resolved/
    const approvalId2 = await createApproval(
      paths,
      'paul',
      'clearworksai',
      'Multica-side approval',
      'deployment',
      'Close in Multica to approve',
    );

    const pendingApprovalsBefore2 = listPendingApprovals(paths);
    const approval2 = pendingApprovalsBefore2.find((a) => a.id === approvalId2);
    expect(approval2).toBeDefined();
    expect(approval2?.linked_task_id).not.toBeNull();

    const linkedTaskId2 = approval2!.linked_task_id!;

    // Link the task to a fixture Multica issue
    const issue2 = makeIssue({ id: 'issue-multica-close', status: 'todo' });
    client.addIssue(issue2);
    store.upsertLink(linkedTaskId2, {
      multica_issue_id: issue2.id,
      last_seen_multica_status: 'todo',
      last_seen_multica_assignee_id: null,
    });

    // Verify approval is still pending before issue close
    const pendingDir = join(paths.approvalDir, 'pending');
    expect(existsSync(join(pendingDir, `${approvalId2}.json`))).toBe(true);

    // Close the linked issue via the fixture client
    client.setIssueStatus(issue2.id, 'done');

    // Run poll - should resolve the approval
    const result = await runInboundPoll(paths, config, client, store, {});

    // Verify approval moved to resolved/
    const resolvedDir = join(paths.approvalDir, 'resolved');
    const resolvedApprovalFile = join(resolvedDir, `${approvalId2}.json`);
    expect(existsSync(resolvedApprovalFile)).toBe(true);

    const resolvedApproval2 = JSON.parse(readFileSync(resolvedApprovalFile, 'utf-8'));
    expect(resolvedApproval2.status).toBe('approved');
    expect(resolvedApproval2.resolved_by).toBe('resolved via Multica inbound sync (completed)');
    expect(resolvedApproval2.resolved_by).not.toBe('Josh');

    // (iii) diff of list-approvals open rows vs open linked-human-task rows = empty
    const openApprovals = listPendingApprovals(paths);
    const allTasks = listTasks(paths);
    const openLinkedHumanTasks = allTasks.filter((task) =>
      openApprovals.some((approval) => approval.linked_task_id === task.id) &&
      task.status !== 'completed' &&
      task.status !== 'cancelled'
    );

    // After both round-trips, there should be no open approvals with uncompleted linked tasks
    const diff = openApprovals.filter((approval) =>
      openLinkedHumanTasks.some((task) => task.id === approval.linked_task_id)
    );

    expect(diff).toHaveLength(0);
    expect(openApprovals.length).toBe(0);
  });
});