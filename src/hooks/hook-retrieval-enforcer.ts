import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { readStdin } from './index.js';

const STOP = new Set([
  'read', 'transcript', 'transcripts', 'jsonl', 'what', 'that', 'this', 'with',
  'from', 'your', 'our', 'the', 'and', 'did', 'have', 'about', 'please', 'last',
  'time', 'session', 'sessions', 'previous', 'history', 'before', 'earlier',
  'recall', 'thorough', 'reference', 'past', 'look', 'into', 'them', 'were', 'they',
  'which', 'when', 'where', 'does', 'said', 'says', 'today', 'yesterday',
]);
const RETRIEVAL_DIRECTIVE = 'Deterministic retrieval ran BEFORE your response. Answer FROM the evidence below and CITE the source (path/timestamp). Do NOT answer from memory or guess. If the evidence is empty or thin, say so and run a deeper search yourself (cortextos bus kb-query, open the actual jsonl) BEFORE answering — never substitute assumption for a real read.';

export const RETRIEVAL_INTENT = new RegExp(
  [
    'transcript', 'jsonl',
    'what did (you|we|i)', 'last (time|session|week|night|month)',
    'earlier', 'recall', 'look (back|up)', 'thorough(ly)?',
    'reference (the )?past', 'previously', '\\bbefore\\b', '\\bhistory\\b',
    'read (the |your |our )?(past|old|previous|prior)', 'did (you|we) (ever|already)',
    'have (you|we) (ever|already)', 'go back', 'dig (in|up)',
  ].join('|'),
  'i',
);

export const URGENT = /urgent|prod(uction)? down|security incident|breaking|outage/i;

export interface PromptInput {
  prompt: string;
  sessionId?: string;
}

export interface RetrievalCacheState {
  turnCount: number;
  lastCommitsHash?: string;
  lastDirectionSentTurn?: number;
  lastKbQueryNormalized?: string;
  lastKbResultHash?: string;
  lastKbResultAtMs?: number;
}

export interface HookOutputEnvelope {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

interface LineText {
  txt: string;
  role: string;
  ts: string;
}

interface TranscriptCandidate {
  score: number;
  fileIndex: number;
  filePath: string;
  line: LineText;
}

interface BuildAdditionalContextOptions {
  agentName?: string;
  org?: string;
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeKbPrompt(prompt: string): string {
  return prompt.replace(/["`$\\]/g, '\'').replace(/\n/g, ' ').slice(0, 280).trim();
}

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  let text = '';
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

function lineText(line: string): LineText | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const message = isRecord(parsed.message) ? parsed.message : parsed;
  const content = 'content' in message ? message.content : parsed.content;
  const txt = extractText(content).trim();
  if (!txt || txt.includes('documented-past-retrieval')) {
    return null;
  }

  const role = coerceString(message.role || parsed.type);
  const ts = coerceString(parsed.timestamp);
  return { txt, role, ts };
}

export function readPrompt(raw: string): PromptInput {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const promptValue = parsed.prompt ?? parsed.user_prompt ?? parsed.message ?? '';
      const sessionId = parsed.session_id === undefined ? undefined : coerceString(parsed.session_id);
      return {
        prompt: coerceString(promptValue),
        sessionId: sessionId || undefined,
      };
    }
  } catch {
    // Fall back to raw text below.
  }

  return { prompt: coerceString(raw) };
}

export function kbQuery(prompt: string, org: string): string {
  const query = normalizeKbPrompt(prompt);
  if (!query) {
    return '';
  }
  try {
    // execFileSync with an argv array — no shell is ever involved, so neither
    // the user prompt nor the org value can inject commands. normalizeKbPrompt
    // is kept for query hygiene/cache-key parity, not as a security boundary.
    return execFileSync(
      'cortextos',
      ['bus', 'kb-query', query, '--org', org, '--top-k', '5', '--threshold', '0.45'],
      { encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '';
  }
}

export function extractKeywords(prompt: string): { strong: string[]; weak: string[] } {
  const all = [...new Set((prompt.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []))]
    .filter((word) => !STOP.has(word));
  const strong = all
    .filter((word) => word.length >= 7 || /[-0-9]/.test(word))
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  const weak = all.filter((word) => !strong.includes(word)).slice(0, 4);
  return { strong, weak };
}

export function listRecentTranscripts(agentName: string): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot())
      .filter((dir) => (agentName ? dir.includes(agentName) : true))
      .map((dir) => join(projectsRoot(), dir));
  } catch {
    return [];
  }

