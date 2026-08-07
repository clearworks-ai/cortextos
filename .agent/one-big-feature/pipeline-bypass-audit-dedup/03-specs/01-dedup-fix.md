# Spec 01 — Repair the dedup guard in pipeline-bypass-audit.sh

Slug: `pipeline-bypass-audit-dedup`
Target repo: `/Users/joshweiss/code/cortextos`
Scope: `orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` (one file). Nothing else.
Do NOT touch `src/pipeline/bypass-audit.ts` or any other cron/script.

## Git tracking (do this first)

This file is currently gitignored (`.gitignore:17` → `orgs/clearworksai/*`) and untracked
(confirmed: `git ls-files -- orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh`
returns nothing; `git log --all -- <same path>` returns nothing). Force-add it so this fix has
real git history and PR review:

```bash
git add -f orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh
```

Do not modify `.gitignore` itself — only this one path is force-tracked.

## Current file (full, as of 2026-08-04 — 108 lines)

The live file has two dedup-related problems to fix, both inside this region:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
AGENT_DIR="$ROOT/orgs/clearworksai/agents/larry"
CTX_ROOT_REAL="${CTX_ROOT:-$HOME/.cortextos/cortextos1}"
ABS_AGENT_DIR="$(cd "$AGENT_DIR" && pwd)"
PARENT_TRANSCRIPT_ROOT="${PIPELINE_AUDIT_PARENT_TRANSCRIPTS:-$HOME/.claude/projects/$(printf '%s' "$ABS_AGENT_DIR" | sed 's#/#-#g')}"
OUTPUT_PATH="${PIPELINE_AUDIT_OUTPUT:-$AGENT_DIR/state/bypass-audit/$(date -u +%F).json}"
MEMORY_DIR="$AGENT_DIR/memory"
ORG="$(basename "$(dirname "$(dirname "$AGENT_DIR")")")"
TASKS_DIR="${CTX_ROOT_REAL}/orgs/${ORG}/tasks"

if [ -f "$ROOT/dist/pipeline/bypass-audit.js" ]; then
  AUDIT_CMD=(node "$ROOT/dist/pipeline/bypass-audit.js")
else
  AUDIT_CMD=("$ROOT/node_modules/.bin/tsx" "$ROOT/src/pipeline/bypass-audit.ts")
fi

REPORT_JSON="$("${AUDIT_CMD[@]}" \
  --ctx-root "$CTX_ROOT_REAL" \
  --project-root "$ROOT" \
  --agent larry \
  --parent-transcript-root "$PARENT_TRANSCRIPT_ROOT" \
  --output "$OUTPUT_PATH")"

BYPASS_COUNT="$(printf '%s' "$REPORT_JSON" | jq '.bypasses | length')"
ADVISORY_COUNT="$(printf '%s' "$REPORT_JSON" | jq '.advisories | length')"
mkdir -p "$MEMORY_DIR"
EXISTING_OPEN_TITLES=""
if [ -d "$TASKS_DIR" ]; then
  EXISTING_OPEN_TITLES="$(for f in "$TASKS_DIR"/*.json; do
    [ -e "$f" ] || continue
    jq -r 'select(.status=="pending" or .status=="in_progress" or .status=="blocked" or .status=="waiting") | .title' "$f" 2>/dev/null
  done)"
fi

if [ "$BYPASS_COUNT" -eq 0 ]; then
  printf 'OK\n'
  exit 0
fi

