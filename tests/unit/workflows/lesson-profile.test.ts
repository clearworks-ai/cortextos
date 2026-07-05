import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

type LessonEntry = {
  domain: string;
  text: string;
  seen: number;
  last: string;
  src: string;
  fixTask?: string;
};

type LessonProfileModule = {
  PROFILE_PATH: string;
  readProfile: () => LessonEntry[];
  topLessons: (n?: number) => string;
  upsertLesson: (input: { domain: string; text: string; source: string }) => LessonEntry | null;
};

const require = createRequire(import.meta.url);
const modulePath = '../../../.claude/workflows/lib/lesson-profile.js';
const header =
  '# LESSON PROFILE — canonical, machine-maintained. Do not hand-edit lines; use lesson-profile.js.\n' +
  '# Cap: 60 lines. Write path: lesson-profile.js upsert. Read path: dynamic-pipeline plan stage.\n';

let tempDir = '';
let profilePath = '';
let fakeBinDir = '';
let taskLogPath = '';
let originalPath = '';

function loadModule(): LessonProfileModule {
  process.env.LESSON_PROFILE_PATH = profilePath;
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath) as LessonProfileModule;
}

function writeProfile(lines: string[]): void {
  writeFileSync(profilePath, `${header}${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lesson-profile-'));
  profilePath = join(tempDir, 'PROFILE.md');
  fakeBinDir = join(tempDir, 'bin');
  taskLogPath = join(tempDir, 'task-log.txt');
  originalPath = process.env.PATH || '';

  const fakeCortextos = join(fakeBinDir, 'cortextos');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(
    fakeCortextos,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync } = require('node:fs');",
      "const taskId = process.env.LESSON_PROFILE_FAKE_TASK_OUTPUT || 'task_fake_123';",
      "const logPath = process.env.LESSON_PROFILE_FAKE_TASK_LOG;",
      "if (logPath) appendFileSync(logPath, process.argv.slice(2).join(' ') + '\\n');",
      "if (process.env.LESSON_PROFILE_FAKE_TASK_FAIL === '1') process.exit(1);",
      "process.stdout.write(taskId + '\\n');",
    ].join('\n'),
    'utf8',
  );
  chmodSync(fakeCortextos, 0o755);

  process.env.PATH = `${fakeBinDir}:${originalPath}`;
  process.env.LESSON_PROFILE_FAKE_TASK_LOG = taskLogPath;
  process.env.LESSON_PROFILE_FAKE_TASK_OUTPUT = 'task_lessons_001';
  delete process.env.LESSON_PROFILE_FAKE_TASK_FAIL;
});

afterEach(() => {
  delete process.env.LESSON_PROFILE_PATH;
  delete process.env.LESSON_PROFILE_FAKE_TASK_LOG;
  delete process.env.LESSON_PROFILE_FAKE_TASK_OUTPUT;
  delete process.env.LESSON_PROFILE_FAKE_TASK_FAIL;
  process.env.PATH = originalPath;
  delete require.cache[require.resolve(modulePath)];
  rmSync(tempDir, { recursive: true, force: true });
});

describe('lesson-profile', () => {
  it('increments seen for an exact duplicate without appending a new line', () => {
    const lessonProfile = loadModule();

    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'verify the built artifact before claiming done',
      source: 'verify-the-built-artifact-not-the-source.md',
    });
    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'verify the built artifact before claiming done',
      source: 'verify-the-built-artifact-not-the-source.md',
    });

    expect(lessonProfile.readProfile()).toEqual([
      expect.objectContaining({
        domain: 'pipeline',
        text: 'verify the built artifact before claiming done',
        seen: 2,
        src: 'verify-the-built-artifact-not-the-source.md',
      }),
    ]);
  });

  it('increments seen for a near duplicate by token-set Jaccard', () => {
    const lessonProfile = loadModule();

    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'verify the built artifact before claiming done',
      source: 'verify-the-built-artifact-not-the-source.md',
    });
    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'before claiming done, verify the built artifact',
      source: 'manual',
    });

    expect(lessonProfile.readProfile()).toEqual([
      expect.objectContaining({
        text: 'verify the built artifact before claiming done',
        seen: 2,
        src: 'verify-the-built-artifact-not-the-source.md',
      }),
    ]);
  });

  it('appends a distinct lesson as a new line', () => {
    const lessonProfile = loadModule();

    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'verify the built artifact before claiming done',
      source: 'verify-the-built-artifact-not-the-source.md',
    });
    lessonProfile.upsertLesson({
      domain: 'ops',
      text: 'mechanism without trigger is dead code',
      source: 'mechanism-without-trigger-is-dead-code.md',
    });

    const entries = lessonProfile.readProfile();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.text).sort()).toEqual([
      'mechanism without trigger is dead code',
      'verify the built artifact before claiming done',
    ]);
  });

  it('evicts the lowest seen and oldest line when adding the 61st lesson', () => {
    const oldEntries = ['- [ops] oldest low-priority lesson | seen:1 | last:2026-01-01 | src:oldest.md'];
    for (let i = 0; i < 59; i += 1) {
      oldEntries.push(`- [ops] durable lesson ${i} | seen:2 | last:2026-06-${String((i % 28) + 1).padStart(2, '0')} | src:lesson-${i}.md`);
    }
    writeProfile(oldEntries);

    const lessonProfile = loadModule();
    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'new distinct lesson for eviction coverage',
      source: 'new-lesson.md',
    });

    const entries = lessonProfile.readProfile();
    expect(entries).toHaveLength(60);
    expect(entries.find((entry) => entry.src === 'oldest.md')).toBeUndefined();
    expect(entries.find((entry) => entry.src === 'new-lesson.md')).toBeDefined();
  });

  it('fires create-task once at the threshold crossing and stamps the fix-task marker', () => {
    writeProfile([
      '- [pipeline] verify the built artifact before claiming done | seen:2 | last:2026-07-04 | src:verify-the-built-artifact-not-the-source.md',
    ]);
    const lessonProfile = loadModule();

    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'before claiming done, verify the built artifact',
      source: 'manual',
    });

    const entries = lessonProfile.readProfile();
    expect(entries[0]).toEqual(expect.objectContaining({ seen: 3, fixTask: 'task_lessons_001' }));
    expect(readFileSync(taskLogPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('does not re-fire create-task when the marker is already present', () => {
    writeProfile([
      '- [pipeline] verify the built artifact before claiming done | seen:3 | last:2026-07-04 | src:verify-the-built-artifact-not-the-source.md | fix-task:task_lessons_001',
    ]);
    const lessonProfile = loadModule();

    lessonProfile.upsertLesson({
      domain: 'pipeline',
      text: 'before claiming done, verify the built artifact',
      source: 'manual',
    });

    const entries = lessonProfile.readProfile();
    expect(entries[0]).toEqual(expect.objectContaining({ seen: 4, fixTask: 'task_lessons_001' }));
    expect(() => readFileSync(taskLogPath, 'utf8')).toThrow();
  });

  it('returns an empty string when the profile is missing', () => {
    const lessonProfile = loadModule();
    expect(lessonProfile.topLessons()).toBe('');
  });

  it('skips malformed lines without failing reads or writes', () => {
    writeProfile([
      '- [pipeline] valid lesson | seen:2 | last:2026-07-04 | src:valid.md',
      '- malformed line that should be ignored',
    ]);
    const lessonProfile = loadModule();

    expect(lessonProfile.topLessons()).toContain('valid lesson');
    lessonProfile.upsertLesson({
      domain: 'ops',
      text: 'new durable lesson',
      source: 'new-lesson.md',
    });

    const entries = lessonProfile.readProfile();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.text).sort()).toEqual(['new durable lesson', 'valid lesson']);
  });
});