  const cutoff = Date.now() - 3 * 86400 * 1000;
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) {
          continue;
        }
        const filePath = join(dir, entry);
        try {
          const mtimeMs = statSync(filePath).mtimeMs;
          if (mtimeMs > cutoff) {
            files.push({ filePath, mtimeMs });
          }
        } catch {
          // Skip unreadable files.
        }
      }
    } catch {
      // Skip unreadable directories.
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((file) => file.filePath);
}

export function transcriptHits(prompt: string, agentName: string): string {
  const { strong, weak } = extractKeywords(prompt);
  if (!strong.length && !weak.length) {
    return '';
  }

  const files = listRecentTranscripts(agentName).slice(0, 14);
  const candidates: TranscriptCandidate[] = [];
  const maxTotal = 8;
  const maxPerFile = 3;
  const maxCandidatesPerFile = 6;

  files.forEach((filePath, fileIndex) => {
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8').split('\n');
    } catch {
      return;
    }

    let candidateCount = 0;
    for (let index = lines.length - 1; index >= 0 && candidateCount < maxCandidatesPerFile; index -= 1) {
      const lower = lines[index].toLowerCase();
      let score = 0;
      if (strong.length) {
        for (const keyword of strong) {
          if (lower.includes(keyword)) {
            score += keyword.length;
          }
        }
        if (!score) {
          continue;
        }
      } else {
        const weakMatches = weak.filter((keyword) => lower.includes(keyword)).length;
        if (weakMatches < Math.min(2, weak.length)) {
          continue;
        }
        score = weakMatches;
      }

      const line = lineText(lines[index]);
      if (!line || line.txt.length < 40) {
        continue;
      }

      candidates.push({ score, fileIndex, filePath, line });
      candidateCount += 1;
    }
  });

  candidates.sort((a, b) => b.score - a.score || a.fileIndex - b.fileIndex);
  const perFile: Record<string, number> = {};
  const picked: TranscriptCandidate[] = [];
  for (const candidate of candidates) {
    if (picked.length >= maxTotal) {
      break;
    }
    const count = (perFile[candidate.filePath] || 0) + 1;
    perFile[candidate.filePath] = count;
    if (count > maxPerFile) {
      continue;
    }
    picked.push(candidate);
  }

  picked.sort((a, b) => (b.line.ts || '').localeCompare(a.line.ts || ''));
  return picked
    .map((candidate) => `[${candidate.line.ts}] (${candidate.line.role}) ${candidate.line.txt.replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n---\n');
}

export function recentCommits(): string {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!top) {
      return '';
    }
    const commits = execFileSync(
      'git',
      [
        '-C', top,
        'log', '--all', '--since=48 hours ago', '-n', '12',
        '--date=format:%m-%d %H:%M',
        '--pretty=format:%h %ad%d %s',
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!commits) {
      return '';
    }
    return `repo ${basename(top)} (git log --all, last 48h, incl. unmerged branches):\n${commits}`;
  } catch {
    return '';
  }
}

export function conversationDirection(agentName: string): string {
  const files = listRecentTranscripts(agentName).slice(0, 3);
  const turns: string[] = [];

  for (const filePath of files) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8').split('\n');
    } catch {
      continue;
    }

    for (let index = lines.length - 1; index >= 0 && turns.length < 6; index -= 1) {
      const line = lineText(lines[index]);
      if (!line || line.txt.length < 30) {
        continue;
      }
      if (line.role !== 'user' && line.role !== 'assistant') {
        continue;
      }
      if (/^\[CRON FIRED/.test(line.txt) || line.txt.startsWith('<')) {
        continue;
      }
      turns.push(`[${line.ts}] ${line.role}: ${line.txt.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    if (turns.length >= 6) {
      break;
    }
  }

  return turns.reverse().join('\n');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function cachePathFor(agentName: string, sessionKey: string): string {
  const safeAgentName = agentName || 'unknown-agent';
  return join(
    tmpdir(),
    'cortextos-retrieval-cache',
    safeAgentName,
    `${sha256Hex(sessionKey).slice(0, 16)}.json`,
  );
}

export function readCache(filePath: string): RetrievalCacheState {
  try {
    if (!existsSync(filePath)) {
      return { turnCount: 0 };
    }
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) {
      return { turnCount: 0 };
    }
    return {
      turnCount: readOptionalNumber(parsed, 'turnCount') ?? 0,
      lastCommitsHash: readOptionalString(parsed, 'lastCommitsHash'),
      lastDirectionSentTurn: readOptionalNumber(parsed, 'lastDirectionSentTurn'),
      lastKbQueryNormalized: readOptionalString(parsed, 'lastKbQueryNormalized'),
      lastKbResultHash: readOptionalString(parsed, 'lastKbResultHash'),
      lastKbResultAtMs: readOptionalNumber(parsed, 'lastKbResultAtMs'),
    };
  } catch {
    return { turnCount: 0 };
  }
}