DATE_STAMP="$(date -u +%F)"
INDEX=0
printf '%s' "$REPORT_JSON" | jq -c '.bypasses[]' | while IFS= read -r finding; do
  INDEX=$((INDEX + 1))
  SLUG="$(printf '%s' "$finding" | jq -r '.slug // "unknown"')"
  KIND="$(printf '%s' "$finding" | jq -r '.kind')"
  CODE="$(printf '%s' "$finding" | jq -r '.code // empty')"
  DETAIL="$(printf '%s' "$finding" | jq -r '.detail')"
  EVIDENCE="$(printf '%s' "$finding" | jq -r '.evidence[]?' | sed 's/^/- /')"

  TASK_TITLE="[AUDIT] Close pipeline bypass: $SLUG ($KIND)"
  if cortextos bus list-tasks --format json --limit 200 2>/dev/null \
    | jq -e --arg t "$TASK_TITLE" \
        '.[] | select(.title == $t and (.status == "pending" or .status == "in_progress" or .status == "blocked" or .status == "waiting"))' \
    >/dev/null; then
    continue
  fi

  FEEDBACK_PATH="$MEMORY_DIR/feedback_pipeline_bypass_${DATE_STAMP}_${SLUG}_${INDEX}.md"

  cat >"$FEEDBACK_PATH" <<EOF
# Pipeline Bypass Finding

- Date: $DATE_STAMP
- Slug: $SLUG
- Kind: $KIND
- Code: ${CODE:-n/a}
- Detail: $DETAIL

## Evidence
$EVIDENCE
EOF

  cortextos bus create-task "[AUDIT] Close pipeline bypass: $SLUG ($KIND)" \
    --desc "$DETAIL

Evidence:
$EVIDENCE

Feedback file: $FEEDBACK_PATH" \
    >/dev/null 2>&1 || true
done

PAGE_TEXT="$(
  printf '%s' "$REPORT_JSON" | node -e '
    const chunks = [];
    process.stdin.on("data", d => chunks.push(d));
    process.stdin.on("end", () => {
      const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const lines = [`Pipeline bypass audit found ${report.bypasses.length} issue(s) in last 24h.`];
      for (const finding of report.bypasses) {
        const slug = finding.slug ? ` [${finding.slug}]` : "";
        const code = finding.code ? ` ${finding.code}` : "";
        lines.push(`- ${finding.kind}${slug}${code}: ${finding.detail}`);
      }
      if (report.advisories.length > 0) {
        lines.push(`Advisories: ${report.advisories.length}`);
      }
      process.stdout.write(lines.join("\n"));
    });
  '
)"

