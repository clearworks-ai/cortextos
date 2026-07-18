# Spec 01 — inject-echo-fix (execute verbatim)

**Repo:** `/Users/joshweiss/code/cortextos`
**Constraints:** TypeScript strict, no `any`, no `console.log`, minimal diff, do not touch unrelated code. All line numbers verified 2026-07-17 on branch `fix/fleet-bus-daemon-bugfixes`.

The exact marker string used throughout (copy byte-for-byte, em dash U+2014):

```
[NEW MESSAGE — respond to THIS now:]
```

---

## Change 1 — `src/telegram/logging.ts` (`buildRecentHistory`, line 218)

### 1a. Replace the corrupted duplicate doc comment (lines 204-217)

Lines 204-211 contain a corrupted docblock with pasted ulimit output (`cputime unlimited` / `filesize unlimited` / ...), followed by the real docblock at 212-217. Replace the WHOLE range 204-217 with one clean docblock:

```ts
/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 *
 * `excludeText`: when set, the single NEWEST inbound entry whose text
 * matches (control-chars stripped, trimmed) is dropped — used to keep the
 * just-arrived message (already logged before injection) out of the
 * history block so the agent never reads the live message as an echo.
 */
```

### 1b. New signature (lines 218-223)

```ts
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
  excludeText?: string,
): string | null {
```

(Optional param after the defaulted param is valid TS; all existing call sites — `agent-manager.ts:726` and the vi.mock in `tests/unit/daemon/sage-drop-regression.test.ts:113` — remain compatible.)

### 1c. Tag entries as inbound (lines 229-252)

Extend the local interface and `readLines` helper. `stripControlChars` is already imported at line 12 — no new imports.

Line 229, replace:
```ts
  interface Entry { ts: string; speaker: string; text: string; }
```
with:
```ts
  interface Entry { ts: string; speaker: string; text: string; inbound: boolean; }
```

Line 232, replace the helper signature:
```ts
  const readLines = (filePath: string, speaker: string) => {
```
with:
```ts
  const readLines = (filePath: string, speaker: string, inbound: boolean) => {
```

Line 245, replace:
```ts
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
```
with:
```ts
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text, inbound });
```

Lines 251-252, replace the two calls:
```ts
  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user', true);
  readLines(outboundPath, agentName, false);
```

### 1d. Exclusion logic (between sort and slice)

Current lines 254-257:
```ts
  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = entries.slice(-limit);
```

Replace with:
```ts
  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Drop the single newest inbound entry matching the current message —
  // it is already logged before injection and must not double as history.
  if (excludeText !== undefined) {
    const target = stripControlChars(excludeText).trim();
    if (target.length > 0) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].inbound && stripControlChars(entries[i].text).trim() === target) {
          entries.splice(i, 1);
          break;
        }
      }
    }
  }
  if (entries.length === 0) return null;

  const recent = entries.slice(-limit);
```

Nothing else in the function changes (lines 259-265 untouched).

---

## Change 2 — `src/daemon/fast-checker.ts` (`formatTelegramTextMessage`, line 440)

Only the return template changes. Current lines 476-480:

```ts
    return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
```

Replace with (adds ONE constant label line before the body; `wrapFenceSafe`, slash-command handling at lines 472-475, and all sanitization are untouched):

```ts
    return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) ===
${replyCx}${historyCx}[NEW MESSAGE — respond to THIS now:]
${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
```

The marker is emitted unconditionally (with or without history/reply context). Do NOT modify `formatTelegramPhotoMessage`, `formatTelegramReaction`, `formatInboxMessage`, or any other formatter.

---

## Change 3 — `src/daemon/agent-manager.ts` (caller, line 726)

Current:
```ts
        const recentHistory = buildRecentHistory(this.ctxRoot, name, effectiveChatId, 6) ?? undefined;
```

Replace with:
```ts
        const recentHistory = buildRecentHistory(this.ctxRoot, name, effectiveChatId, 6, text) ?? undefined;
```

(`text` is the `stripControlChars(msg.text || '')` value from line 723 — the exact body that will be injected.) The media fallback paths at lines 679/716 pass no history today; do not change them.

---

## Change 4 — Tests

### 4a. `tests/unit/telegram/logging.test.ts` — new describe block

Add `buildRecentHistory` to the import list at lines 5-11. Append a new `describe('buildRecentHistory', ...)` inside the top-level `describe('Telegram Logging', ...)`. Use the existing `testDir` tmpdir harness. Helper writes JSONL directly:

