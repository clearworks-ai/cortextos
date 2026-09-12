import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Phase 1 goal statement (PHASES.md): "The phase branch must be independently
// mergeable and must not change any existing runtime behavior." Scan 1 below
// was the mechanical proof of that claim FOR PHASE 1 (Tasks 1.1-1.5): zero
// wiring into any existing call site. Phase 1's own regression (Task 1.R)
// froze that as "no file under src/ outside src/daemon/lifecycle/ imports
// src/daemon/lifecycle/*", full stop.
//
// Phase 2's explicit mandate (PHASES.md Task 2.2) is the opposite of Phase
// 1's: "make the existing mechanisms submit observations or requests to it."
// Task 2.2 wires `src/daemon/agent-process.ts` and `src/bus/system.ts` to
// `src/daemon/lifecycle/legacy-compat.ts` on purpose — that is the task's
// entire contract (fresh-start intent as an identified request, replacing
// the old read-then-unlink `.force-fresh` handling). A bare "zero imports,
// ever" gate would make Phase 2 impossible to pass, not a regression to fix
// backward.
//
// So scan 1 now allowlists ONLY the exact {file, module} pairs Task 2.2
// deliberately introduced, and still fails on anything else — including a
// DIFFERENT module under `daemon/lifecycle/*` (e.g. `supervisor.ts` or
// `state-store.ts` directly) reaching one of these two files, which remains
// unauthorized until a later task's contract says otherwise. This keeps the
// gate meaningful as a "no undocumented/accidental leak" proof rather than
// retiring it outright.
//
// NOTE: `src/daemon/agent-process.ts` also now imports from
// `./lifecycle/legacy-compat.js` and `./lifecycle/types.js` (Task 2.2), but
// those specifiers never match this scan's regex at all — the regex looks
// for the literal substring `daemon/lifecycle`, and a file already inside
// `src/daemon/` reaches its sibling `lifecycle/` directory via the shorter
// relative specifier `./lifecycle/...`, which contains no `daemon/` segment.
// Only `src/bus/system.ts` (outside `src/daemon/`) needs an explicit
// allowlist entry below, since its relative specifier is
// `../daemon/lifecycle/legacy-compat.js`.
const PHASE_2_APPROVED_WIRING: ReadonlyArray<{ file: string; moduleSuffix: string }> = [
  { file: join('src', 'bus', 'system.ts'), moduleSuffix: 'daemon/lifecycle/legacy-compat.js' },
];

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const LIFECYCLE_DIR_REL = join('daemon', 'lifecycle'); // relative to src/

/** Recursively collect every .ts/.tsx file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('Task 1.6 / 2.2: lifecycle isolation gate', () => {
  it('scan 1: no file under src/ outside src/daemon/lifecycle/ imports src/daemon/lifecycle/*, except the Task 2.2-approved wiring', () => {
    const allSrcFiles = collectSourceFiles(SRC_ROOT);

    const candidateFiles = allSrcFiles.filter((f) => {
      const rel = relative(SRC_ROOT, f);
      return !rel.startsWith(LIFECYCLE_DIR_REL + '/') && rel !== LIFECYCLE_DIR_REL;
    });

    // Matches both static (`import ... from '...'`) and dynamic
    // (`import('...')`) specifiers, plus `require('...')` for safety (atomic.ts
    // itself contains one lazy `require('fs')` call, proving `require` calls do
    // appear in this codebase even under an ESM build). Any specifier that
    // *contains* `daemon/lifecycle` is flagged, so both relative forms
    // (`../daemon/lifecycle/...`, `./lifecycle/...` from within `src/daemon/`)
    // and any absolute/alias form are caught. tsconfig.json declares no `paths`
    // aliases, so only relative-specifier forms are actually reachable today.
    const importRegex = /(?:from\s+|import\(|require\()\s*['"]([^'"]*daemon\/lifecycle[^'"]*)['"]/g;

    const offenders: string[] = [];
    for (const file of candidateFiles) {
      const relFile = relative(REPO_ROOT, file);
      const text = readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(text)) !== null) {
        const spec = match[1];
        const isApproved = PHASE_2_APPROVED_WIRING.some(
          (entry) => entry.file === relFile && spec.endsWith(entry.moduleSuffix),
        );
        if (isApproved) continue;
        const lineNumber = text.slice(0, match.index).split('\n').length;
        offenders.push(`${relFile}:${lineNumber} -> "${spec}"`);
      }
    }

    expect(
      offenders,
      `Found import(s) of src/daemon/lifecycle/* outside the allowed tree (or beyond the Task 2.2-approved wiring):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('scan 2: src/utils/lock.ts exports are unchanged', () => {
    const lockSrc = readFileSync(join(SRC_ROOT, 'utils', 'lock.ts'), 'utf-8');

    const requiredSignatures = [
      'export function acquireLock(dir: string): boolean {',
      'export function releaseLock(dir: string): void {',
      'export interface FileLockOptions {',
      'export function withFileLockSync<T>(',
      'export async function withFileLockAsync<T>(',
    ];

    const missing = requiredSignatures.filter((sig) => !lockSrc.includes(sig));

    expect(
      missing,
      `src/utils/lock.ts is missing expected unchanged signature(s):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('scan 3: atomicWriteSync signature in src/utils/atomic.ts is unchanged', () => {
    const atomicSrc = readFileSync(join(SRC_ROOT, 'utils', 'atomic.ts'), 'utf-8');

    const requiredSignature =
      'export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {';

    expect(
      atomicSrc.includes(requiredSignature),
      `src/utils/atomic.ts's atomicWriteSync signature has changed. Expected to find:\n${requiredSignature}`,
    ).toBe(true);
  });
});
