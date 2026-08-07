import { createHash } from 'node:crypto';
import type { GoalManifest, GoalManifestBoard, GoalManifestItem, GoalRun } from './goal-run.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const digestInventory = (objectiveSha256: string, boards: GoalManifestBoard[]): string => sha(JSON.stringify({ objectiveSha256, boards }));
const id = (kind: 'board' | 'item', ordinal: number): string => `${kind}-${String(ordinal + 1).padStart(3, '0')}`;

/** Parse structure only when the author supplied Markdown headings and lists. */
export function createGoalManifest(objectiveVerbatim: string, checkIds: string[] = []): GoalManifest {
  const evidenceRequirements = checkIds.map((checkId) => ({ checkId, required: true }));
  const lines = [...objectiveVerbatim.matchAll(/.*(?:\n|$)/g)].filter((match) => match[0] !== '');
  const headingIndexes = lines.flatMap((line, index) => /^#{1,6}\s+.+(?:\n)?$/.test(line[0]) ? [index] : []);
  const boards: GoalManifestBoard[] = [];
  let itemOrdinal = 0;
  if (headingIndexes.length > 0) {
    for (let boardOrdinal = 0; boardOrdinal < headingIndexes.length; boardOrdinal += 1) {
      const lineIndex = headingIndexes[boardOrdinal]!; const heading = lines[lineIndex]!;
      const start = heading.index!; const end = headingIndexes[boardOrdinal + 1] === undefined ? objectiveVerbatim.length : lines[headingIndexes[boardOrdinal + 1]!]!.index!;
      const boardId = id('board', boards.length);
      const items: GoalManifestItem[] = [];
      for (let index = lineIndex + 1; index < (headingIndexes[boardOrdinal + 1] ?? lines.length); index += 1) {
        const line = lines[index]!; const match = line[0].match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*?)(?:\n)?$/);
        if (!match) continue;
        const textStart = line.index! + match[1]!.length; const text = match[2]!;
        items.push({ id: id('item', itemOrdinal++), ordinal: itemOrdinal - 1, boardId, textVerbatim: text, sourceSpan: { start: textStart, end: textStart + text.length }, evidenceRequirements: [...evidenceRequirements] });
      }
      const titleMatch = heading[0].match(/^#{1,6}\s+(.*?)(?:\n)?$/)!; const titleStart = start + heading[0].indexOf(titleMatch[1]!);
      if (items.length) boards.push({ id: boardId, ordinal: boards.length, titleVerbatim: titleMatch[1]!, sourceSpan: { start: titleStart, end: titleStart + titleMatch[1]!.length }, items });
    }
  }
  if (!boards.length) {
    const boardId = id('board', 0);
    boards.push({ id: boardId, ordinal: 0, titleVerbatim: objectiveVerbatim, sourceSpan: { start: 0, end: objectiveVerbatim.length }, items: [{ id: id('item', 0), ordinal: 0, boardId, textVerbatim: objectiveVerbatim, sourceSpan: { start: 0, end: objectiveVerbatim.length }, evidenceRequirements }] });
  }
  const objectiveSha256 = sha(objectiveVerbatim);
  return { schemaVersion: 3, objectiveVerbatim, objectiveSha256, manifestSha256: digestInventory(objectiveSha256, boards), boards };
}

export function validateGoalManifest(manifest: GoalManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 3) errors.push('manifest schema must be 3');
  if (sha(manifest.objectiveVerbatim) !== manifest.objectiveSha256) errors.push('objective digest mismatch');
  const boardIds = new Set<string>(); const itemIds = new Set<string>(); let ordinal = 0;
  manifest.boards.forEach((board, boardIndex) => {
    if (board.ordinal !== boardIndex || board.id !== id('board', boardIndex) || boardIds.has(board.id)) errors.push(`invalid board identity/order: ${board.id}`);
    boardIds.add(board.id);
    if (manifest.objectiveVerbatim.slice(board.sourceSpan.start, board.sourceSpan.end) !== board.titleVerbatim) errors.push(`board source mismatch: ${board.id}`);
    board.items.forEach((item) => {
      if (item.ordinal !== ordinal || item.id !== id('item', ordinal) || item.boardId !== board.id || itemIds.has(item.id)) errors.push(`invalid item identity/order: ${item.id}`);
      itemIds.add(item.id); ordinal += 1;
      if (manifest.objectiveVerbatim.slice(item.sourceSpan.start, item.sourceSpan.end) !== item.textVerbatim) errors.push(`item source mismatch: ${item.id}`);
      const checks = item.evidenceRequirements.map((requirement) => requirement.checkId);
      if (checks.length !== new Set(checks).size) errors.push(`duplicate evidence requirement: ${item.id}`);
    });
  });
  if (!ordinal) errors.push('manifest has no items');
  if (digestInventory(manifest.objectiveSha256, manifest.boards) !== manifest.manifestSha256) errors.push('manifest digest mismatch');
  return errors;
}

