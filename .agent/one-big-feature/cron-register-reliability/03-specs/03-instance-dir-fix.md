# Spec 03 — Instance-dir split guard + orphan cleanup (Scope B: FP3)

## Problem
CLI and daemon can resolve DIFFERENT instances. `src/utils/env.ts:39-49` resolves
instanceId as: overrides → `process.env.CTX_INSTANCE_ID` → `.cortextos-env` file →
`resolveActiveInstance('default')`. A shell/agent carrying a stale `CTX_INSTANCE_ID=default`
writes crons.json under `~/.cortextos/default/...` (`src/bus/crons.ts:42-45`,
`CTX_ROOT ?? process.cwd()`) AND signals the `default` socket → ENOENT → historically
swallowed. Field proof: 13 orphaned `~/.cortextos/default/.cortextOS/state/agents/*/crons.json`
(auditmaster's last fire 2026-06-29). Marker `~/.cortextos/state/ACTIVE_INSTANCE` currently
reads `cortextos1`.

## Scope boundary (deliberate)
NARROW fix: detect-and-refuse + doctor visibility + orphan cleanup. Do NOT refactor instance
resolution itself (shared resolver, env-file migration, removing the `process.cwd()` fallback)
— that is a candidate full-M2C1 follow-up; leave a `// TODO(instance-unification)` pointer.

## Changes

### 1. Mismatch guard in cron commands (`src/cli/bus.ts`)
New helper near `ensureCtxRootEnv` (bus.ts:159):
```ts
function warnOnInstanceMismatch(env: ReturnType<typeof resolveEnv>): void
```
Logic: `const marker = resolveActiveInstance('');` (import from
`src/utils/resolve-active-instance.ts`). If `marker && marker !== env.instanceId`, print a
loud stderr warning naming both ids and the crons.json path about to be written. If
`CTX_STRICT_INSTANCE=1` (or `--strict-instance` global option), exit 1 instead of warning.
Call it in `add-cron`, `remove-cron`, `update-cron`, `enable/disable-cron` actions right after
`ensureCtxRootEnv(env)` (bus.ts:3565, 3608, and the update/enable sites).

Why warn-not-fail by default: dev/test workflows legitimately target `default` when the marker
is absent or when a default-instance daemon is running; the predicate is
"marker exists AND differs", never "id === 'default'". Note: with Spec 02 landed, the
wrong-socket case ALREADY exits 1 at verify time — this guard just makes the cause legible
("wrong instance" vs "daemon down").

### 2. Doctor check (`src/cli/doctor.ts`)
New check `orphan-instances`: enumerate `~/.cortextos/*/` instance dirs; for each dir that is
NOT the active instance and has NO live daemon socket, count
`.cortextOS/state/agents/*/crons.json` files with `enabled:true` crons. Report:
`INSTANCE ORPHANS: <n> crons.json under dead instance '<id>' — these will NEVER fire. Active instance: '<marker>'.`
Non-zero orphans → doctor WARN (not fail).

### 3. One-time orphan cleanup (operational, scripted in the PR)
Archive (pending Josh decision archive-vs-delete; archive recommended):
`mkdir -p ~/.cortextos/default/.archived-2026-07 && mv ~/.cortextos/default/.cortextOS ~/.cortextos/default/.archived-2026-07/`
Before archiving, diff each orphan crons.json against the live
`~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json` and list any cron that
exists ONLY in the orphan — those are lost registrations to re-add via `bus add-cron` (which
now verifies). Emit that list in the PR description. Do not blind-merge.

## Edge cases
- Marker missing/corrupt: `resolveActiveInstance` never throws, returns fallback — guard is a
  no-op (no marker → nothing to mismatch against).
- Daemon's own process (CTX_ROOT already set by daemon): `ensureCtxRootEnv` no-ops; guard
  compares instanceId not ctxRoot, still correct.
- `crons.ts` `process.cwd()` fallback (no CTX_ROOT at all): out of narrow scope, but the
  guard's warning prints the resolved path, which makes this visible when it happens.

## Tests that prove it
- Unit: mismatch predicate — (marker='cortextos1', env='default') → warn/strict-exit;
  (marker missing) → silent; (marker==env) → silent.
- Doctor: fixture home dir with a dead `default` instance containing 2 enabled crons →
  doctor output contains `INSTANCE ORPHANS: 2`.
- Manual proof for PR: run `add-cron` with `CTX_INSTANCE_ID=default CTX_STRICT_INSTANCE=1`
  on this machine → exit 1 naming cortextos1 as active.
