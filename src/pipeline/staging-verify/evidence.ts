import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { withFileLockSync } from '../../utils/lock.js';
import type { RunContext, StagingVerifyEvidence } from './types.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultEvidenceDir(): string {
  if (process.env.CTX_AGENT_DIR) {
    return resolve(process.env.CTX_AGENT_DIR, 'state', 'staging-verify');
  }
  return resolve(process.cwd(), 'state', 'staging-verify');
}

export function redact(text: string): string {
  let redacted = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL)/i.test(name)) continue;
    if (!value || value.length < 8) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), 'g'), `[REDACTED_${name}]`);
  }
  redacted = redacted.replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s'"]+/gi, '[REDACTED_DB_URL]');
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]');
  return redacted;
}

export function evidencePath(ctx: RunContext, failed = false): string {
  const dir = ctx.evidenceDir || defaultEvidenceDir();
  return resolve(dir, failed ? `${ctx.slug}.failed.json` : `${ctx.slug}.json`);
}

export function writeEvidence(ctx: RunContext, evidence: StagingVerifyEvidence): string {
  const target = evidencePath(ctx, !evidence.ok);
  const dir = dirname(target);
  const lockDir = join(dir, '.locks', 'staging-verify-evidence');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lockDir, { recursive: true });

  return withFileLockSync(lockDir, () => {
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (serialized.trim().length === 0) {
      throw new Error('Refusing to write an empty evidence file');
    }
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, serialized, 'utf-8');
    if (!existsSync(tmp) || statSync(tmp).size === 0) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw new Error('Refusing to publish an empty evidence file');
    }
    renameSync(tmp, target);
    if (statSync(target).size === 0) {
      throw new Error('Evidence file is empty after atomic rename');
    }
    return resolve(target);
  });
}

export function currentToolVersion(): string {
  try {
    const packageJson = readFileSync(resolve(__dirname, '../../..', 'package.json'), 'utf-8');
    const parsed = JSON.parse(packageJson) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
