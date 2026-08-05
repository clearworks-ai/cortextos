# Upstream-divergence deep pass: src/daemon/conversation-buffer.ts

**File status vs upstream/main:** FORK-ONLY. Does not exist upstream (`git cat-file -e upstream/main:src/daemon/conversation-buffer.ts` → does not exist). Entire 172-line file is fork divergence; whole file read, not skimmed.

## History
| SHA | Date | What |
|---|---|---|
| `d0ebbe4` | 2026-05-16 | Created file — PR #7 "Larry UX parity — streaming + rolling buffer + defer restart + tool visibility". All of `appendToBuffer` (L88-116), `readBufferEntries` (L56-71), path resolution. |
| `7705b0c` | 2026-07-29 | `loadBuffer` split into verbatim last-5 + compressed digest (L118-172), to shrink boot-prompt reinsertion cost. |

## What it does
Rolling per-agent JSONL of Josh↔agent Telegram exchanges at `${ctxRoot}/state/${agent}/conversation-buffer.jsonl`, capped at 20 entries; overflow rotated into an append-only `conversation-buffer-archive.jsonl`. Consumers:
- **Writer:** `src/cli/bus.ts:2066` — `appendToBuffer` after every successful `bus send-telegram` (short-lived CLI process, outbound only).
- **Readers (in-daemon):** `src/daemon/agent-process.ts:1022,1046` — builds the post-restart "MISSION ANCHOR + VERBATIM LIVE TAIL" resume blocks and the back-ping suppression check; `src/daemon/restart-context.ts:58` — derives the restart mission from the trailing inbound message.

## Divergence-by-divergence analysis

### 1. `appendToBuffer` rotation — non-atomic, lockless read-modify-write (L94-115)
Introduced `d0ebbe4` 2026-05-16. Sequence: `appendFileSync(buffer)` → read ALL entries → `appendFileSync(archive)` → `writeFileSync(buffer)` (plain overwrite, **not** temp+rename — violates the repo's own atomic-write rule, `src/utils/atomic.ts`).
- Crash/kill between archive-append (L109) and buffer-rewrite (L112) → excess entries duplicated in both files; next rotation re-archives them → archive duplication.
- Two concurrent senders (agent firing multiple sends, or CLI + cron worker) race the read-modify-write with no lock → lost or duplicated buffer entries. Lost tail entries corrupt the restart mission anchor / live tail — this feeds the fleet's known "stale anchor on resume" problem, but it does NOT crash or wedge any process.
- **Classification: NEUTRAL-FEATURE (with a data-integrity hygiene bug, not process instability).**

### 2. Blanket `catch {}` error swallowing (L113-115, L152-154)
Introduced `d0ebbe4` 2026-05-16. Intentional fail-open ("buffer failures must never block the Telegram send"). Pathological edge: if `appendFileSync(archive)` (L109) throws persistently (disk-full, perms), the catch aborts BEFORE the buffer rewrite (L112), so the buffer never trims → **silent unbounded growth of conversation-buffer.jsonl**, and every subsequent append re-reads the whole growing file. Realistic only under sustained FS failure, at which point the whole fleet is already dying (matches the known host-resource-exhaustion overnight-death mode as a *victim*, not a cause).
- **Classification: NEUTRAL-FEATURE / minor error-masking. Not a wedge, not a leak under normal FS.**

### 3. Append-only archive with no cap or pruning (L46, L109)
Introduced `d0ebbe4` 2026-05-16. `conversation-buffer-archive.jsonl` grows forever by design. This file never reads it back, but `src/cli/bus.ts:141-148` (`loadConversationHistory`) reads the ENTIRE archive into memory on each use — slow drift, months-scale. Disk/memory growth is linear and tiny per message; not a plausible contributor to overnight posix_spawnp exhaustion.
- **Classification: NEUTRAL-FEATURE (unbounded-growth footnote; the risky reader is in bus.ts, not here).**

### 4. `loadBuffer` verbatim/digest split (L118-155, L157-172)
Introduced `7705b0c` 2026-07-29. Pure read-side shaping (last-5 verbatim, rest digested to 120-char lines) to cut boot-prompt size. Sync reads of a ≤20-entry file at restart time only. No timers, no processes, no awaits, no state that can wedge.
- **Classification: BAND-AID-ADJACENT.** It exists to make the fork's frequent-restart resume cheaper — infrastructure that only matters because agents restart constantly. It compensates for restart churn; it does not cause anything.

## Explicitly checked and ABSENT from this file
No child processes, no PTY interaction, no timers/intervals, no async/await (all sync FS in short-lived or restart-time paths), no status assertions, no orphan/reparent surface, no IPC. It cannot spawn, leak, or wedge a process.

## Verdict
**NOT part of the ROOT WOUND.** This file is a NEUTRAL-FEATURE overall — fork-only Telegram conversation persistence with two hygiene defects (non-atomic lockless rotation, fail-open catch that can un-cap the buffer under FS failure), neither of which produces process instability, resource exhaustion, or the alive-but-loop-dead state. Its read side (`loadBuffer` → restart-context.ts / agent-process.ts resume blocks, and the `7705b0c` digest optimization) is **support infrastructure for the fork's restart band-aid ecosystem**: it exists because agents restart constantly, and its lossy/racy write path is one reason the resume anchor can be stale (see MEMORY "mission anchor is stale retrieval").

**Oldest instability-relevant hunk:** the non-atomic rotation + catch-all in `appendToBuffer`, `d0ebbe4` 2026-05-16 — data-integrity risk only, not a daemon-stability root cause. Root-wound hunting should stay on agent-process.ts / pty-host / fast-checker; this file is exonerated.
