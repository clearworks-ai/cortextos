import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Phase 1 goal statement (PHASES.md): "The phase branch must be independently
// mergeable and must not change any existing runtime behavior." This suite is
// the mechanical proof of that claim. It is pure source-text assertion — it
// has no production contract of its own. If any scan below fails, the fix is
// to go back and correct the leaking Phase 1 task (1.1-1.5), never to loosen
// these assertions.

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

describe('Task 1.6: lifecycle isolation gate', () => {
  it('scan 1: no file under src/ outside src/daemon/lifecycle/ imports src/daemon/lifecycle/*', () => {
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
      const text = readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(text)) !== null) {
        const lineNumber = text.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(REPO_ROOT, file)}:${lineNumber} -> "${match[1]}"`);
      }
    }

    expect(
      offenders,
      `Found import(s) of src/daemon/lifecycle/* outside the allowed tree:\n${offenders.join('\n')}`,
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
