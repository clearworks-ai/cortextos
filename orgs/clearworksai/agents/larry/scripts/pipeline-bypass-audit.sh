#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
AGENT_DIR="$ROOT/orgs/clearworksai/agents/larry"
CTX_ROOT_REAL="${CTX_ROOT:-$HOME/.cortextos/cortextos1}"
ABS_AGENT_DIR="$(cd "$AGENT_DIR" && pwd)"
PARENT_TRANSCRIPT_ROOT="${PIPELINE_AUDIT_PARENT_TRANSCRIPTS:-$HOME/.claude/projects/$(printf '%s' "$ABS_AGENT_DIR" | sed 's#/#-#g')}"
OUTPUT_PATH="${PIPELINE_AUDIT_OUTPUT:-$AGENT_DIR/state/bypass-audit/$(date -u +%F).json}"
MEMORY_DIR="$AGENT_DIR/memory"
SEEN_FINDINGS_PATH="$AGENT_DIR/state/bypass-audit/seen-findings.jsonl"
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
mkdir -p "$MEMORY_DIR" "$(dirname "$SEEN_FINDINGS_PATH")"

# Dedup layer 1: uncapped, status-UNFILTERED title scan of the whole task store.
# Reads every task file directly (not a capped `list-tasks --limit N` CLI slice, which
# silently misses older-but-still-open duplicates once AUDIT tasks exceed the cap). No
# `.status` filter — a title match in ANY task record (open OR closed/resolved/wontfix)
# suppresses recreation, so triaging a finding once keeps it triaged.
ALL_TASK_TITLES=""
if [ -d "$TASKS_DIR" ]; then
  ALL_TASK_TITLES="$(for f in "$TASKS_DIR"/*.json; do
    [ -e "$f" ] || continue
    jq -r '.title' "$f" 2>/dev/null
  done)"
fi

# Dedup layer 2: persistent per-finding hash set. Survives a finding's task being deleted
# from the store entirely (title scan alone wouldn't) and disambiguates two distinct
# findings that share a (slug, kind) title but differ in evidence.
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
