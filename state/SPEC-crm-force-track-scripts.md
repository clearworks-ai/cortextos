# SPEC — crm-force-track-scripts (close the unreviewable-PR class)

> **Purpose:** Make crm's production scripts reviewable in git so a PR like #305 — 8 files / 2196 lines / **zero deletions** / no prior history — can never again hide an incomplete wire-up. Pick this up cold and execute mechanically.
> **Format:** every step is `ACTION` (exact command / exact edit) → `VERIFY` (exact command + expected output) → `DONE-WHEN`.
> **Dispatch:** OBF (`one-big-feature`). **Slug = `crm-force-track-scripts`. Branch name MUST equal the slug exactly, no `fix/` or `feat/` prefix** (`slugFromBranch()` in the PR gate derives from the branch name). PR goes to `--repo clearworks-ai/cortextos`.
> **Authored:** 2026-08-04. Every path/line/command below was confirmed by running it at authoring time; outputs are pasted inline.

---

## 0. PROBLEM STATEMENT (evidence — do not re-derive)

**PR#305** (merged 2026-08-04 18:15 UTC, merge commit `44ee3920`, "feat(crm): keyless enrichment + records-admin event triggers"):

```
$ git show --stat 44ee3920 --format=""
 orgs/clearworksai/agents/crm/crm/comms-backfill.py     | 169 +++++++
 orgs/clearworksai/agents/crm/crm/crm_connect_common.py | 520 +++++++++++++++++++++
 orgs/clearworksai/agents/crm/crm/enrich-contact.py     | 303 ++++++++++++
 orgs/clearworksai/agents/crm/crm/reconcile-intake.py   | 334 +++++++++++++
 orgs/clearworksai/agents/crm/crm/sync-board.py         | 237 ++++++++++
 orgs/clearworksai/agents/crm/crm/test_crm_events.py    | 160 +++++++
 orgs/clearworksai/agents/crm/crm/test_enrich_contact.py| 208 +++++++++
 orgs/clearworksai/agents/crm/crm/upsert-contact.py     | 265 +++++++++++
 8 files changed, 2196 insertions(+)
```

**8 files, 2196 lines, 100% insertions, 0 deletions** — the first time any of those files ever touched git. `git log --all --diff-filter=A -- .../upsert-contact.py` returns only `44ee3920` / `d9cb5c83` (the same PR). Every file appeared to a reviewer as "new file", so the diff could not show that the change **failed to wire into the callers and tests that depend on it**.

Two production bugs shipped inside that blind spot:

| Bug | What PR#305 added | What it never updated | Live symptom |
|---|---|---|---|
| **#317** | `--match-email` / `find_contact_by_email()` in `upsert-contact.py` | `calendar-backfill.py` + `comms-backfill.py` still passed `--id <slug>`, which short-circuits the email lookup | every backfill re-mints duplicate contacts (Mark Lurie → `mark-lurie` + `markmsiaorg` + `mark`) |
| **#318** | 4 event-emit fns behind a `CRM_EVENT_EMIT_LOG` test-safety seam | the seam was never wired into the existing test setup | every fleet test run leaks real `EVENT crm.*` bus messages into crm's live inbox |

**Root cause (the class, not the symptoms):** crm's scripts are gitignored, so they enter git only via `git add -f`, with no history. `.gitignore` **line 17**:

```
$ grep -n "orgs/clearworksai" .gitignore
16:!orgs/clearworksai/
17:orgs/clearworksai/*          <-- blanket ignore, catches agents/ and everything under it
18:!orgs/clearworksai/secrets.env.example
19:!orgs/clearworksai/skills/
20:!orgs/clearworksai/skills/**
```

```
$ git check-ignore -v orgs/clearworksai/agents/crm/crm/query.py
.gitignore:17:orgs/clearworksai/*	orgs/clearworksai/agents/crm/crm/query.py
```

