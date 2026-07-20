# DoorDash SDLC Retro v3 — TRUE Source Map (the sources v2 missed)

**Why v3:** v2 swarm read git + recent conversation buffers only. It did NOT read the archived Apr/May/Jun full transcripts (moved to archive folders during the 2026-07-02 cleanup). Josh caught it. v3 re-reads the REAL primary sources below and corrects the retro.

## PRIMARY full-transcript archives (the depth v2 lacked)
1. **Apr 19–22 build days** — `/Users/joshweiss/.claude/projects/-Users-joshweiss-code-cortextos-orgs-clearworksai-agents-larry.archived-1777684406/*.jsonl.archived` (3 files, ~10.7M; DoorDash hits in `56dfa0f1-...` = 222).
2. **May 26 – Jun 25 build days** — `/Users/joshweiss/.claude/projects/-Users-joshweiss-code-cortextos-orgs-clearworksai-agents-larry/_archived-2026-06-25-loop/*.jsonl` (**186 files** — the biggest untouched source). THE prize.

## SECONDARY (distilled + supporting)
3. **knowledge-sync cleanup quarantine** — `/Users/joshweiss/code/knowledge-sync/_quarantine-2026-07-02/` — 4 DoorDash/521 session notes:
   - `cc/sessions/2026-05-06_doordash_doc-classification-ocr.md`
   - `cc/sessions/2026-05-07_doordash_wiring-fix-ocg-extraction.md`
   - `cc/sessions/2026-06-17_larry_doordash-tier3-ocg-relink.md`
   - `raw/sessions/sessions/2026-05-04_521doordash_infra-migration.md`
   (only 4 matched doordash/521 — widen grep past filenames when reading)
4. **doordash-linker repo** — `~/code/doordash-linker` — 271 commits, first `2026-04-22 Initial commit: Phase 1 complete`, last `2026-07-19`. Full build history incl. the Apr23–May25 transcript gap.
5. **Rolling buffer archives** (shallower, cross-ref only, NOT full depth per frank2): `~/.cortextos/cortextos1/state/{larry,frank2,muse,crm}/conversation-buffer-archive.jsonl`.

## GAP (open — asked Josh)
**Apr 23 – May 25**: no transcript archive found (live dir starts Jun 23; archives cover Apr19-22 + May26-Jun25). Possible: pre-larry-rename agent name (maven/maverick?) or different repo path. FALLBACK: reconstruct from doordash-linker git history + PRs for that window. Awaiting Josh + frank2 confirm.

## v3 method (no compression — Josh's explicit correction)
Each source read for a DATED timeline of: scope-changes, unpriced discoveries, pain points, decisions — verbatim quotes + timestamps, NOT vibe-summaries. Then synthesize + patch the v2 retro (proposal→build→delivery lifecycle) with what the real transcripts actually show vs what v2 inferred.
