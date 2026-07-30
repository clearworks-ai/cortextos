# Spec 03 — Re-add #131 Part B: `--kind comms` fail-closed source-key guard (NO auto-send)

> **STATUS: DONE / SHIPPED on `main` via commit `eccdd62`**
> ("feat(bus): re-add --source-key dedup with fail-closed --kind comms").
> The Part B guard described below is live on main:
> - `type BusSendKind = 'default' | 'comms'` + `parseKind` (`src/cli/bus.ts:351,353`);
> - `--kind comms` fail-closed block on `send-message` (`kind === 'comms'` at
>   `src/cli/bus.ts:431`, with the missing/invalid/`CTX_ROOT` errors at ~433/437/441);
> - `--kind comms` fail-closed block on `send-telegram` (~`src/cli/bus.ts:1776`, errors
>   at ~1782/1786);
> - `const sourceDedupEnabled = kind === 'comms' || opts.dedup !== false;` (~`:1791`);
> - both contract tests `tests/unit/cli/send-message-source-key.test.ts` and
>   `tests/unit/cli/send-telegram-source-key.test.ts` present on main.
> Part A (`comms-filter --surface` auto-send) is correctly ABSENT — stays dead.
>
> **PR #159 (branch `feat/comms-meeting-dedup`) is STALE / SUPERSEDED.** That branch is
> ~20 commits behind main and 4 ahead, `mergeable: CONFLICTING` / `mergeStateStatus:
> DIRTY`. Because the fail-closed guard already exists on the main base, `gh pr diff 159`
> no longer shows the Part B `bus.ts` hunks as net-new — the diff is now dominated by
> unrelated drift (other workstreams' planning docs, knowledge files, agent state). PR
> #159 should be CLOSED (superseded by `eccdd62`), not rebased/merged. Spec retained
> below as the authoritative provenance record of the shipped Part B contract.

**Slug:** comms-meeting-dedup
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature
**Plan engine:** Fable 5 HIGH (daytime run-lock)
**Author:** larry (2026-07-25)
**Josh decision (2026-07-25 Telegram):** re-add the dedup guard; he did NOT accept the
dupe/resend tradeoff (the revert commit's "accepted the tradeoff" line was auto-generated
and wrong).

## Context / why

PR #131 (`c7b5952`) had two parts. The revert `c441a09` (#145) removed **both**:
- **Part A** — `bus comms-filter --surface` deterministic auto-send that fired unfiltered
  `[EMAIL]` to Telegram on first-seen. **Josh killed this on purpose. DO NOT re-add. Stays dead.**
- **Part B** — `--kind comms` fail-closed guard on `send-telegram` / `send-message`: a
  comms send MUST carry a valid `--source-key`, so it can no longer bypass the shared
  `comms-event-dedup` ledger. **Removing this is the dupe-resurface regression.** Re-add THIS ONLY.

The `--source-key` option and its `checkAndRecordSourceEvent` dedup mechanism already exist
on main (bus.ts ~367-445 for send-message, ~1697+ for send-telegram) and are UNCHANGED —
they currently fail **open** (source-key optional). This spec makes comms sends fail **closed**.

## Source of truth for the exact code

Re-apply the **Part B hunks** from commit `c7b5952` verbatim, adapted to current main line
numbers. Authoritative diff: `git show c7b5952 -- src/cli/bus.ts`. Take ONLY the hunks that:
- add `type BusSendKind = 'default' | 'comms'` + the `parseKind` helper that throws on any
  value other than `'comms'` (`Error: --kind must be 'comms' when set, got '<x>'.`);
- add the `--kind <kind>` option to BOTH `send-message` and `send-telegram`;
- add the fail-closed block `if (kind === 'comms') { ... }` in BOTH commands, which errors
  (non-zero exit) when: source-key missing, source-key invalid, or CTX_ROOT absent — exact
  messages from the diff (`... requires --source-key`, `... requires a valid --source-key`,
  `... requires CTX_ROOT so source-event dedup can be enforced.`);
- set `sourceDedupEnabled = kind === 'comms' || opts.dedup !== false` so `--kind comms`
  keeps source-event dedup active even under `--no-dedup`, and ignores `--streaming` bypass
  for comms.

**Explicitly EXCLUDE** every hunk touching `comms-filter`, `--surface`,
`renderCommsSurfaceMessage`, or any auto-fetch/auto-send path. If a hunk mixes both, take
only the `--kind`/fail-closed lines.

## Tests to restore (verbatim from c7b5952, they define the contract)

- `tests/unit/cli/send-telegram-source-key.test.ts` — incl. `--kind comms requires a source key`,
  `--kind comms keeps source-event dedup active even with --no-dedup`, replay-dedup, ttl,
  rollback-on-send-failure, invalid-key-fail-open (non-comms), no-dedup-bypass (non-comms).
- `tests/unit/cli/send-message-source-key.test.ts` — incl. `--kind comms rejects sends without
  a source key`, suppress-duplicate-on-bus-path, no-source-key-both-deliver (non-comms regression).

Restore via `git show c7b5952:<path>`. Adapt imports/paths only if the current tree moved them.

## Out of scope (do NOT touch)

- `bus comms-filter` command (leave at current pre-#131 plain-dedup, no `--surface`).
- `renderCommsSurfaceMessage` / any Telegram auto-send.
- `src/utils/meeting-alert-gate.ts` (#109) — already live and correct, unrelated.

## Acceptance

1. `send-telegram --kind comms` and `send-message --kind comms` exit non-zero with the exact
   error when `--source-key` is missing/invalid or CTX_ROOT is unset.
2. Without `--kind comms`, behavior is unchanged from current main (fail-open).
3. No `comms-filter --surface` / auto-send path anywhere in the diff.
4. Both restored test files pass; full `npm test` green; `npm run build` clean.
5. `git grep -nE "renderCommsSurfaceMessage|comms-filter.*surface"` in the diff = none.
