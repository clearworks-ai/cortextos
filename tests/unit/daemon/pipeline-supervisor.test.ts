import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PipelineRunStore, type PipelineRun } from '../../../src/daemon/pipeline-run-store.js';
import { PipelineSupervisor } from '../../../src/daemon/pipeline-supervisor.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cortextos-pipeline-'));
  const store = new PipelineRunStore(root);
  const run: PipelineRun = {
    runId: 'run-001', slug: 'autonomous-fanout-ledger', goal: 'prove durable plan dispatch',
    state: 'gating', attempt: 0, maxAttempts: 3, revision: 0,
    workstreams: [{
      id: 'plan', phase: 'plan', deps: [], route: { runtime: 'codex-app-server', model: 'gpt-5.6-luna' },
      state: 'pending', attempt: 0, maxAttempts: 3, inputSha: 'research-sha',
    }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await store.create(run);
  return { root, store, run };
}

describe('PipelineSupervisor', () => {
  it('claims exactly once and records a pipeline_dispatch/v1 trace', async () => {
    const { root, store, run } = await fixture();
    const dispatched: string[] = [];
    const supervisor = new PipelineSupervisor({
      store, owner: 'test-owner', lockRoot: root,
      dispatch: async request => {
        dispatched.push(request.workstreamId);
        return { messageId: 'msg-001', replyTo: 'reply-001', scopeSha: 'scope-sha', inputSha: 'research-sha', observedResult: 'accepted' };
      },
    });
    await supervisor.start();
    await supervisor.stop();

    expect(dispatched).toEqual(['plan']);
    const current = await store.get(run.runId);
    expect(current?.workstreams[0].state).toBe('running');
    expect(current?.workstreams[0].lease?.owner).toBe('test-owner');
    const events = await store.events(run.runId);
    expect(events.map(event => event.type)).toEqual(['dispatch_claimed', 'pipeline_dispatch/v1']);
    expect(events[1]).toMatchObject({ version: 'pipeline_dispatch/v1', messageId: 'msg-001', inputSha: 'research-sha', scopeSha: 'scope-sha' });
  });

  it('rejects a stale receipt after a lease is reclaimed', async () => {
    const { root, store, run } = await fixture();
    const supervisor = new PipelineSupervisor({ store, owner: 'test-owner', lockRoot: root, leaseTtlMs: 10, maxAttempts: 3 });
    await supervisor.start();
    const leased = await store.get(run.runId);
    const lease = leased!.workstreams[0].lease!;
    await supervisor.reconcileTick(Date.now() + 100);
    const reclaimed = await store.get(run.runId);
    expect(reclaimed?.workstreams[0].state).toBe('retry_wait');
    expect(reclaimed?.workstreams[0].attempt).toBe(1);

    const accepted = await supervisor.complete({ runId: run.runId, workstreamId: 'plan', attempt: 0, fence: lease.fence, leaseToken: lease.token, artifactSha: 'artifact', transcriptPath: '/tmp/receipt.json' });
    expect(accepted).toBe(false);
    const raw = await readFile(join(root, 'pipeline-events', `${run.runId}.jsonl`), 'utf8');
    expect(raw).toContain('stale_receipt_rejected');
    await supervisor.stop();
  });

  it('accepts only the current fenced completion and persists the artifact', async () => {
    const { root, store, run } = await fixture();
    const supervisor = new PipelineSupervisor({ store, owner: 'test-owner', lockRoot: root });
    await supervisor.start();
    const leased = await store.get(run.runId);
    const ws = leased!.workstreams[0];
    const accepted = await supervisor.complete({ runId: run.runId, workstreamId: ws.id, attempt: ws.attempt, fence: ws.lease!.fence, leaseToken: ws.lease!.token, inputSha: ws.inputSha, artifactSha: 'artifact-sha', transcriptPath: '/tmp/plan-receipt.json', messageId: 'msg-001', replyTo: 'reply-001' });
    expect(accepted).toBe(true);
    const current = await store.get(run.runId);
    expect(current?.workstreams[0]).toMatchObject({ state: 'succeeded', artifact: { sha256: 'artifact-sha', path: '/tmp/plan-receipt.json' } });
    expect((await store.events(run.runId)).at(-1)).toMatchObject({ type: 'completion', to: 'succeeded', fence: ws.lease!.fence });
    await supervisor.stop();
  });
});
