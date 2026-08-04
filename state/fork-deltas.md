# Fork deltas — upstream dependencies we are living without

Tracks, per MASTER-BUILD-PLAN.md `P3 · Multica task rail` item 3.0c, the fallback decision for
upstream PRs the Multica pilot names as external dependencies it explicitly does NOT wait for.
Plan's fallback rule: "cherry-pick the PR branch onto our fork if it stalls >2 weeks after pilot
start, or live with the wart (each is an annoyance, not a data-loss bug)."

## 2026-08-03 — initial decision: live with all 3 warts

| Upstream PR (grandamenium/cortextos) | Title | State (checked 2026-08-03) | Wart if left unmerged |
|---|---|---|---|
| [#762](https://github.com/grandamenium/cortextos/pull/762) | fix(bus/daemon): ack-path defects — reply_to send-time ack, dual-dir ackInbox, DEFERRED_CONFIRM with payload attribution | OPEN | ack-path defects — annoyance, not data loss per the plan's own framing |
| [#772](https://github.com/grandamenium/cortextos/pull/772) | fix(bus): a locked inbox must never look like an empty one | OPEN | a locked inbox can appear empty — annoyance, not data loss |
| [#816](https://github.com/grandamenium/cortextos/pull/816) | fix(cli): list-tasks renders full ids + supports --project filter | OPEN | truncated task ids / no --project filter in list-tasks output — annoyance, not data loss |

**Decision:** live with all 3 warts. The Multica pilot has not formally started yet — the 3.1
cron (`cortextos bus multica-sync`, spec at
`.agent/one-big-feature/multica-task-bridge/03-specs/04-cron.md`) is still waiting on Josh's own
manual dry-run → `--direction out` → `--direction in` round-trip confirmation before it is
scheduled. The plan's own ">2 weeks after pilot start" cherry-pick trigger has therefore not
started counting for any of the 3 PRs.

**Re-evaluate:** re-check each PR's state once the pilot formally starts (the 10-min cron is
scheduled and running); if any of the 3 is still OPEN more than 2 weeks after that start date,
cherry-pick that PR's branch onto our fork per the plan's fallback rule rather than continuing to
wait on upstream.