Existing negation exceptions today: **only** `secrets.env.example` (line 18) and `skills/**` (lines 19-20). **There is no negation for `agents/` at all** — every tracked agent script (frank2's, larry's, crm's 11) got there by `git add -f`.

`test_upsert_contact.py` is **still untracked** and has never appeared in any PR.

---

## 1. FILE INVENTORY — `orgs/clearworksai/agents/crm/crm/` (the only crm script dir)

There is no `crm/scripts/` dir. All production scripts live flat in `orgs/clearworksai/agents/crm/crm/`.

```
$ for f in orgs/clearworksai/agents/crm/crm/*.py; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo TRACKED || echo UNTRACKED; done
```

| # | File | Tracked? | Bytes | mtime | Purpose (from file header) |
|---|---|---|---|---|---|
| 1 | `add-followup.py` | **UNTRACKED** | 2059 | 2026-05-20 10:07 | Append an open follow-up to `crm/followups.jsonl` |
| 2 | `add-interaction.py` | **UNTRACKED** | 1934 | 2026-05-20 10:07 | Append an interaction to the local CRM interaction log |
| 3 | `build-company-gmail-feed.py` | **UNTRACKED** | 7065 | 2026-06-12 17:21 | Build per-company Gmail feed from contacts/interactions |
| 4 | `build-company-timeline-feed.py` | **UNTRACKED** | 2740 | 2026-06-12 17:18 | Build per-company timeline feed |
| 5 | `calendar-backfill.py` | **UNTRACKED** | 7951 | 2026-06-03 10:05 | Heartbeat-piggyback calendar backfill; upserts external attendees as contacts — **direct caller of upsert-contact.py (bug #317)** |
| 6 | `comms-backfill.py` | TRACKED | 7190 | 2026-08-04 13:47 | Gmail SENT/RECEIVED backfill → contacts + interactions; emits `email.captured` |
| 7 | `crm_connect_common.py` | TRACKED | 17457 | 2026-08-04 13:47 | Shared CRM path/IO helpers + `emit_crm_event()` / `CRM_EVENT_EMIT_LOG` seam |
| 8 | `enrich-contact.py` | TRACKED | 12403 | 2026-08-04 13:47 | Keyless contact enrichment (+ optional Firecrawl/PDL adapters) |
| 9 | `fireflies-ingest.py` | **UNTRACKED** | 3590 | 2026-05-27 10:05 | Fireflies ingest helper — overlap window + idempotent dedupe — **HARDCODED LIVE API KEY, see §2** |
| 10 | `handle-ops-check-lead.py` | **UNTRACKED** | 7960 | 2026-07-28 15:02 | Translate an ops-check webhook payload into the CRM upsert flow |
| 11 | `interactions-to-notes.py` | TRACKED | 10256 | 2026-07-30 23:56 | Render CRM interactions into notes |
| 12 | `log-telegram.py` | **UNTRACKED** | 5194 | 2026-06-01 11:21 | Telegram ↔ CRM bridge (frank2 calls it on external-contact messages) |
| 13 | `query.py` | **UNTRACKED** | 1429 | 2026-05-12 15:15 | Search the local agentic CRM |
| 14 | `reconcile-intake.py` | TRACKED | 11474 | 2026-08-04 13:47 | Intake reconciliation; emits `deal.created` |
| 15 | `scan-stale-deals.py` | **UNTRACKED** | 5962 | 2026-05-16 02:02 | Scan `pipeline.json` for enrichment-eligible stale engagements |
| 16 | `scan-stale-relationships.py` | **UNTRACKED** | 7560 | 2026-06-27 12:34 | Canonical contact-based stale-sweep (distinct from scan-stale-deals) |
| 17 | `sync-board.py` | TRACKED | 8223 | 2026-08-04 13:47 | Board↔CRM deal sync; emits `deal.stage_changed` |
| 18 | `test_build_company_gmail_feed.py` | **UNTRACKED** | 5566 | 2026-06-12 17:18 | tests for #3 — **real client emails in fixtures, see §2** |
| 19 | `test_build_company_timeline_feed.py` | **UNTRACKED** | 6084 | 2026-06-12 17:18 | tests for #4 — **real client emails in fixtures, see §2** |
| 20 | `test_crm_events.py` | TRACKED | 7333 | 2026-08-04 13:47 | tests the 4 event emits via the seam |
| 21 | `test_enrich_contact.py` | TRACKED | 9727 | 2026-08-04 13:47 | tests keyless enrichment + spend gate |
| 22 | `test_handle_ops_check_lead.py` | **UNTRACKED** | 5680 | 2026-07-28 15:02 | tests for #10 (example.com fixtures — clean) |
| 23 | `test_interactions_to_notes.py` | TRACKED | 7121 | 2026-07-30 23:56 | tests for #11 |
| 24 | `test_reconcile_intake.py` | **UNTRACKED** | 8961 | 2026-06-12 17:18 | tests for #14 — **real client email in fixture, see §2** |
| 25 | `test_sync_board.py` | **UNTRACKED** | 11629 | 2026-06-28 20:54 | tests for #17 (fake token `abc123`, `briefs.example` — clean) |
| 26 | `test_upsert_contact.py` | **UNTRACKED** | 2754 | 2026-07-28 15:02 | tests for #27 — **the file that would have caught bug #318; never in any PR** |
| 27 | `upsert-contact.py` | TRACKED | 9175 | 2026-08-04 13:47 | Canonical contact writer; `--match-email` / `find_contact_by_email()`; emits `contact.created` |
| 28 | `upsert-engagement.py` | **UNTRACKED** | 3864 | 2026-06-28 21:01 | Canonical writer for `pipeline.json` mutations (stage_history audit) |
| 29 | `zoom-officehours-recap.py` | **UNTRACKED** | 8261 | 2026-07-23 11:49 | AIA Office Hours recap engine — **HARDCODED LIVE API KEY, see §2** |
| 30 | `zoom-officehours-sync.py` | **UNTRACKED** | 13175 | 2026-07-31 00:43 | AIA Office Hours Zoom lead sync — **hardcoded org identifiers, see §2** |

**Totals: 30 python files — 11 TRACKED, 19 UNTRACKED.**

### 1b. Where the records-admin event emitters actually live

```
$ grep -rl "CRM_EVENT_EMIT" orgs/clearworksai/
orgs/clearworksai/agents/crm/crm/comms-backfill.py
orgs/clearworksai/agents/crm/crm/upsert-contact.py
orgs/clearworksai/agents/crm/crm/test_crm_events.py
orgs/clearworksai/agents/crm/crm/sync-board.py
orgs/clearworksai/agents/crm/crm/crm_connect_common.py
```

All five are **already tracked**. The records-administrator event lane does **not** live under larry or in a skill dir — it is entirely inside crm's own scripts. No cross-agent tracking work is needed. (The `records-administrator` SKILL.md itself is under the already-negated `orgs/clearworksai/skills/**` path.)

### 1c. Precedent — how codexer force-tracked `calendar-backfill.py`

```
$ git log --oneline --all -- '*calendar-backfill.py'
2cc8df59 fix(crm): stop backfills passing --id to upsert-contact.py; use --match-email (dedup)

$ git branch -a --contains 2cc8df59
  crm-dupe-contact-fix
  remotes/origin/crm-dupe-contact-fix

$ git show --stat 2cc8df59 --format=""
 .../agents/crm/crm/calendar-backfill.py         | 202 +++++++++++++++++++++
 orgs/clearworksai/agents/crm/crm/comms-backfill.py |  12 +-
 .../agents/crm/crm/test_backfill_match_email.py | 110 +++++++++++
 3 files changed, 320 insertions(+), 4 deletions(-)

$ git diff main...crm-dupe-contact-fix -- .gitignore
(only an unrelated `leakage-fixture.json` block; NO agents/ negation)
```

**Mechanism used: plain `git add -f`, no `.gitignore` negation.** Note `calendar-backfill.py` shows as `202 +++` — i.e. codexer's own fix branch *also* reproduces the "new file, all-adds" unreviewable shape. That is the exact pattern this spec exists to end. This spec uses `git add -f` as the primary mechanism (§5, matching precedent) **and** adds a negation ladder (§6) because `add -f` alone does not stop the *next* new file from silently escaping review.

---

## 2. SECRETS / PII RISK — READ BEFORE TOUCHING ANYTHING

**The target repo is PUBLIC.**

```
$ gh repo view clearworks-ai/cortextos --json isPrivate,isFork,visibility
{"isFork":true,"isPrivate":false,"visibility":"PUBLIC","parent":{...grandamenium/cortextos}}
```

Anything tracked here is world-readable the moment it is pushed. **7 of the 19 untracked files need remediation before they can be tracked.**

### 2a. BLOCKERS — live credential in source (2 files)

| File:line | Content | Action required |
|---|---|---|
| `fireflies-ingest.py:30` | `API_KEY = "d94fc828-d4df-4bbd-baae-43cb18ba0ef1"  # reference_fireflies_api` | **Extract to `FIREFLIES_API_KEY` env.** Cannot be tracked as-is. |
| `zoom-officehours-recap.py:37` | `API_KEY = "d94fc828-d4df-4bbd-baae-43cb18ba0ef1"  # reference_fireflies_api (frank2/.env)` | Same key, second copy. Same extraction. |

This is a **live Fireflies API key committed in plaintext twice**. Because the key is a bare UUID it does **not** match `SECRET_RE` in `.github/scripts/leak-guard.sh` (line ~44: `sk-ant-…|sbp_…|<botid>:AA…|AIza…|apify_api_…`) — **CI would not have stopped it.** Do not rely on leak-guard here; the extraction is manual and gated.

### 2b. PII / org-identifier exposure (5 files)

| File:line | Content | Action required |
|---|---|---|
| `calendar-backfill.py:25-26` | `JOSH_DOMAINS = {"clearworks.ai","logictcg.com"}` / `JOSH_EMAILS = {"josh@clearworks.ai","josh@logictcg.com","weissjosh0@gmail.com"}` | Personal Gmail in a public repo. Move to env (`CRM_SELF_EMAILS`) or accept — **needs Josh's call** (see §10). |
| `zoom-officehours-sync.py:38-39,45` | `MEETING_ID = "84893116740"` / `MAILCHIMP_LIST_ID = "6e5ba0b9c3"` / `NOISE_EMAILS = {"fred@fireflies.ai"}` | Not credentials, but a live Zoom meeting id + Mailchimp list id. Move both to env (`ZOOM_OFFICEHOURS_MEETING_ID`, `MAILCHIMP_LIST_ID` — the Zoom OAuth creds in this file already read from `os.environ`, so the pattern is established in-file). |
| `test_build_company_gmail_feed.py:59,65,88,96,104` | real client emails `mpo@owenscg.com`, `rickwang@owenscg.com` | Anonymize fixtures to `example.com`. |
| `test_build_company_timeline_feed.py:72,78` | `mpo@owenscg.com`, `tgo@owenscg.com` | Anonymize fixtures. |
| `test_reconcile_intake.py:82` | `mpo@owenscg.com` | Anonymize fixture. |

### 2c. Clean — track as-is (12 files)

`add-followup.py`, `add-interaction.py`, `build-company-gmail-feed.py`, `build-company-timeline-feed.py`, `handle-ops-check-lead.py`, `log-telegram.py`, `query.py`, `scan-stale-deals.py`, `scan-stale-relationships.py`, `test_handle_ops_check_lead.py`, `test_sync_board.py`, `test_upsert_contact.py`, `upsert-engagement.py`
(scanned for `api[_-]key|token|secret|password|bearer|sk-|xox|ghp_|AKIA|BEGIN`, emails, hostnames, and `/Users/` paths — no hits beyond `example.com` / `briefs.example` / fake `token="abc123"`).

### 2d. Already-leaked by PR#305 (informational — do not "fix" here)

`comms-backfill.py:10` contains `/Users/joshweiss/…` and `josh@clearworks.ai` at lines 30/47/114, and is already public. leak-guard's `OPERATOR_USERS='cortextos'` (line ~33) does not match `joshweiss`, so it passed. Log it; remediating already-public content is a separate task.

---

## 3. STEP 1 — SECRETS EXTRACTION (GATED — nothing else runs until this is green)

```
[ ] 1a. ACTION: Edit orgs/clearworksai/agents/crm/crm/fireflies-ingest.py — replace line 30
        API_KEY = "d94fc828-d4df-4bbd-baae-43cb18ba0ef1"  # reference_fireflies_api
    with
        API_KEY = os.environ["FIREFLIES_API_KEY"]
    (add `import os` if absent). Confirm FIREFLIES_API_KEY is present in orgs/clearworksai/secrets.env
    and in the crm agent's env; if missing, add it there FIRST (secrets.env is gitignored — verify with
    `git check-ignore -v orgs/clearworksai/secrets.env`).
    → VERIFY: grep -n "d94fc828" orgs/clearworksai/agents/crm/crm/fireflies-ingest.py  → NO output.
              python3 -c "import ast,sys; ast.parse(open('orgs/clearworksai/agents/crm/crm/fireflies-ingest.py').read())" → exit 0.
    → DONE-WHEN: zero occurrences of the literal key AND the script still runs
              (`cd orgs/clearworksai/agents/crm/crm && FIREFLIES_API_KEY=$FIREFLIES_API_KEY python3 fireflies-ingest.py --help` exits 0).

[ ] 1b. ACTION: Same edit at orgs/clearworksai/agents/crm/crm/zoom-officehours-recap.py line 37.
    → VERIFY: grep -rn "d94fc828" orgs/clearworksai/agents/crm/crm/ → NO output (both copies gone).
    → DONE-WHEN: repo-wide grep for the literal key returns nothing:
              grep -rn "d94fc828-d4df-4bbd-baae-43cb18ba0ef1" /Users/joshweiss/code/cortextos/ → no matches.

[ ] 1c. ACTION: ROTATE the Fireflies API key. It has been sitting in plaintext on disk and is
        referenced from frank2/.env as well. Rotate in the Fireflies console, update
        orgs/clearworksai/secrets.env + any agent .env that carries it, restart crm + frank2.
    → VERIFY: `cortextos bus list-agents` shows crm+frank2 running; run fireflies-ingest.py once and
              confirm a 200 (non-401) response.
    → DONE-WHEN: new key works AND the old key is revoked. **If Josh declines rotation, record his
              explicit decision in this file and proceed — but the extraction (1a/1b) is NOT optional.**

[ ] 1d. ACTION: Edit zoom-officehours-sync.py lines 38-39 —
        MEETING_ID = os.environ.get("ZOOM_OFFICEHOURS_MEETING_ID", "")
        MAILCHIMP_LIST_ID = os.environ.get("MAILCHIMP_LIST_ID", "")
        and fail fast with a clear error if either is empty. Add both to orgs/clearworksai/secrets.env.
    → VERIFY: grep -nE '"84893116740"|"6e5ba0b9c3"' orgs/clearworksai/agents/crm/crm/zoom-officehours-sync.py → NO output.
    → DONE-WHEN: script `--help` exits 0 and a dry run with the env vars set behaves identically.

[ ] 1e. ACTION: Anonymize test fixtures — replace every `@owenscg.com` address with an `@example.com`
        equivalent (keep the local-parts distinct so the tests still exercise distinct contacts) in:
          test_build_company_gmail_feed.py (lines 59,65,88,96,104)
          test_build_company_timeline_feed.py (lines 72,78)
          test_reconcile_intake.py (line 82)
    → VERIFY: grep -rn "owenscg\|msia.org" orgs/clearworksai/agents/crm/crm/*.py → NO output.
              cd orgs/clearworksai/agents/crm/crm && python3 -m pytest -q → all pass (see §7 for the
              CRM_EVENT_EMIT_LOG env you must set so the run does not spam the live bus).
    → DONE-WHEN: no real client domains remain in any file to be tracked AND the python suite is green.

[ ] 1f. ACTION (decision gate, calendar-backfill.py:25-26): apply Josh's answer from §10-Q2 —
        either move JOSH_DOMAINS/JOSH_EMAILS to `CRM_SELF_DOMAINS` / `CRM_SELF_EMAILS` env
        (comma-split, defaults empty) or record an explicit "accept, keep inline" decision here.
    → VERIFY: whichever path — `grep -n "weissjosh0@gmail.com" calendar-backfill.py` matches the decision.
    → DONE-WHEN: the decision is written into this file with a timestamp.

[ ] 1g. GATE — FULL RE-SCAN before any git add:
    ACTION:
      cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm
      grep -nEi "(api[_-]?key|token|secret|password|bearer|sk-[A-Za-z0-9]|xox[baprs]-|ghp_|AKIA|-----BEGIN)[[:space:]]*=[[:space:]]*[\"'][^\"']{8,}" *.py
      grep -nEo "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" *.py | grep -v "example\.\|clearworks.ai" | sort -u
      grep -rn "/Users/" *.py
    → VERIFY: first grep = no output; second grep = no real third-party domain; third grep = no output
              (comms-backfill.py:10 is pre-existing/already-public — note it, do not let a NEW one in).
    → DONE-WHEN: all three clean. **DO NOT PROCEED TO §4 UNTIL THIS STEP IS GREEN.**
```

---

## 4. STEP 2 — BRANCH + OBF SETUP

```
[ ] 2a. ACTION: create an ISOLATED WORKTREE (mandated — shared-checkout branch-hopping has wiped
        receipts 4+ times this week):
          cd /Users/joshweiss/code/cortextos
          git worktree add ../ctx-crm-force-track-scripts -b crm-force-track-scripts origin/main
    → VERIFY: git -C ../ctx-crm-force-track-scripts rev-parse --abbrev-ref HEAD → `crm-force-track-scripts`
    → DONE-WHEN: branch name is EXACTLY the slug, no prefix (PR gate `slugFromBranch()` depends on it).

[ ] 2b. ACTION: create the OBF planning dir .agent/one-big-feature/crm-force-track-scripts/
        with 01-research.md (a FILE, not a dir), 02-plan.md, and specs/ — then emit the pipeline
        stages per the OBF gotchas (plan mtime MUST be >= research mtime; scope-sha hashes the
        specs/ DIRECTORY, not one file).
    → VERIFY: cortextos pipeline-stage-emit --verify --slug crm-force-track-scripts → rows present, no NO_ROWS.
    → DONE-WHEN: research + plan rows signed in state/pipeline-ledger.jsonl.
```

---

## 5. STEP 3 — `git add -f` PER FILE (matches the calendar-backfill.py precedent)

Run from the worktree root. **19 files, one command each so a failure is isolated and resumable.**

```
[ ] 3a. cd ../ctx-crm-force-track-scripts && P=orgs/clearworksai/agents/crm/crm

[ ] 3b. git add -f $P/add-followup.py
[ ] 3c. git add -f $P/add-interaction.py
[ ] 3d. git add -f $P/build-company-gmail-feed.py
[ ] 3e. git add -f $P/build-company-timeline-feed.py
[ ] 3f. git add -f $P/calendar-backfill.py
[ ] 3g. git add -f $P/fireflies-ingest.py            # ONLY after §3 step 1a+1g green
[ ] 3h. git add -f $P/handle-ops-check-lead.py
[ ] 3i. git add -f $P/log-telegram.py
[ ] 3j. git add -f $P/query.py
[ ] 3k. git add -f $P/scan-stale-deals.py
[ ] 3l. git add -f $P/scan-stale-relationships.py
[ ] 3m. git add -f $P/test_build_company_gmail_feed.py
[ ] 3n. git add -f $P/test_build_company_timeline_feed.py
[ ] 3o. git add -f $P/test_handle_ops_check_lead.py
[ ] 3p. git add -f $P/test_reconcile_intake.py
[ ] 3q. git add -f $P/test_sync_board.py
[ ] 3r. git add -f $P/test_upsert_contact.py
[ ] 3s. git add -f $P/upsert-engagement.py
[ ] 3t. git add -f $P/zoom-officehours-recap.py      # ONLY after §3 step 1b+1g green
[ ] 3u. git add -f $P/zoom-officehours-sync.py       # ONLY after §3 step 1d+1g green

[ ] 3v. VERIFY: git diff --cached --name-only | wc -l  → 19
        git diff --cached --stat | tail -1             → ~19 files changed, ~6800 insertions(+)
        git diff --cached -- '*fireflies*' | grep -c "d94fc828"  → 0
    → DONE-WHEN: exactly 19 paths staged, zero credential literals in the staged diff.
```

**Do NOT `git add -f` any of:** `contacts.json`, `interactions.jsonl`, `followups.jsonl`, `pipeline.json`, any `*.bak*`, `.env`, `feeds/`, `meetings/`, `drafts/`, `proposals/`, `__pycache__/`, `.pytest_cache/`. Those are runtime data and stay ignored. Confirm with `git diff --cached --name-only | grep -vE '\.py$'` → must be **empty** (except `.gitignore` after §6).

---

## 6. STEP 4 — `.gitignore` NEGATION LADDER (stops FUTURE files escaping review)

`git add -f` fixes the 19 files that exist today. It does **not** stop file #31 from being created next month, staying invisible in `git status`, and shipping as another all-adds PR. The negation ladder does.

**Git semantics constraint (verified):** you cannot re-include a file whose parent directory is excluded. `.gitignore:17` excludes the `agents/` directory itself, so a single `!orgs/clearworksai/agents/crm/crm/*.py` line **does not work**. The full ladder is required.

**ACTION — append these EXACT lines to the end of `/Users/joshweiss/code/cortextos/.gitignore`:**

```
# crm production scripts are REVIEWABLE (2026-08-04, PR#305 postmortem).
# orgs/clearworksai/* (line 17) blanket-ignores this tree, so force-adds produced
# zero-history "new file" diffs and an incomplete wire-up shipped unreviewed twice
# (bugs #317 dupe-contacts, #318 test-event leak). Git cannot re-include a file whose
# parent dir is excluded, so each level must be re-included then re-excluded in turn.
# Only *.py is un-ignored — contacts.json / interactions.jsonl / .env / feeds/ stay ignored.
!orgs/clearworksai/agents/
orgs/clearworksai/agents/*
!orgs/clearworksai/agents/crm/
orgs/clearworksai/agents/crm/*
!orgs/clearworksai/agents/crm/crm/
orgs/clearworksai/agents/crm/crm/*
!orgs/clearworksai/agents/crm/crm/*.py
orgs/clearworksai/agents/crm/crm/__pycache__/
```

**Proof this ladder behaves (run in a scratch repo at authoring time):**

```
orgs/clearworksai/agents/crm/crm/query.py         NOT-IGNORED (trackable)   ✅
orgs/clearworksai/agents/crm/crm/contacts.json    IGNORED                   ✅
orgs/clearworksai/agents/crm/crm/.env             IGNORED                   ✅
orgs/clearworksai/agents/crm/config.json          IGNORED                   ✅
```

```
[ ] 4a. ACTION: append the block above verbatim to .gitignore.
    → VERIFY: git check-ignore -v orgs/clearworksai/agents/crm/crm/query.py            → NO output (not ignored)
              git check-ignore -v orgs/clearworksai/agents/crm/crm/contacts.json       → matches .gitignore:<ladder line>
              git check-ignore -v orgs/clearworksai/agents/crm/crm/.env                → still ignored
              git check-ignore -v orgs/clearworksai/agents/crm/config.json             → still ignored
              git check-ignore -v orgs/clearworksai/agents/frank2/config.json          → still ignored (ladder is crm-only)
    → DONE-WHEN: all five expectations hold.

[ ] 4b. ACTION: git add .gitignore ; git status --short
    → VERIFY: `git status --short` shows NO remaining `??` entries under
              orgs/clearworksai/agents/crm/crm/*.py  (every .py is now either staged or tracked)
    → DONE-WHEN: zero untracked .py in that dir. THIS is the durable property — a new script
              now appears in `git status` instead of silently vanishing.
```

---

## 7. STEP 5 — PROVE EACH FILE NOW PRODUCES A REAL DIFF ON EDIT

A force-added file *does* diff normally once tracked — but prove it mechanically rather than asserting it.

```
[ ] 5a. ACTION: git commit -m "chore(crm): force-track 19 production scripts + .gitignore negation so crm changes are reviewable (PR#305 postmortem)"

[ ] 5b. ACTION (diff proof loop — touch, diff, revert, for every newly tracked file):
      cd ../ctx-crm-force-track-scripts/orgs/clearworksai/agents/crm/crm
      fail=0
      for f in add-followup.py add-interaction.py build-company-gmail-feed.py \
               build-company-timeline-feed.py calendar-backfill.py fireflies-ingest.py \
               handle-ops-check-lead.py log-telegram.py query.py scan-stale-deals.py \
               scan-stale-relationships.py test_build_company_gmail_feed.py \
               test_build_company_timeline_feed.py test_handle_ops_check_lead.py \
               test_reconcile_intake.py test_sync_board.py test_upsert_contact.py \
               upsert-engagement.py zoom-officehours-recap.py zoom-officehours-sync.py; do
        printf '# diffprobe\n' >> "$f"
        n=$(git diff --numstat -- "$f" | awk '{print $1}')
        [ "$n" = "1" ] && echo "OK   $f" || { echo "FAIL $f (numstat=$n)"; fail=1; }
        git checkout -- "$f"
      done
      exit $fail
    → VERIFY: 20 lines of `OK <file>` (19 new + spot-check), zero `FAIL`, and
              `git status --short` clean afterwards.
    → DONE-WHEN: every file produces exactly 1 added line in `git diff` — i.e. real review is now possible.

[ ] 5c. ACTION (python suite must stay green AND must not touch the live bus):
      cd ../ctx-crm-force-track-scripts/orgs/clearworksai/agents/crm/crm
      CRM_EVENT_EMIT_LOG=$(mktemp) python3 -m pytest -q
    → VERIFY: all tests pass; then `cortextos bus inbox crm | head` shows NO new `EVENT crm.*` messages
              with a timestamp inside the test window.
    → DONE-WHEN: green suite + zero bus leakage. (Bug #318 itself is fixed on branch
              `crm-emit-event-test-guard` / commit 913e1f38 — OUT OF SCOPE here, see §8.)

[ ] 5d. ACTION: npm run build && npm test (repo TS suite; the pre-push hook runs these anyway).
    → VERIFY: both exit 0.
    → DONE-WHEN: clean. (Confirmed no coupling: `npm test` = `vitest run && node --test tests/clearpath-dump/...`;
              there is no root pytest.ini/pyproject.toml, so newly-tracked python is NOT collected by CI.)
```

---

## 8. STEP 6 — THE GUARD (so this class cannot recur)

**Name:** `.github/scripts/untracked-agent-script-guard.sh`
**Wired into:** a new step in the existing `.github/workflows/leak-guard.yml` job (same checkout, same `fetch-depth: 0`, same `pull_request` trigger — do NOT create a new workflow; leak-guard.yml is already positioned to become a required check on main) **and** into `scripts/hooks/pre-push` (installed by `scripts/setup-hooks.sh`) for local fast-fail.

**What it must assert (two independent checks):**

1. **No un-ignored crm script is untracked.** For every `orgs/clearworksai/agents/crm/crm/*.py` on disk that `git check-ignore -q` says is NOT ignored, `git ls-files --error-unmatch` must succeed. A new script that the ladder un-ignores but nobody added = **FAIL**, with the message "new crm production script `<path>` is untracked — `git add -f` it so the change is reviewable (PR#305 postmortem)".
2. **No all-adds first-appearance for a crm production script in a PR.** For each file in `git diff --name-only --diff-filter=A "$base"...HEAD` matching `orgs/clearworksai/agents/crm/crm/.*\.py$`, check `git log --oneline "$base" -- <path>` — if empty (the file has no history on the base branch) **and** the PR contains no corresponding modification to an existing caller/test, emit a **warning-with-required-acknowledgement**: the PR body must contain the literal line `NEW-UNTRACKED-SCRIPT-ACK: <path>` or the check fails. This forces the author to state, in the PR, that a zero-history file is entering the repo — which is exactly the signal PR#305's reviewer never got.

**Additionally extend `.github/scripts/leak-guard.sh`** (it will now be scanning these files on `--tree HEAD`):
- add `joshweiss` to `OPERATOR_USERS` (line ~33) — currently only `cortextos`, which is why `comms-backfill.py:10`'s `/Users/joshweiss/` passed;
- add a bare-UUID-assigned-to-an-API_KEY shape to `SECRET_RE` (line ~44): `[A-Za-z0-9_]*(API_KEY|TOKEN|SECRET)[A-Za-z0-9_]*\s*=\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"` — the exact shape of the Fireflies key that CI would have waved through.

```
[ ] 6a. ACTION: write .github/scripts/untracked-agent-script-guard.sh implementing checks 1 and 2.
    → VERIFY: bash .github/scripts/untracked-agent-script-guard.sh → exit 0 on the clean branch.
    → DONE-WHEN: exits 0.

[ ] 6b. ACTION: falsifiability test — create a throwaway `orgs/clearworksai/agents/crm/crm/zzz-probe.py`,
        do NOT add it, re-run the guard.
    → VERIFY: guard exits 1 and names zzz-probe.py. Then `rm zzz-probe.py`.
    → DONE-WHEN: guard proven to actually fail (mirror `tests/leak-guard.test.sh`, which the existing
              workflow already runs as a "Prove the scanner" step — add the probe there in the same style).

[ ] 6c. ACTION: add the guard as a step in .github/workflows/leak-guard.yml after the existing scan step.
    → VERIFY: `gh pr checks <PR> --repo clearworks-ai/cortextos` shows the new step running and green.
    → DONE-WHEN: it runs on the PR for THIS branch.

[ ] 6d. ACTION: add the guard invocation to scripts/hooks/pre-push (before the build step, cheap check first).
    → VERIFY: bash scripts/setup-hooks.sh ; touch a probe file ; git push --dry-run → aborted with the message.
    → DONE-WHEN: local hook blocks it too.

[ ] 6e. ACTION: extend .github/scripts/leak-guard.sh per the two additions above.
    → VERIFY: bash .github/scripts/leak-guard.sh --tree HEAD → exit 0 (post-extraction tree is clean).
              Then temporarily re-insert the literal Fireflies key in a scratch file and confirm it FAILS.
    → DONE-WHEN: the scanner catches the shape that slipped through on 2026-08-04.
```

---

## 9. STEP 7 — SHIP

```
[ ] 7a. ACTION: emit the OBF build + review + true-verify pipeline stages. Review MUST come from a
        subagent-authored .md + transcript (a build agent self-emitting `review`/`true-verify` is a
        known bypass — PR#262).
    → VERIFY: cortextos pipeline-stage-emit --verify --slug crm-force-track-scripts → all stages, no self-referencing chain.
    → DONE-WHEN: ledger chain valid.

[ ] 7b. ACTION: git push -u origin crm-force-track-scripts
        gh pr create --repo clearworks-ai/cortextos --base main --head crm-force-track-scripts \
          --title "chore(crm): force-track 19 production scripts + guard (PR#305 unreviewable-diff postmortem)"
    → VERIFY: gh pr checks <N> --repo clearworks-ai/cortextos   (ALWAYS pass --repo; bare `gh pr` hits
              upstream grandamenium and has caused a full ping-pong before)
    → DONE-WHEN: all checks green including the new guard.

[ ] 7c. ACTION: after merge, remove the worktree: git worktree remove ../ctx-crm-force-track-scripts
    → VERIFY: git worktree list → gone.
    → DONE-WHEN: clean.
```

---

## 10. OUT OF SCOPE — DO NOT DO THESE HERE

- **Bug #317 (duplicate contacts / `--id` vs `--match-email`)** — already fixed on branch `crm-dupe-contact-fix`, commit `2cc8df59`. Do not re-fix, do not rebase it into this branch. If `calendar-backfill.py` is tracked by BOTH branches, whichever merges second resolves the conflict — prefer letting `crm-dupe-contact-fix` merge FIRST, then rebase this branch on it.
- **Bug #318 (test event leak / `CRM_EVENT_EMIT_LOG` seam)** — already fixed on branch `crm-emit-event-test-guard`, commit `913e1f38`. Same ordering note.
- **The Mark Lurie 3-way contact merge** — sits in crm's approval queue; data cleanup, not code.
- **Remediating content PR#305 already made public** (`comms-backfill.py:10` `/Users/joshweiss/`) — separate task; requires history rewrite or an accepted-risk decision.
- **Force-tracking frank2 / larry / pa / other agents' scripts.** This spec is crm-only. The ladder in §6 is deliberately scoped to `agents/crm/crm/`. Generalizing is a follow-up.
- **Deleting or migrating any crm runtime data** (`contacts.json`, `interactions.jsonl`, `pipeline.json`, `*.bak*`). Staging-first protocol applies to any of that; none of it belongs in this PR.
- **Making `leak-guard.yml` a required status check on main** — repo-settings change, needs Josh.

---

## 11. RISK

| Risk | Assessment | Mitigation |
|---|---|---|
| **Live credential goes public** | **HIGH — the repo is confirmed PUBLIC (`isPrivate:false`).** The Fireflies key is in 2 files and CI's `SECRET_RE` does not match its bare-UUID shape. | §3 is a hard gate with a full re-scan (1g) before any `git add`. Plus key rotation (1c) and the `SECRET_RE` extension (6e). |
| **Client PII goes public** | MEDIUM — real `@owenscg.com` addresses in 3 test fixtures; personal Gmail in `calendar-backfill.py`. | §3 steps 1e/1f. |
| **Something depends on these files being ignored** | **LOW — checked, nothing does.** No root `pytest.ini` / `pyproject.toml` / `setup.cfg` / `conftest.py` exists, so CI never collects crm python (`npm test` = `vitest run && node --test tests/clearpath-dump/format.test.mjs`). `grep -rn "orgs/clearworksai/agents" src/ scripts/ .github/` → no tooling globs the dir. No `git clean`/`--ignored` automation references it. | Re-run those two checks at execution time and record the output. |
| **`git clean -fdx` behavior changes** | LOW-MEDIUM — after the ladder, `*.py` in that dir is no longer "ignored", so a `git clean -fdx` will delete only *untracked* ones (there will be none) instead of all of them. Net safer. But shared-checkout `git clean` has destroyed untracked `.agent/one-big-feature/` dirs twice this week. | Do all work in the isolated worktree (§4 2a). Never `git clean` in shared main. |
| **Merge conflict with the two in-flight fix branches** | MEDIUM — `crm-dupe-contact-fix` adds `calendar-backfill.py` (202 lines) and `crm-emit-event-test-guard` adds `test_emit_test_guard.py`; both are files this spec also force-tracks. | Merge those two FIRST, then rebase this branch on `origin/main` and re-run §5/§6. Note `test_emit_test_guard.py` and `test_backfill_match_email.py` will already be tracked by then — drop them from §5's list if so. |
| **`git status` noise for crm's live agent** | LOW — after the ladder, crm's own session sees `*.py` edits as modified files rather than invisible. That is the intended behavior, but crm must know not to commit runtime data. | Note it in crm's AGENTS.md as part of the PR (AGENTS.md is gitignored, so this is a local edit, not a repo change). |
| **Ladder accidentally un-ignores something else** | LOW — verified in a scratch repo: `config.json`, `.env`, `contacts.json`, and other agents' files all stay ignored. | §6 step 4a's five-way `git check-ignore` verification. |

---

## 12. OPEN QUESTIONS FOR JOSH

**Q1 (blocking, biggest):** The fork `clearworks-ai/cortextos` is **PUBLIC**. Force-tracking 19 crm scripts publishes Clearworks' internal CRM/pipeline/lead-scoring logic (and PR#305 already published `comms-backfill.py` with `/Users/joshweiss/` in it). Is public exposure of crm's operational scripts **accepted**, or should the reviewability fix instead be "move crm scripts to a private repo / private submodule and track them there"? The whole shape of this spec changes on the answer.

**Q2:** `calendar-backfill.py:26` hardcodes `weissjosh0@gmail.com` — extract to env, or accept inline?

**Q3:** Rotate the Fireflies key (it has been plaintext-on-disk in 2 files and referenced from frank2/.env), or extract-only?

**Q4:** §6 adds a `.gitignore` negation ladder, which is a **departure from the `git add -f`-only precedent** set by `2cc8df59`. `add -f` alone leaves the door open for the next new file to escape review; the ladder closes it. Approve the ladder, or stay strictly with the precedent + rely on the CI guard alone?