```ts
  describe('buildRecentHistory', () => {
    const writeJsonl = (file: string, rows: object[]) => {
      const dir = join(testDir, 'logs', 'frank2');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    };

    it('excludes the current inbound message when excludeText is passed', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: '77', text: 'older question', timestamp: '2026-07-17T10:00:00Z' },
        { chat_id: '77', text: 'live new ask', timestamp: '2026-07-17T10:05:00Z' },
      ]);
      writeJsonl('outbound-messages.jsonl', [
        { chat_id: '77', text: 'my reply', timestamp: '2026-07-17T10:01:00Z' },
      ]);

      const result = buildRecentHistory(testDir, 'frank2', '77', 6, 'live new ask');
      expect(result).not.toBeNull();
      expect(result).not.toContain('live new ask');
      expect(result).toContain('older question');
      expect(result).toContain('my reply');
    });

    it('drops only the newest inbound match — older duplicate text survives', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: '77', text: 'same text', timestamp: '2026-07-17T10:00:00Z' },
        { chat_id: '77', text: 'same text', timestamp: '2026-07-17T10:05:00Z' },
      ]);

      const result = buildRecentHistory(testDir, 'frank2', '77', 6, 'same text');
      expect(result).not.toBeNull();
      // Exactly one occurrence remains (the older one).
      expect(result!.split('same text').length - 1).toBe(1);
    });

    it('does not drop outbound entries matching excludeText', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: '77', text: 'ping', timestamp: '2026-07-17T10:05:00Z' },
      ]);
      writeJsonl('outbound-messages.jsonl', [
        { chat_id: '77', text: 'ping', timestamp: '2026-07-17T10:06:00Z' },
      ]);

      const result = buildRecentHistory(testDir, 'frank2', '77', 6, 'ping');
      // The inbound 'ping' is dropped; the outbound 'ping' remains.
      expect(result).not.toBeNull();
      expect(result!.split('ping').length - 1).toBe(1);
    });

    it('returns null when exclusion empties the history', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: '77', text: 'only message', timestamp: '2026-07-17T10:05:00Z' },
      ]);

      const result = buildRecentHistory(testDir, 'frank2', '77', 6, 'only message');
      expect(result).toBeNull();
    });

    it('behavior unchanged when no excludeText is passed', () => {
      writeJsonl('inbound-messages.jsonl', [
        { chat_id: '77', text: 'older question', timestamp: '2026-07-17T10:00:00Z' },
        { chat_id: '77', text: 'live new ask', timestamp: '2026-07-17T10:05:00Z' },
      ]);

      const result = buildRecentHistory(testDir, 'frank2', '77', 6);
      expect(result).toContain('older question');
      expect(result).toContain('live new ask');
    });
  });
```

### 4b. `tests/unit/daemon/fast-checker.test.ts` — extend existing describe (line 589)

Append inside `describe('formatTelegramTextMessage', ...)` (before its closing brace at line 654):

```ts
    it('labels the body with the NEW MESSAGE marker', () => {
      const result = FastChecker.formatTelegramTextMessage('alice', '999', 'Hello there', '/opt/cortextos');
      expect(result).toContain('[NEW MESSAGE — respond to THIS now:]');
      // Marker precedes the body text.
      expect(result.indexOf('[NEW MESSAGE — respond to THIS now:]'))
        .toBeLessThan(result.indexOf('Hello there'));
    });

    it('marker sits between recent-history block and the body', () => {
      const result = FastChecker.formatTelegramTextMessage(
        'alice',
        '999',
        'live new ask',
        '/opt/cortextos',
        undefined,
        undefined,
        '[alice]: older question\n[frank2]: my reply',
      );
      const historyIdx = result.indexOf('[Recent conversation:]');
      const markerIdx = result.indexOf('[NEW MESSAGE — respond to THIS now:]');
      const bodyIdx = result.indexOf('live new ask');
      expect(historyIdx).toBeGreaterThanOrEqual(0);
      expect(markerIdx).toBeGreaterThan(historyIdx);
      expect(bodyIdx).toBeGreaterThan(markerIdx);
    });

    it('marker precedes slash-command bodies without fencing them', () => {
      const result = FastChecker.formatTelegramTextMessage('alice', '999', '/restart', '/opt/cortextos');
      const markerIdx = result.indexOf('[NEW MESSAGE — respond to THIS now:]');
      const bodyIdx = result.indexOf('/restart');
      expect(markerIdx).toBeGreaterThanOrEqual(0);
      expect(bodyIdx).toBeGreaterThan(markerIdx);
      expect(result).not.toContain('```\n/restart');
    });
```

Existing 5 tests in that describe (lines 590-653) must pass UNMODIFIED.

### 4c. Do not touch

`tests/unit/daemon/sage-drop-regression.test.ts` — its mocks (`formatTelegramTextMessage() { return ''; }` at line 62, `buildRecentHistory: () => null` at line 113) remain signature-compatible; leave as-is.

---

## Verification gates

1. `npm run build` — clean strict compile.
2. `npm test` — full suite green; zero modifications to existing test assertions.
3. `grep -n "console.log\|: any" ` on the three changed src files — no hits introduced.

## Out of scope

Media formatters, reaction formatter, inbox (bus) message formatter, dedup logic (`isDuplicate`), conversation-buffer, any file not listed above.
