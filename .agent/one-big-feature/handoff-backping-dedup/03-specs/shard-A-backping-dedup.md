# Shard A — handoff back-ping dedup guard

**Repo:** ~/code/cortextos
**Verify:** `npm run build && npm test`

## Scope (verbatim, do not compress)

Add a 10-minute suppression window to the handoff "back — ..." Telegram back-ping
so fast-chaining handoff restarts stop spamming Josh with duplicate back-messages,
UNLESS a materially-new inbound message arrived since the last ping.

## File 1 (NEW): `src/daemon/handoff-backping.ts`

Pure, dependency-free decision + marker IO helpers.

```ts
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/** Suppression window for handoff back-ping re-fires. */
export const HANDOFF_BACKPING_SUPPRESS_MS = 10 * 60_000;

export interface BackPingState {
  /** epoch ms of last emitted back-ping, or null if none / unreadable. */
  lastPingMs: number | null;
  /** current time epoch ms. */
  nowMs: number;
  /** epoch ms of newest INBOUND message in the live buffer, or null. */
  newestInboundMs: number | null;
  /** suppression window in ms. */
  windowMs: number;
}

/**
 * Return true when the handoff back-ping should be SUPPRESSED (skipped).
 *  - no prior ping        -> allow (false)
 *  - window elapsed       -> allow (false)
 *  - within window AND a materially-new inbound message arrived after the last
 *    ping -> allow (false)
 *  - within window, nothing new -> suppress (true)
 */
export function shouldSuppressBackPing(s: BackPingState): boolean {
  if (s.lastPingMs === null) return false;
  if (s.nowMs - s.lastPingMs >= s.windowMs) return false;
  if (s.newestInboundMs !== null && s.newestInboundMs > s.lastPingMs) return false;
  return true;
}

function markerPath(ctxRoot: string, agent: string): string {
  return join(ctxRoot, 'state', agent, '.last-back-ping');
}

/** Read last back-ping epoch ms. Returns null when missing/unreadable/NaN. */
export function readLastBackPingMs(ctxRoot: string, agent: string): number | null {
  try {
    const p = markerPath(ctxRoot, agent);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Write the marker with the given epoch ms. Best-effort; never throws. */
export function writeLastBackPingMs(ctxRoot: string, agent: string, nowMs: number): void {
  try {
    const dir = join(ctxRoot, 'state', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(ctxRoot, agent), String(nowMs), 'utf-8');
  } catch {
    /* non-fatal: dedup marker is best-effort observability */
  }
}
```

## File 2 (EDIT): `src/daemon/agent-process.ts`

### 2a. Import the helpers (top, with the other `./` daemon imports)

```ts
import {
  HANDOFF_BACKPING_SUPPRESS_MS,
  shouldSuppressBackPing,
  readLastBackPingMs,
  writeLastBackPingMs,
} from './handoff-backping.js';
```

### 2b. Add a private helper on the class (near `buildResumeContextBlocks`)

Compute newest inbound message epoch ms from the same buffer the live tail uses.
Inbound = any entry whose `sender !== this.name` (josh or another agent).

```ts
/** epoch ms of the newest inbound (sender != self) buffer message, or null. */
private newestInboundMessageMs(): number | null {
  try {
    const entries = loadBuffer(this.env.ctxRoot, this.name);
    let newest: number | null = null;
    for (const e of entries) {
      if (e.sender === this.name) continue;
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
    return newest;
  } catch {
    return null;
  }
}

/** True when the handoff back-ping should be skipped this restart. */
private isHandoffBackPingSuppressed(): boolean {
  return shouldSuppressBackPing({
    lastPingMs: readLastBackPingMs(this.env.ctxRoot, this.name),
    nowMs: Date.now(),
    newestInboundMs: this.newestInboundMessageMs(),
    windowMs: HANDOFF_BACKPING_SUPPRESS_MS,
  });
}
```

