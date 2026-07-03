#!/usr/bin/env bash
# publish-wiki.sh — Re-publish the knowledge-sync wiki/ directory to the briefs host
#
# Usage:
#   bash bus/publish-wiki.sh [--wiki-dir DIR] [--dry-run]
#
# Options:
#   --wiki-dir DIR   Wiki source directory (default: ~/code/knowledge-sync/wiki)
#   --dry-run        Print what would be published without uploading
#
# Env (REQUIRED, sourced from .env — values are never printed):
#   BRIEFS_BASE_URL         Base URL of the briefs host (e.g. https://briefs.example)
#   DASHBOARD_BRIEF_TOKEN   Auth token for the publish endpoint
#
# Exit codes:
#   0  published and curl-verified (index returned HTTP 200)
#   1  missing env / missing wiki dir / upload failure / verification failure
#
# On success prints a final receipt line:
#   WIKI_PUBLISH_RECEIPT {"published": <n>, "status": <code>}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Source env if available
ENV_FILE="${FRAMEWORK_ROOT}/.env"
[[ -f "$ENV_FILE" ]] && set -o allexport && source "$ENV_FILE" && set +o allexport

WIKI_DIR="${HOME}/code/knowledge-sync/wiki"
DRY_RUN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wiki-dir) WIKI_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -*) echo "Unknown flag: $1"; exit 1 ;;
    *) echo "Unexpected argument: $1"; exit 1 ;;
  esac
done

# Required env — never echo the values themselves.
if [[ -z "${BRIEFS_BASE_URL:-}" ]]; then
  echo "ERROR: BRIEFS_BASE_URL is not set (expected in environment or ${ENV_FILE})"
  exit 1
fi
if [[ -z "${DASHBOARD_BRIEF_TOKEN:-}" ]]; then
  echo "ERROR: DASHBOARD_BRIEF_TOKEN is not set (expected in environment or ${ENV_FILE})"
  exit 1
fi

if [[ ! -d "$WIKI_DIR" ]]; then
  echo "ERROR: wiki directory not found: $WIKI_DIR"
  exit 1
fi

# Count publishable files (markdown + html)
FILE_COUNT=$(find "$WIKI_DIR" -type f \( -name '*.md' -o -name '*.html' \) | wc -l | tr -d ' ')

if [[ "$FILE_COUNT" -eq 0 ]]; then
  echo "ERROR: no publishable files under $WIKI_DIR"
  exit 1
fi

if [[ -n "$DRY_RUN" ]]; then
  echo "DRY RUN: would publish $FILE_COUNT files from $WIKI_DIR"
  echo "WIKI_PUBLISH_RECEIPT {\"published\": 0, \"status\": 0}"
  exit 0
fi

# Upload: POST a tarball of the wiki dir to the briefs publish endpoint.
# Token travels in a header only — never in the URL, never in output.
TARBALL="$(mktemp -t wiki-publish.XXXXXX).tar.gz"
trap 'rm -f "$TARBALL"' EXIT
tar -czf "$TARBALL" -C "$WIKI_DIR" .

UPLOAD_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${DASHBOARD_BRIEF_TOKEN}" \
  -H "Content-Type: application/gzip" \
  --data-binary @"$TARBALL" \
  "${BRIEFS_BASE_URL%/}/api/wiki/publish")

if [[ "$UPLOAD_STATUS" != "200" && "$UPLOAD_STATUS" != "201" ]]; then
  echo "ERROR: publish upload failed (HTTP $UPLOAD_STATUS)"
  exit 1
fi

# Curl-verify the published index BEFORE claiming success
# (memory rule: curl-verify any link before it reaches Josh).
VERIFY_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${DASHBOARD_BRIEF_TOKEN}" \
  "${BRIEFS_BASE_URL%/}/wiki/")

if [[ "$VERIFY_STATUS" != "200" ]]; then
  echo "ERROR: published index verification failed (HTTP $VERIFY_STATUS) — do not share the link"
  exit 1
fi

echo "Published $FILE_COUNT files; index verified HTTP $VERIFY_STATUS"
echo "WIKI_PUBLISH_RECEIPT {\"published\": ${FILE_COUNT}, \"status\": ${VERIFY_STATUS}}"
