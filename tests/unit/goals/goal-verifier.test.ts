import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createGoalManifest } from '../../../src/goals/goal-manifest.js';
import { DEFAULT_GOAL_CONFIG, type GoalRun } from '../../../src/goals/goal-run.js';
import { GoalVerifier } from '../../../src/goals/goal-verifier.js';
const make = (checks: GoalRun['acceptanceChecks']): GoalRun => { const manifest = createGoalManifest('verify', checks.map((check) => check.id)); return { schemaVersion: 3, id: 'v', agentName: 'a', goal: 'verify', repo: process.cwd(), state: 'verifying', manifest, itemProgress: [{ itemId: 'item-001', status: 'runnable', phase: 'verification', cycle: 1, attempt: 0, evidenceReceipts: [], reviewReceipts: [], findings: [], updatedAt: 'x' }], attempt: 0, maxAttempts: 3, acceptanceChecks: checks, artifacts: [], events: [], createdAt: 'x', updatedAt: 'x' }; };
describe('GoalVerifier current-cycle evidence', () => {
  it.skipIf(process.platform === 'win32')('keeps a minimal host alive until resistant process-group teardown completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-verifier-minimal-host-'));
    const pidPath = join(directory, 'pids.json');
    const resultPath = join(directory, 'result.json');
    const checkSource = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({parent:process.pid,grandchild:child.pid}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
    const run = make([{ id: 'minimal-host-resistant', command: [process.execPath, '-e', checkSource], timeoutMs: 500, required: true }]);
    const verifierUrl = pathToFileURL(resolve('src/goals/goal-verifier.ts')).href;
    const configUrl = pathToFileURL(resolve('src/goals/goal-run.ts')).href;
    const hostSource = `import {writeFile} from 'node:fs/promises';import verifierModule from ${JSON.stringify(verifierUrl)};import configModule from ${JSON.stringify(configUrl)};const {GoalVerifier}=verifierModule;const {DEFAULT_GOAL_CONFIG}=configModule;const result=await new GoalVerifier(DEFAULT_GOAL_CONFIG).verify(${JSON.stringify(run)});await writeFile(${JSON.stringify(resultPath)},JSON.stringify({classification:result.results[0]?.classification}));`;
    let pids: { parent: number; grandchild: number } | undefined;
    try {
      const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', hostSource], { cwd: process.cwd(), stdio: 'ignore' });
      const [code, signal] = await once(host, 'close') as [number | null, NodeJS.Signals | null];
      pids = JSON.parse(await readFile(pidPath, 'utf8')) as { parent: number; grandchild: number };
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual({ classification: 'timeout' });
      for (const pid of [pids.parent, pids.grandchild]) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pids) for (const pid of [pids.parent, pids.grandchild]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === 'win32')('keeps SIGKILL escalation armed when the TERM-exiting leader closes before its stdio-ignored resistant grandchild', async () => { const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));console.log(JSON.stringify({parent:process.pid,grandchild:child.pid}));setInterval(()=>{},1000)`; const run = make([{ id: 'resistant', command: [process.execPath, '-e', source], timeoutMs: 500, required: true }]); const started = Date.now(); const result = await new GoalVerifier(DEFAULT_GOAL_CONFIG).verify(run); expect(Date.now() - started).toBeGreaterThanOrEqual(700); expect(Date.now() - started).toBeLessThan(3_000); expect(result.results[0]?.classification).toBe('timeout'); const output = result.artifacts.find((artifact) => artifact.type === 'stdout')?.content ?? ''; const pids = JSON.parse(output.trim()) as { parent: number; grandchild: number }; await new Promise((resolve) => setTimeout(resolve, 50)); for (const pid of [pids.parent, pids.grandchild]) expect(() => process.kill(pid, 0)).toThrow(); });
  it('records every selected argv check and bounds/redacts artifacts', async () => { const run = make([{ id: 'bad', command: [process.execPath, '-e', "process.stderr.write('token=supersecret');process.exit(1)"], timeoutMs: 1000, required: true }, { id: 'good', command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 1000, required: true }]); const result = await new GoalVerifier({ ...DEFAULT_GOAL_CONFIG, maxInlineArtifactBytes: 16 }).verifyItem(run, run.manifest!.boards[0]!.items[0]!, 1); expect(result.results.map((entry) => entry.checkId)).toEqual(['bad', 'good']); expect(result.passed).toBe(false); expect(result.artifacts.map((entry) => entry.content).join('')).not.toContain('supersecret'); });
  it('fails closed for a missing declared check', async () => { const run = make([]); run.manifest!.boards[0]!.items[0]!.evidenceRequirements = [{ checkId: 'missing', required: true }]; const result = await new GoalVerifier(DEFAULT_GOAL_CONFIG).verifyItem(run, run.manifest!.boards[0]!.items[0]!, 1); expect(result.passed).toBe(false); expect(result.results[0]?.classification).toBe('missing_result'); });
  it('final audit rejects manifest/stale evidence/findings and accepts only complete current proof', () => {
    const run = make([{ id: 'proof', command: ['true'], timeoutMs: 1, required: true }]); const progress = run.itemProgress![0]!; const result = { checkId: 'proof', command: ['true'], passed: true, exitCode: 0, signal: null, classification: 'passed' as const, durationMs: 1, timestamp: '1970-01-01T00:00:02.000Z', itemId: progress.itemId, cycle: 1 };
    progress.status = 'done'; progress.phase = 'review'; progress.implementationThreadId = 'implementation'; progress.reviewerThreadId = 'review'; progress.implementationReceipt = { itemId: progress.itemId, cycle: 1, status: 'completed', summary: 'done', artifactIds: [], timestamp: '1970-01-01T00:00:01.000Z' }; progress.evidenceReceipts = [{ itemId: progress.itemId, cycle: 1, checkId: 'proof', passed: true, result, artifactIds: [], timestamp: '1970-01-01T00:00:02.000Z' }]; progress.reviewReceipts = [{ itemId: progress.itemId, cycle: 1, reviewerThreadId: 'review', decision: 'approved', findingIds: [], timestamp: '1970-01-01T00:00:03.000Z' }]; run.checkResults = [result, { ...result, timestamp: '1970-01-01T00:00:04.000Z', itemId: undefined, cycle: undefined }]; run.finalVerificationPassed = true;
    const verifier = new GoalVerifier(DEFAULT_GOAL_CONFIG); expect(verifier.verifyFinal(run).passed).toBe(true);
    const stale = structuredClone(run); stale.itemProgress![0]!.evidenceReceipts[0]!.cycle = 0; expect(verifier.verifyFinal(stale).passed).toBe(false);
    const finding = structuredClone(run); finding.itemProgress![0]!.findings = [{ id: 'f', itemId: 'item-001', cycle: 1, severity: 'blocking', summary: 'bug', resolved: false, timestamp: '3' }]; expect(verifier.verifyFinal(finding).passed).toBe(false);
    const changed = structuredClone(run); changed.manifest!.boards[0]!.items[0]!.textVerbatim = 'renamed'; expect(verifier.verifyFinal(changed).passed).toBe(false);
    for (const mutate of [
      (value: GoalRun) => { value.itemProgress![0]!.evidenceReceipts[0]!.result.classification = 'failed'; },
      (value: GoalRun) => { value.itemProgress![0]!.evidenceReceipts[0]!.result.exitCode = 1; },
      (value: GoalRun) => { value.itemProgress![0]!.evidenceReceipts[0]!.result.command = ['wrong']; },
      (value: GoalRun) => { value.itemProgress![0]!.evidenceReceipts[0]!.result.itemId = 'wrong'; },
      (value: GoalRun) => { value.itemProgress![0]!.evidenceReceipts[0]!.artifactIds = ['missing']; },
      (value: GoalRun) => { value.checkResults = value.checkResults?.filter((entry) => entry.itemId === undefined); },
      (value: GoalRun) => { value.itemProgress![0]!.reviewReceipts[0]!.timestamp = '1970-01-01T00:00:00.000Z'; },
      (value: GoalRun) => { value.itemProgress![0]!.reviewReceipts[0]!.findingIds = ['ghost']; },
    ]) { const invalid = structuredClone(run); mutate(invalid); expect(verifier.verifyFinal(invalid).passed).toBe(false); }
    const duplicate = structuredClone(run); duplicate.artifacts = [{ id: 'dup', type: 'custom', timestamp: '1970-01-01T00:00:02.000Z' }, { id: 'dup', type: 'custom', timestamp: '1970-01-01T00:00:04.000Z' }]; expect(verifier.verifyFinal(duplicate).errors).toContain('duplicate artifact IDs');
    const sharedWrongProvenance = structuredClone(run); sharedWrongProvenance.artifacts = [{ id: 'shared', type: 'stdout', content: 'proof', timestamp: '1970-01-01T00:00:02.000Z', metadata: { checkId: 'proof', itemId: 'item-001', cycle: 1 } }]; sharedWrongProvenance.itemProgress![0]!.evidenceReceipts[0]!.result.stdoutArtifact = 'shared'; sharedWrongProvenance.itemProgress![0]!.evidenceReceipts[0]!.artifactIds = ['shared']; sharedWrongProvenance.checkResults![0] = structuredClone(sharedWrongProvenance.itemProgress![0]!.evidenceReceipts[0]!.result); sharedWrongProvenance.checkResults![1]!.stdoutArtifact = 'shared'; expect(verifier.verifyFinal(sharedWrongProvenance).errors).toContain('missing or wrong-provenance final artifact: proof');
  });
});