export function writeCache(filePath: string, state: RetrievalCacheState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state), 'utf8');
  } catch {
    // Fail open: cache writes must never block output.
  }
}

export function shouldForceOpen(prompt: string): boolean {
  return RETRIEVAL_INTENT.test(prompt) || URGENT.test(prompt);
}

export function shouldIncludeDirection(cache: RetrievalCacheState, prompt: string): boolean {
  return cache.turnCount === 0 || shouldForceOpen(prompt);
}

export function shouldIncludeCommits(
  commitsText: string,
  cache: RetrievalCacheState,
  prompt: string,
): boolean {
  return cache.turnCount === 0
    || shouldForceOpen(prompt)
    || sha256Hex(commitsText) !== cache.lastCommitsHash;
}

export function shouldRunKbQuery(prompt: string, strong: string[]): boolean {
  return RETRIEVAL_INTENT.test(prompt) || strong.length > 0 || prompt.length > 200;
}

export function buildOutputEnvelope(additionalContext: string): HookOutputEnvelope {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

export function buildAdditionalContext(
  raw: string,
  options: BuildAdditionalContextOptions = {},
): string {
  const { prompt, sessionId } = readPrompt(raw);
  if (!prompt || prompt.trim().length < 3) {
    return '';
  }
  if (/^\s*\[CRON FIRED/.test(prompt)) {
    return '';
  }

  const agentName = options.agentName || process.env.CTX_AGENT_NAME || '';
  const org = options.org || process.env.CTX_ORG || 'clearworksai';
  const transcriptPaths = listRecentTranscripts(agentName);
  const sessionKey = sessionId ?? `${agentName}:${transcriptPaths[0] ?? ''}`;
  const cachePath = cachePathFor(agentName, sessionKey);
  const cache = readCache(cachePath);
  const { strong } = extractKeywords(prompt);
  const commits = recentCommits();
  const includeCommits = Boolean(commits) && shouldIncludeCommits(commits, cache, prompt);
  const includeDirection = shouldIncludeDirection(cache, prompt);
  const includeKb = shouldRunKbQuery(prompt, strong);
  const wantTranscripts = RETRIEVAL_INTENT.test(prompt) || strong.length > 0;

  const direction = includeDirection ? conversationDirection(agentName) : '';
  const kb = includeKb ? kbQuery(prompt, org) : '';
  const transcript = wantTranscripts ? transcriptHits(prompt, agentName) : '';

  const sections: string[] = [];
  if (includeKb) {
    if (kb) {
      sections.push('', '## MMRAG (cortextos bus kb-query) — cited hits:', kb);
    } else {
      sections.push('', '## MMRAG: no hits above threshold. Broaden the query or read source directly before answering — do not conclude "nothing exists" from one miss.');
    }
  }
  if (includeCommits) {
    sections.push('', '## Recent commits — what just shipped (answer "what changed lately" from THIS, not memory):', commits);
  }
  if (includeDirection && direction) {
    sections.push('', '## Conversation direction — recent arc from your own transcripts (oldest -> newest):', direction);
  }
  if (wantTranscripts) {
    sections.push('', '## Transcript excerpts — recency-first jsonl reads (this IS reading the transcripts):');
    sections.push(transcript || '(no matching turns in last 3 days for the extracted keywords — widen keywords and read more files before claiming nothing exists)');
  }

  const nextState: RetrievalCacheState = {
    ...cache,
    turnCount: cache.turnCount + 1,
  };
  if (includeCommits) {
    nextState.lastCommitsHash = sha256Hex(commits);
  }
  if (includeDirection && direction) {
    nextState.lastDirectionSentTurn = nextState.turnCount;
  }
  if (includeKb) {
    nextState.lastKbQueryNormalized = normalizeKbPrompt(prompt);
    nextState.lastKbResultHash = sha256Hex(kb);
    nextState.lastKbResultAtMs = options.nowMs ?? Date.now();
  }
  writeCache(cachePath, nextState);

  if (sections.length === 0) {
    return '';
  }

  return [
    '<documented-past-retrieval>',
    RETRIEVAL_DIRECTIVE,
    ...sections,
    '</documented-past-retrieval>',
  ].join('\n');
}

export async function main(): Promise<void> {
  const raw = await readStdin();
  const additionalContext = buildAdditionalContext(raw, {
    agentName: process.env.CTX_AGENT_NAME,
    org: process.env.CTX_ORG || 'clearworksai',
  });
  process.stdout.write(JSON.stringify(buildOutputEnvelope(additionalContext)));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