### 2c. Gate the prompt-side emit site (`buildStartupPrompt`, L966-969)

Replace the `handoffUxOverride` guard so it also checks suppression, and record
the marker when the ping IS emitted:

```ts
const shouldPromptTelegram = this.shouldPromptTelegramOnlineMessage();
const emitHandoffBackPing =
  isHandoffRestart && shouldPromptTelegram && !this.isHandoffBackPingSuppressed();
if (emitHandoffBackPing) {
  writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now());
}
const handoffUxOverride = emitHandoffBackPing
  ? ' HANDOFF UX: ...(UNCHANGED existing string)... '
  : '';
```

Keep the existing `handoffUxOverride` string text VERBATIM — only its firing
condition changes.

### 2d. Gate the daemon-side opencode emit site (`maybeSendRuntimeLifecycleNotification`, msg2)

The msg2 back-online ping for opencode (currently inside the `if (this.lastSpawnWasHandoff)`
block, sent for opencode after msg1) must be wrapped in the same suppression
check and write the same marker when it fires. msg1 (planned-restart lifecycle)
is NOT suppressed — leave it. Only the "back — ..." msg2 opencode path gets the
guard:

```ts
// existing: if (this.lastSpawnWasHandoff) { send(msg1); ...opencode msg2... }
// opencode msg2 becomes:
if (/* runtime is opencode */ && !this.isHandoffBackPingSuppressed()) {
  writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now());
  send(/* existing opencode back-online text */);
}
```

Match the existing runtime-branch structure — do not restructure msg1 or the
codex path (codex self-sends msg2 via the prompt, already covered by 2c).

## File 3 (NEW): `tests/daemon/handoff-backping.test.ts`

Unit-test the pure `shouldSuppressBackPing` fn. Cover every branch:

```ts
import { shouldSuppressBackPing, HANDOFF_BACKPING_SUPPRESS_MS } from '../../src/daemon/handoff-backping.js';

const W = HANDOFF_BACKPING_SUPPRESS_MS;
const NOW = 1_000_000_000_000;

// 1. no prior ping -> allow
expect(shouldSuppressBackPing({ lastPingMs: null, nowMs: NOW, newestInboundMs: null, windowMs: W })).toBe(false);
// 2. window elapsed -> allow
expect(shouldSuppressBackPing({ lastPingMs: NOW - W - 1, nowMs: NOW, newestInboundMs: null, windowMs: W })).toBe(false);
// 3. within window, no new inbound -> suppress
expect(shouldSuppressBackPing({ lastPingMs: NOW - 1000, nowMs: NOW, newestInboundMs: NOW - 5000, windowMs: W })).toBe(true);
// 4. within window, new inbound after last ping -> allow
expect(shouldSuppressBackPing({ lastPingMs: NOW - 1000, nowMs: NOW, newestInboundMs: NOW - 500, windowMs: W })).toBe(false);
// 5. within window, null newest inbound -> suppress
expect(shouldSuppressBackPing({ lastPingMs: NOW - 1000, nowMs: NOW, newestInboundMs: null, windowMs: W })).toBe(true);
// 6. exact window boundary (== window) -> allow (elapsed)
expect(shouldSuppressBackPing({ lastPingMs: NOW - W, nowMs: NOW, newestInboundMs: null, windowMs: W })).toBe(false);
```

Use the repo's existing test framework/style (match a neighboring file under
`tests/daemon/`). Add a marker read/write round-trip test against a tmp dir if
the existing daemon tests already do fs-tmp setup; otherwise the pure-fn tests
are the required minimum.

## Out of scope

- msg1 planned-restart lifecycle notification (keep firing every restart).
- Telegram transport-layer byte-identical dedup (separate, already exists).
- Any change to the back-ping TEXT.

## Constraints

- TypeScript strict. No `any`, no `console.log`.
- All new fs IO best-effort (try/catch), never throws into the boot path.
- Return diff only; do NOT commit or push (larry opens the PR).
