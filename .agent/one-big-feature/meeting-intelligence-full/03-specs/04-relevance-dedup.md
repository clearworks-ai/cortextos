# Spec 04 — §4.4 Relevance + dedup: port the amanaiproduct mechanics

**Repo:** `/Users/joshweiss/code/cortextos`
**Status this run:** materialized, NOT dispatched. Depends on spec 02 (client_context feeds relevance scoring).

**Source (verbatim, Google Doc §4.4):** "Fuzzy dedup replacing exact-hash, across the open backlog. Relevance score vs client_context. 4-tier priority with hard caps: P0 (max 3) surfaced immediately, P1 (max 7) daily digest, P2/P3 backlog, never pushed. Tie goes to DROP."

Also referenced with more mechanical detail earlier in the Doc's architecture diagram (§4, verbatim): "Fuzzy dedup: 0.7*title_sim + 0.3*keyword_overlap >= 0.6 / Relevance score vs client_context / 4-tier priority, P0 cap 3, drop-bias on ties."

And priority tier definitions from §3.4 of the Doc (verbatim, referenced as "same repo" — i.e. the same tiering convention used elsewhere in this design): "P0 Immediate action (max 3) | P1 Weekly focus (max 7) | P2 Scheduled items (unlimited) | P3 Someday/maybe (unlimited)."

## Verified live

- Current extractor's `refine_items` function (`ff-extractor.py:716`) is the existing item-refinement/filter stage — this is where the Doc's §5 build step 4 says to add relevance drop-bias + P0 cap: "Add relevance drop-bias + P0 cap 3 in refine_items (:716): score against context, surface top-3, backlog the rest. ~40 lines."
- Current dedup in the commitments path is exact-hash / deterministic-id based (`meeting-commitments-worker/SKILL.md` Step 4: dedup key is the extractor's deterministic `id`). The Doc's fuzzy-dedup requirement (0.7×title_sim + 0.3×keyword_overlap >= 0.6) is NEW — it does not exist today. Note: a *different*, already-shipped fuzzy/normalization dedup exists for Telegram meeting-REMINDER notifications (`src/utils/meeting-alert-gate.ts`, PR from `comms-meeting-dedup` slug — see that repo's `.agent/one-big-feature/comms-meeting-dedup/`), but that is a different problem (dedup of notification EMAILS about one meeting) from this piece (dedup of extracted ACTION ITEMS/commitments across the open backlog). Do not conflate — confirm with a fresh grep of `refine_items` before assuming any overlap exists.

## Build

1. **Fuzzy dedup** in `refine_items` (`ff-extractor.py:716`): replace/augment exact-hash dedup with `0.7*title_sim + 0.3*keyword_overlap >= 0.6` similarity scoring across the OPEN backlog (not just the current batch) — needs access to already-surfaced/open items, likely via the existing `state/meeting-commitments-surfaced.txt` ledger or the `knowledge/clients/*.md` Open Items tables (spec 02's output).
2. **Relevance score vs client_context**: score each extracted item against spec 02's `client_context` output.
3. **4-tier priority with hard caps**: P0 (max 3, surfaced immediately), P1 (max 7, daily digest), P2/P3 (unlimited, backlog, never pushed). Tie-break rule: DROP (explicit, verbatim — "Tie goes to DROP" / "drop-bias on ties").

## Dependencies

Blocked on spec 02 (client_context required for relevance scoring). Also interacts with spec 05 (drafting) since P0/P1 tiering determines what surfaces to Telegram vs daily digest vs backlog-only.

## Test plan

- Fuzzy dedup: table test — near-duplicate titles/keywords score >= 0.6 and collapse; genuinely distinct items score below threshold and both surface.
- Priority tiers: hard-cap enforcement (P0 never exceeds 3 items in a single surface, P1 never exceeds 7); tie-break always drops rather than over-surfacing.
- Regression: confirm existing exact-hash dedup callers (if any remain outside `refine_items`) still function or are explicitly migrated.
