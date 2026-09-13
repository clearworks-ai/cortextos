import {
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'fs';
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
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting.
  if (keepBak && existsSync(filePath)) {
    try {
      copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Durable atomic write: like `atomicWriteSync`, but fsyncs the temp file
 * before renaming, and best-effort fsyncs the containing directory after
 * renaming so the rename itself survives a crash.
 *
 * Opt-in primitive for callers that need crash-durable persistence (e.g. the
 * lifecycle supervisor's authority record) — `atomicWriteSync` is unchanged
 * and remains the default for callers that don't need this guarantee.
 *
 * Parent-directory fsync is best-effort: some platforms/filesystems reject
 * opening a directory for fsync (EINVAL) or reject fsync on it (EPERM/ENOSYS).
 * That failure is tolerated — logged via `console.error`, not thrown — since
 * the file's own contents and the rename are already durable at that point;
 * only the extra guarantee that the rename entry itself survives a concurrent
 * crash is at (rare) risk.
 */
export function atomicWriteDurableSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  ensureDir(dir);

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeFileSync(fd, data + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors during failure cleanup
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  // Best-effort parent-directory fsync so the rename itself survives a crash.
  // Tolerate EINVAL/EPERM/ENOSYS on platforms/filesystems that refuse directory fsync.
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    console.error(`[atomic] Parent-directory fsync failed for ${dir}:`, err);
  }
}