cortextos bus send-telegram "${CTX_TELEGRAM_CHAT_ID:-6690120787}" "$PAGE_TEXT" >/dev/null
printf 'FINDINGS=%s ADVISORIES=%s\n' "$BYPASS_COUNT" "$ADVISORY_COUNT"
```

**Bug 1 (dead code):** `EXISTING_OPEN_TITLES` (lines ~30-36) is computed from an uncapped
`$TASKS_DIR` scan but never referenced again anywhere below.

**Bug 2 (the actual live guard, broken):** the `if cortextos bus list-tasks --format json
--limit 200 ...` block (inside the `while` loop) is what actually gates `create-task` today. It
queries a **capped, most-recent-200** slice of the bus and filters to **open statuses only**.
Verified live 2026-08-04: task store has 2168 total tasks / 361 open; the `--limit 200` call
surfaces only 23 of the 54 actually-pending `[AUDIT]` titles. Older duplicates fall outside the
200-row window and the guard never sees them, so it recreates them anyway.

## Required change

1. **Remove** the dead `EXISTING_OPEN_TITLES` block (as written above) and the broken
   `cortextos bus list-tasks --limit 200` guard block (as written above).
2. **Add**, right after `MEMORY_DIR="$AGENT_DIR/memory"` (keep `ORG=`/`TASKS_DIR=` as-is, they're
   already correct and used), a new state-file path:
   ```bash
   SEEN_FINDINGS_PATH="$AGENT_DIR/state/bypass-audit/seen-findings.jsonl"
   ```
3. **Replace** the old `EXISTING_OPEN_TITLES` block (right after `mkdir -p "$MEMORY_DIR"`) with a
   status-unfiltered title scan and the seen-findings hash set:
   ```bash
   mkdir -p "$MEMORY_DIR" "$(dirname "$SEEN_FINDINGS_PATH")"

   ALL_TASK_TITLES=""
   if [ -d "$TASKS_DIR" ]; then
     ALL_TASK_TITLES="$(for f in "$TASKS_DIR"/*.json; do
       [ -e "$f" ] || continue
       jq -r '.title' "$f" 2>/dev/null
     done)"
   fi

   SEEN_FINDING_IDS=""
   if [ -f "$SEEN_FINDINGS_PATH" ]; then
     SEEN_FINDING_IDS="$(jq -r '.finding_id' "$SEEN_FINDINGS_PATH" 2>/dev/null)"
   fi

   sha_hex() {
     if command -v shasum >/dev/null 2>&1; then
       shasum -a 256 | cut -c1-16
     elif command -v sha256sum >/dev/null 2>&1; then
       sha256sum | cut -c1-16
     else
       openssl dgst -sha256 | awk '{print $NF}' | cut -c1-16
     fi
   }
   ```
   Note: no `.status` filter on `ALL_TASK_TITLES` — this is intentional, matches the "open OR
   closed" dedup requirement.
4. Inside the `while IFS= read -r finding; do ... done` loop, replace the old
   `TASK_TITLE=...` + broken `if cortextos bus list-tasks ...` block with:
   ```bash
   TASK_TITLE="[AUDIT] Close pipeline bypass: $SLUG ($KIND)"
   EVIDENCE_SORTED="$(printf '%s' "$finding" | jq -r '.evidence[]?' | LC_ALL=C sort | paste -sd, -)"
   FINDING_ID="$(printf '%s|%s|%s|%s' "$SLUG" "$KIND" "${CODE:-}" "$EVIDENCE_SORTED" | sha_hex)"

   if printf '%s\n' "$ALL_TASK_TITLES" | grep -Fxq "$TASK_TITLE"; then
     continue
   fi
   if printf '%s\n' "$SEEN_FINDING_IDS" | grep -Fxq "$FINDING_ID"; then
     continue
   fi
   ```
5. After the existing `cortextos bus create-task ... || true` call, append a line to the
   state file recording this finding as seen (do this unconditionally after the create-task
   call, even though it's best-effort/`|| true` on failure — we still want to remember we
   attempted this finding so a flaky `create-task` failure doesn't cause infinite retries every
   night; that matches the existing `|| true` swallow-and-move-on behavior already in the
   script):
   ```bash
   jq -n -c \
     --arg finding_id "$FINDING_ID" \
     --arg slug "$SLUG" \
     --arg kind "$KIND" \
     --arg code "${CODE:-}" \
     --arg title "$TASK_TITLE" \
     --arg first_seen "$DATE_STAMP" \
     '{finding_id: $finding_id, slug: $slug, kind: $kind, code: $code, title: $title, first_seen: $first_seen}' \
     >>"$SEEN_FINDINGS_PATH"
   ```
6. Leave the feedback-file write (`FEEDBACK_PATH=...` / `cat >"$FEEDBACK_PATH" <<EOF ... EOF`)
   exactly where it is today, still only reached when the finding is genuinely new (i.e. after
   both dedup checks pass) — unchanged content/format.
7. Leave everything from `PAGE_TEXT="$(...)"` to the final `printf 'FINDINGS=%s
   ADVISORIES=%s\n' ...` line completely unchanged.

## Full resulting loop body (for reference — exact shape after the edit)