export function migrateGoalRun(run: GoalRun): GoalRun {
  if (run.schemaVersion === 3 || ['done', 'cancelled', 'exhausted'].includes(run.state)) return run;
  const manifest = createGoalManifest(run.goal, run.acceptanceChecks.filter((check) => check.required).map((check) => check.id));
  const now = run.updatedAt;
  return { ...run, schemaVersion: 3, manifest, itemProgress: manifest.boards.flatMap((board) => board.items).map((item) => ({ itemId: item.id, status: run.state === 'needs_human' ? 'waiting' : 'runnable', phase: 'implementation', cycle: 1, attempt: run.attempt, implementationThreadId: run.threadId, evidenceReceipts: [], reviewReceipts: [], findings: [], updatedAt: now })), schedulingCursor: 0 };
}

export interface GoalAudit { passed: boolean; errors: string[]; }
const sameArgv = (one: string[], two: string[]): boolean => one.length === two.length && one.every((value, index) => value === two[index]);
const validPassedResult = (result: import('./goal-run.js').GoalCheckResult, check: import('./goal-run.js').GoalAcceptanceCheck, itemId?: string, cycle?: number): boolean => result.passed === true && result.classification === 'passed' && result.exitCode === 0 && result.signal === null && Number.isFinite(Date.parse(result.timestamp)) && sameArgv(result.command, check.command) && result.itemId === itemId && result.cycle === cycle;
const time = (value: string): number => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.NaN;
export function auditGoalCompletion(run: GoalRun): GoalAudit {
  if (run.schemaVersion !== 3 || !run.manifest || !run.itemProgress) return { passed: false, errors: ['schema-v3 manifest and progress required'] };
  const errors = validateGoalManifest(run.manifest);
  if (run.goal !== run.manifest.objectiveVerbatim) errors.push('goal/objective mismatch');
  const items = run.manifest.boards.flatMap((board) => board.items);
  if (run.itemProgress.length !== items.length) errors.push('progress count mismatch');
  if (new Set(run.itemProgress.map((progress) => progress.itemId)).size !== run.itemProgress.length) errors.push('duplicate progress item');
  const artifactIds = run.artifacts.map((artifact) => artifact.id); const artifacts = new Map(run.artifacts.map((artifact) => [artifact.id, artifact])); if (new Set(artifactIds).size !== artifactIds.length) errors.push('duplicate artifact IDs');
  const artifactMatches = (artifactId: string, expected: { checkId?: string; itemId?: string; cycle?: number; implementation?: boolean }): boolean => { const artifact = artifacts.get(artifactId); if (!artifact) return false; const metadata = artifact.metadata ?? {}; return metadata.checkId === expected.checkId && metadata.itemId === expected.itemId && metadata.cycle === expected.cycle && (!expected.implementation || metadata.provenance === 'implementation'); };
  const checks = new Map(run.acceptanceChecks.map((check) => [check.id, check]));
  for (const item of items) {
    const progress = run.itemProgress.find((candidate) => candidate.itemId === item.id);
    if (!progress) { errors.push(`missing progress: ${item.id}`); continue; }
    if (progress.status !== 'done') errors.push(`item not done: ${item.id}`);
    if (progress.blocker) errors.push(`active blocker: ${item.id}`);
    if (progress.findings.some((finding) => !finding.resolved)) errors.push(`unresolved finding: ${item.id}`);
    if (!progress.implementationReceipt || progress.implementationReceipt.itemId !== item.id || progress.implementationReceipt.cycle !== progress.cycle || progress.implementationReceipt.status !== 'completed') errors.push(`missing current implementation receipt: ${item.id}`);
    else if (progress.implementationReceipt.artifactIds.some((artifactId) => !artifactMatches(artifactId, { itemId: item.id, cycle: progress.cycle, implementation: true }))) errors.push(`missing or wrong-provenance implementation artifact: ${item.id}`);
    const implementationAt = progress.implementationReceipt ? time(progress.implementationReceipt.timestamp) : Number.NaN;
    for (const requirement of item.evidenceRequirements.filter((entry) => entry.required)) {
      const check = checks.get(requirement.checkId); const receipt = progress.evidenceReceipts.find((entry) => entry.itemId === item.id && entry.cycle === progress.cycle && entry.checkId === requirement.checkId);
      if (!check || !receipt || !receipt.passed || !validPassedResult(receipt.result, check, item.id, progress.cycle)) errors.push(`invalid current evidence ${requirement.checkId}: ${item.id}`);
      else {
        if (!(time(receipt.timestamp) >= implementationAt)) errors.push(`evidence ordering invalid: ${item.id}`);
        const referenced = [receipt.result.stdoutArtifact, receipt.result.stderrArtifact, ...receipt.artifactIds].filter((value): value is string => Boolean(value)); if (referenced.some((artifactId) => !artifactMatches(artifactId, { checkId: requirement.checkId, itemId: item.id, cycle: progress.cycle }))) errors.push(`missing or wrong-provenance evidence artifact ${requirement.checkId}: ${item.id}`);
        const persisted = (run.checkResults ?? []).find((result) => result.checkId === check.id && result.itemId === item.id && result.cycle === progress.cycle && validPassedResult(result, check, item.id, progress.cycle)); if (!persisted || JSON.stringify(persisted) !== JSON.stringify(receipt.result)) errors.push(`missing or mismatched current check result ${requirement.checkId}: ${item.id}`);
      }
    }
    const review = progress.reviewReceipts.find((entry) => entry.cycle === progress.cycle && entry.decision === 'approved');
    const cycleFindings = progress.findings.filter((finding) => finding.cycle === progress.cycle);
    if (!review || review.itemId !== item.id || review.reviewerThreadId !== progress.reviewerThreadId || review.reviewerThreadId === progress.implementationThreadId) errors.push(`missing independent review: ${item.id}`);
    else {
      if (cycleFindings.length || review.findingIds.length) errors.push(`approved review contains findings: ${item.id}`);
      const evidenceTimes = progress.evidenceReceipts.filter((entry) => entry.cycle === progress.cycle).map((entry) => time(entry.timestamp)); if (!evidenceTimes.length || evidenceTimes.some((timestamp) => !(time(review.timestamp) >= timestamp))) errors.push(`review ordering invalid: ${item.id}`);
    }
  }
  if (!run.finalVerificationPassed) errors.push('final verification not passed');
  const latestReview = Math.max(...run.itemProgress.flatMap((progress) => progress.reviewReceipts.filter((receipt) => receipt.cycle === progress.cycle && receipt.decision === 'approved').map((receipt) => time(receipt.timestamp))));
  for (const check of run.acceptanceChecks.filter((entry) => (entry.scope ?? 'global') === 'global')) {
    const result = [...(run.checkResults ?? [])].reverse().find((candidate) => candidate.checkId === check.id && candidate.itemId === undefined && candidate.cycle === undefined);
    if (!result || !sameArgv(result.command, check.command) || !Number.isFinite(Date.parse(result.timestamp)) || time(result.timestamp) < latestReview || (check.required && !validPassedResult(result, check, undefined, undefined))) errors.push(`missing or stale final result: ${check.id}`);
    else if ([result.stdoutArtifact, result.stderrArtifact].filter((value): value is string => Boolean(value)).some((artifactId) => !artifactMatches(artifactId, { checkId: check.id }))) errors.push(`missing or wrong-provenance final artifact: ${check.id}`);
  }
  return { passed: errors.length === 0, errors };
}
