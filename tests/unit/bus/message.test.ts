import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox } from '../../../src/bus/message';
import { BuildGateError } from '../../../src/pipeline/build-gate';
import { describeArtifact, emitLedgerRow } from '../../../src/pipeline/ledger';
import type { BusPaths } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
    envSnapshot.CTX_PROJECT_ROOT = process.env.CTX_PROJECT_ROOT;
    envSnapshot.PIPELINE_SECRET_PATH = process.env.PIPELINE_SECRET_PATH;
    envSnapshot.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE = process.env.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });

    it('blocks ungated build dispatches before inbox write', () => {
      process.env.CTX_PROJECT_ROOT = testDir;
      process.env.PIPELINE_SECRET_PATH = join(testDir, '.pipeline-secret');
      writeFileSync(process.env.PIPELINE_SECRET_PATH, `${'ab'.repeat(32)}\n`, 'utf-8');

      expect(() => sendMessage(
        senderPaths,
        'sender',
        'codexer',
        'normal',
        `GATE: build framework=one-big-feature slug=hard-spec-gate repo=${testDir} scope-sha=${'a'.repeat(64)}`,
      )).toThrow(BuildGateError);

      const receiverInbox = join(testDir, 'inbox', 'codexer');
      expect(() => readdirSync(receiverInbox)).toThrow();
    });

    it('allows a valid build dispatch and writes the inbox message', () => {
      const repoRoot = join(testDir, 'repo');
      const secretPath = join(testDir, '.pipeline-secret');
      const projectsRoot = join(testDir, 'projects');
      const slugDir = join(repoRoot, '.agent', 'one-big-feature', 'hard-spec-gate');
      const researchPath = join(slugDir, '01-research.md');
      const planPath = join(slugDir, '02-master-plan.md');
      const specsDir = join(slugDir, '03-specs');
      const specPath = join(specsDir, '01-signed-stage-ledger.md');
      const planSession = 'plan-session-send';
      const specsSession = 'specs-session-send';
      const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
      const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
      const ledgerPath = join(repoRoot, 'state', 'pipeline-ledger.jsonl');
      const nowSeconds = Math.floor(Date.now() / 1000);

      mkdirSync(specsDir, { recursive: true });
      mkdirSync(dirname(planTranscript), { recursive: true });
      mkdirSync(dirname(specsTranscript), { recursive: true });
      writeFileSync(secretPath, `${'ab'.repeat(32)}\n`, 'utf-8');
      writeFileSync(researchPath, '# research\n', 'utf-8');
      writeFileSync(planPath, '# master plan\n', 'utf-8');
      writeFileSync(specPath, '# signed spec\n', 'utf-8');
      writeFileSync(planTranscript, `${JSON.stringify({
        type: 'assistant',
        sessionId: planSession,
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_write_plan',
            name: 'Write',
            input: { file_path: planPath, content: '# master plan\n' },
          }],
        },
      })}\n`, 'utf-8');
      writeFileSync(specsTranscript, `${JSON.stringify({
        type: 'assistant',
        sessionId: specsSession,
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_write_specs',
            name: 'Write',
            input: { file_path: specPath, content: '# signed spec\n' },
          }],
        },
      })}\n`, 'utf-8');

      emitLedgerRow({
        slug: 'hard-spec-gate',
        stage: 'research',
        artifactPath: researchPath,
        ledgerPath,
        secretPath,
        nowSeconds: nowSeconds - 30,
      });
      emitLedgerRow({
        slug: 'hard-spec-gate',
        stage: 'plan',
        artifactPath: planPath,
        runner: 'fable-lean',
        sessionId: planSession,
        transcriptPath: planTranscript,
        transcriptRoot: projectsRoot,
        ledgerPath,
        secretPath,
        nowSeconds: nowSeconds - 20,
      });
      emitLedgerRow({
        slug: 'hard-spec-gate',
        stage: 'specs',
        artifactPath: specsDir,
        runner: 'architect',
        sessionId: specsSession,
        transcriptPath: specsTranscript,
        transcriptRoot: projectsRoot,
        ledgerPath,
        secretPath,
        nowSeconds: nowSeconds - 10,
      });

      process.env.CTX_PROJECT_ROOT = repoRoot;
      process.env.PIPELINE_SECRET_PATH = secretPath;
      process.env.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE = projectsRoot;

      const msgId = sendMessage(
        senderPaths,
        'sender',
        'codexer',
        'normal',
        `GATE: build framework=one-big-feature slug=hard-spec-gate repo=${repoRoot} scope-sha=${describeArtifact(specsDir).sha256}`,
      );

      expect(msgId).toBeTruthy();
      const receiverInbox = join(testDir, 'inbox', 'codexer');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(1);
    });

    it('fails closed when the signing secret is unreadable but still allows GATE: comms', () => {
      process.env.CTX_PROJECT_ROOT = testDir;
      process.env.PIPELINE_SECRET_PATH = join(testDir, 'missing-secret');

      expect(() => sendMessage(
        senderPaths,
        'sender',
        'codexer',
        'normal',
        `GATE: build framework=one-big-feature slug=hard-spec-gate repo=${testDir} scope-sha=${'a'.repeat(64)}`,
      )).toThrow(/PIPELINE_GATE_BROKEN/);

      const msgId = sendMessage(senderPaths, 'sender', 'codexer', 'normal', 'GATE: comms status update');
      expect(msgId).toBeTruthy();
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      ackInbox(receiverPaths, msgId);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });
  });
});
