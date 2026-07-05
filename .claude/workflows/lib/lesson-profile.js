const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { basename, dirname } = require('node:path');

const PROFILE_PATH = process.env.LESSON_PROFILE_PATH || '/Users/joshweiss/code/knowledge-sync/lessons/PROFILE.md';
const HEADER_LINES = [
  '# LESSON PROFILE — canonical, machine-maintained. Do not hand-edit lines; use lesson-profile.js.',
  '# Cap: 60 lines. Write path: lesson-profile.js upsert. Read path: dynamic-pipeline plan stage.',
];
const LINE_RE = /^- \[([a-z0-9-]+)\] (.+?) \| seen:(\d+) \| last:(\d{4}-\d{2}-\d{2}) \| src:(\S+)(?: \| fix-task:(\S+))?$/;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'not', 'you', 'are', 'was', 'must', 'that', 'with', 'this', 'before', 'never', 'always',
]);
const MAX_LINES = 60;
const MAX_BODY_BYTES = 8 * 1024;
const THRESHOLD = 3;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeDomain(domain) {
  const normalized = String(domain || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'general';
}

function normalizeExact(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTokens(text) {
  const normalized = normalizeExact(text);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function jaccardSimilarity(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function compareNewestFirst(left, right) {
  if (left.seen !== right.seen) {
    return right.seen - left.seen;
  }
  if (left.last !== right.last) {
    return right.last.localeCompare(left.last);
  }
  if (left.domain !== right.domain) {
    return left.domain.localeCompare(right.domain);
  }
  return left.text.localeCompare(right.text);
}

function compareEvictionPriority(left, right) {
  if (left.seen !== right.seen) {
    return left.seen - right.seen;
  }
  if (left.last !== right.last) {
    return left.last.localeCompare(right.last);
  }
  if (left.domain !== right.domain) {
    return left.domain.localeCompare(right.domain);
  }
  return left.text.localeCompare(right.text);
}

function serializeLine(entry) {
  const fixTask = entry.fixTask ? ` | fix-task:${entry.fixTask}` : '';
  return `- [${entry.domain}] ${entry.text} | seen:${entry.seen} | last:${entry.last} | src:${entry.src}${fixTask}`;
}

function serializeProfile(entries) {
  const ordered = [...entries].sort(compareNewestFirst);
  return `${HEADER_LINES.join('\n')}\n${ordered.map(serializeLine).join('\n')}${ordered.length ? '\n' : ''}`;
}

function trimProfile(entries) {
  const next = [...entries];
  while (next.length > MAX_LINES || Buffer.byteLength(serializeProfile(next), 'utf8') > MAX_BODY_BYTES) {
    next.sort(compareEvictionPriority);
    next.shift();
  }
  return next;
}

function readProfile() {
  try {
    if (!existsSync(PROFILE_PATH)) {
      return [];
    }

    const raw = readFileSync(PROFILE_PATH, 'utf8');
    if (!raw.trim()) {
      return [];
    }

    const entries = [];
    for (const line of raw.split('\n')) {
      const match = LINE_RE.exec(line.trim());
      if (!match) {
        continue;
      }
      entries.push({
        domain: match[1],
        text: match[2],
        seen: Number(match[3]),
        last: match[4],
        src: match[5],
        fixTask: match[6] || undefined,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function writeProfile(entries) {
  const next = trimProfile(entries);
  try {
    mkdirSync(dirname(PROFILE_PATH), { recursive: true });
    const tmpPath = `${PROFILE_PATH}.tmp`;
    writeFileSync(tmpPath, serializeProfile(next), 'utf8');
    renameSync(tmpPath, PROFILE_PATH);
  } catch {
    // Fail open: profile maintenance must never break the caller.
  }
}

function maybeCreateFixTask(entry) {
  if (entry.seen < THRESHOLD || entry.fixTask) {
    return;
  }

  const title = `LESSON RECURRED x${entry.seen} — build a durable fix: ${entry.text.slice(0, 60)}`;
  const desc =
    `Lesson "[${entry.domain}] ${entry.text}" has recurred ${entry.seen} times (last ${entry.last}, src ${entry.src}). ` +
    'Per the proactivity rule this is now a systems bug: design a durable programmatic fix (hook/gate/code), ' +
    `not another reminder. Source archive: ${dirname(PROFILE_PATH)}/`;

  try {
    const output = execFileSync(
      'cortextos',
      ['bus', 'create-task', title, '--desc', desc, '--assignee', 'larry', '--priority', 'high', '--project', 'lessons-loop'],
      { encoding: 'utf8' },
    );
    const taskId = String(output || '').trim();
    if (taskId) {
      entry.fixTask = taskId;
    }
  } catch {
    // Fail open: no marker means the next recurrence retries the task create.
  }
}

function upsertLesson(input) {
  try {
    const domain = sanitizeDomain(input?.domain);
    const text = String(input?.text || '').trim();
    if (!text) {
      return null;
    }

    const src = basename(String(input?.source || 'manual'));
    const exact = normalizeExact(text);
    const tokens = normalizeTokens(text);
    const today = todayIso();
    const entries = readProfile();

    let match = null;
    let bestScore = 0;

    for (const entry of entries) {
      if (normalizeExact(entry.text) === exact) {
        match = entry;
        break;
      }

      const score = jaccardSimilarity(tokens, normalizeTokens(entry.text));
      if (score >= 0.6 && score > bestScore) {
        bestScore = score;
        match = entry;
      }
    }

    if (match) {
      match.seen += 1;
      match.last = today;
      maybeCreateFixTask(match);
    } else {
      entries.push({
        domain,
        text,
        seen: 1,
        last: today,
        src,
      });
    }

    writeProfile(entries);
    return match || entries[entries.length - 1] || null;
  } catch {
    return null;
  }
}

function topLessons(n = 20) {
  const entries = readProfile();
  if (entries.length === 0) {
    return '';
  }

  const limit = Number.isInteger(n) && n > 0 ? n : 20;
  return [...entries]
    .sort(compareNewestFirst)
    .slice(0, limit)
    .map((entry) => `- [${entry.domain}] ${entry.text} (seen ${entry.seen}×)`)
    .join('\n');
}

if (require.main === module) {
  const [cmd, domain, text, source] = process.argv.slice(2);
  if (cmd === 'add') {
    upsertLesson({ domain, text, source: source || 'manual' });
    process.stdout.write('ok\n');
  } else if (cmd === 'top') {
    const output = topLessons(Number(domain) || 20);
    process.stdout.write(output ? `${output}\n` : '');
  }
}

module.exports = { upsertLesson, topLessons, readProfile, PROFILE_PATH };
