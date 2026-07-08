import { writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 *
 * Crash-safety ordering:
 *   1. writeFileSync(tmp)        — new content fully on disk
 *   2. copyFileSync(primary→bak) — best-effort; primary is still the old version
 *   3. renameSync(tmp→primary)   — atomic swap; primary becomes new content
 *
 * If the process dies after step 1 but before step 3: tmp is orphaned, primary
 * is untouched — no corruption and no stale .bak.
 * If the process dies after step 3: .bak == old primary, primary == new content
 * — both are consistent.
 * The previous ordering (bak BEFORE tmp write) could leave a stale .bak paired
 * with a half-written primary if the write failed mid-way.
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Step 1: Write new content to a temp file. Only after this succeeds do we
  // touch the primary or its backup, so a failure here leaves both untouched.
  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Clean up temp file if it was partially created
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  // Step 2: Best-effort backup of the current file. Runs AFTER the temp write
  // so a failure here never leaves a stale .bak paired with a half-written
  // primary — the primary has not been touched yet.
  if (keepBak && existsSync(filePath)) {
    try {
      copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  // Step 3: Atomic rename — the only moment the primary changes.
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on rename failure
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