```bash
printf '%s' "$REPORT_JSON" | jq -c '.bypasses[]' | while IFS= read -r finding; do
  INDEX=$((INDEX + 1))
  SLUG="$(printf '%s' "$finding" | jq -r '.slug // "unknown"')"
  KIND="$(printf '%s' "$finding" | jq -r '.kind')"
  CODE="$(printf '%s' "$finding" | jq -r '.code // empty')"
  DETAIL="$(printf '%s' "$finding" | jq -r '.detail')"
  EVIDENCE="$(printf '%s' "$finding" | jq -r '.evidence[]?' | sed 's/^/- /')"

  TASK_TITLE="[AUDIT] Close pipeline bypass: $SLUG ($KIND)"
  EVIDENCE_SORTED="$(printf '%s' "$finding" | jq -r '.evidence[]?' | LC_ALL=C sort | paste -sd, -)"
  FINDING_ID="$(printf '%s|%s|%s|%s' "$SLUG" "$KIND" "${CODE:-}" "$EVIDENCE_SORTED" | sha_hex)"

  if printf '%s\n' "$ALL_TASK_TITLES" | grep -Fxq "$TASK_TITLE"; then
    continue
  fi
  if printf '%s\n' "$SEEN_FINDING_IDS" | grep -Fxq "$FINDING_ID"; then
    continue
  fi

  FEEDBACK_PATH="$MEMORY_DIR/feedback_pipeline_bypass_${DATE_STAMP}_${SLUG}_${INDEX}.md"

  cat >"$FEEDBACK_PATH" <<EOF
# Pipeline Bypass Finding

- Date: $DATE_STAMP
- Slug: $SLUG
- Kind: $KIND
- Code: ${CODE:-n/a}
- Detail: $DETAIL

## Evidence
$EVIDENCE
EOF

  cortextos bus create-task "$TASK_TITLE" \
    --desc "$DETAIL

Evidence:
$EVIDENCE

Feedback file: $FEEDBACK_PATH" \
    >/dev/null 2>&1 || true

  jq -n -c \
    --arg finding_id "$FINDING_ID" \
    --arg slug "$SLUG" \
    --arg kind "$KIND" \
    --arg code "${CODE:-}" \
    --arg title "$TASK_TITLE" \
    --arg first_seen "$DATE_STAMP" \
    '{finding_id: $finding_id, slug: $slug, kind: $kind, code: $code, title: $title, first_seen: $first_seen}' \
    >>"$SEEN_FINDINGS_PATH"
done
```

(Note: `cortextos bus create-task "$TASK_TITLE" ...` — reuse the variable instead of retyping
the literal string, purely a cleanup, behavior-identical.)

## Acceptance criteria

- [ ] `git ls-files -- orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` returns
      the path (force-add succeeded, file now tracked).
- [ ] `bash -n orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` — syntax check
      passes clean.
- [ ] Dead `EXISTING_OPEN_TITLES` block and the broken `cortextos bus list-tasks --limit 200`
      guard are both gone — `grep -c "EXISTING_OPEN_TITLES\|--limit 200"` on the file returns 0.
- [ ] Running the script once against the real live task store creates **zero** new `[AUDIT]`
      tasks for any of the 54 currently-pending duplicate findings (title-scan layer alone must
      catch the entire existing backlog on the first run).
- [ ] Running it a second time immediately after is still zero new duplicates (both layers
      agree; `seen-findings.jsonl` now has entries).
- [ ] Closing one existing AUDIT task and re-running does NOT recreate a task for that finding
      (closed tasks are suppressed too, not just open ones — this is the actual bug fix, verify
      it explicitly, don't just assume the title-scan handles it).
- [ ] `orgs/clearworksai/agents/larry/state/bypass-audit/seen-findings.jsonl` is created/appended
      by the script itself at runtime (not hand-authored), one JSON line per newly-created
      finding, valid JSON per line (`jq -c . seen-findings.jsonl` doesn't error).
- [ ] Feedback-file writes (`memory/feedback_pipeline_bypass_...md`) still happen only for
      genuinely new findings, format unchanged.
- [ ] The Telegram summary page (`PAGE_TEXT` / `send-telegram` call) and the final
      `FINDINGS=... ADVISORIES=...` stdout line are byte-identical to today's behavior.
- [ ] Diff touches only `orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` (plus
      the new runtime-generated `seen-findings.jsonl`, which should NOT be hand-committed by
      codexer — it's created by running the script, not authored).
- [ ] `src/pipeline/bypass-audit.ts` and `tests/unit/pipeline/bypass-audit.test.ts` are
      untouched (`git diff --stat` confirms).
