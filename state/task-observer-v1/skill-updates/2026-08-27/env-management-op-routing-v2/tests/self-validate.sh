#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FAILED_BUNDLE=/Users/joshweiss/code/cortextos/state/task-observer-v1/skill-updates/2026-08-27/credential-access-preflight.skill
LIVE_TEMPLATE=/Users/joshweiss/code/cortextos/templates/agent-codex/plugins/cortextos-agent-skills/skills/env-management/SKILL.md

jq -e '.schema_version == 2 and .installed == false and .runtime_or_config_mutated == false' "$ROOT/manifest.json" >/dev/null
jq -e '.target_count == 11 and (.targets | length) == 11 and (.explicit_exclusions | index("maven")) != null and (.explicit_exclusions | index("muse")) != null' "$ROOT/publishing-manifest.json" >/dev/null

test "$(shasum -a 256 "$FAILED_BUNDLE" | awk '{print $1}')" = d66935cb60101d28b3e67f29874716ecd0f540bde57eb79ab78af7d0a805d111
test "$(shasum -a 256 "$LIVE_TEMPLATE" | awk '{print $1}')" = abe0ffd653c19f6ebe4518d55fcc458b114de34dd746c8f504ff3113b0752f62

for ref in credential-access-contract.md publishing-contract.md; do
  test -f "$ROOT/references/$ref"
done

for state in \
  credential_env_not_inherited credential_wrapper_unavailable credential_token_absent \
  credential_token_rejected credential_identity_mismatch credential_access_denied \
  credential_target_not_found credential_target_ambiguous credential_operation_not_allowlisted \
  credential_timeout credential_provider_error credential_success; do
  grep -q "$state" "$ROOT/references/credential-access-contract.md"
done

grep -q 'resolveOpRefsAsync' "$ROOT/references/credential-access-contract.md"
grep -q 'No generic child-command injection' "$ROOT/references/credential-access-contract.md"
grep -q 'whoami_attempted=false' "$ROOT/references/credential-access-contract.md"
grep -q 'opaque configured expected digest' "$ROOT/references/credential-access-contract.md"
grep -q 'zero secret output' "$ROOT/references/credential-access-contract.md"
grep -q 'byte-for-byte equal' "$ROOT/references/publishing-contract.md"
grep -q 'idempotence' "$ROOT/references/publishing-contract.md"
grep -q 'Rollback' "$ROOT/references/publishing-contract.md"

if grep -R -E 'OP_SERVICE_ACCOUNT_TOKEN=[^"[:space:]]+|op://[^`[:space:]]+' "$ROOT" \
  --exclude=SHA256SUMS.json --exclude=self-validate.sh; then
  echo 'secret-like value or op target found' >&2
  exit 1
fi

if find "$ROOT" -type f \( -name '*.pyc' -o -name '.DS_Store' -o -name '.~lock.*' \) | grep -q .; then
  echo 'build artifact found' >&2
  exit 1
fi

python3 -m json.tool "$ROOT/manifest.json" >/dev/null
python3 -m json.tool "$ROOT/publishing-manifest.json" >/dev/null
test -f "$ROOT/SHA256SUMS.json"
python3 -m json.tool "$ROOT/SHA256SUMS.json" >/dev/null

echo 'SELF_VALIDATION_PASS'
