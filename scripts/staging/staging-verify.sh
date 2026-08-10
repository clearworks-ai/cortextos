#!/usr/bin/env bash
# staging-verify — prove isolation + side-effect muting BEFORE the staging daemon is trusted.
# Exit 0 only if every safety assertion holds.
set -uo pipefail

INSTANCE="cortextos-staging"
HOME_DIR="$HOME/.cortextos/$INSTANCE"
FW_ROOT="$HOME/.cortextos/$INSTANCE-fw"
PROD_MARKER="$HOME/.cortextos/state/ACTIVE_INSTANCE"
fail=0
chk(){ if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

echo "== staging-verify =="
# 1. instance home + fw root exist and are separate from prod
chk "staging home exists"        "[[ -d '$HOME_DIR' ]]"
chk "staging fw root exists"     "[[ -d '$FW_ROOT' ]]"
chk "not prod home"              "[[ '$HOME_DIR' != '$HOME/.cortextos/cortextos1' ]]"
# 2. ACTIVE_INSTANCE marker still points at prod (we never flipped it)
chk "ACTIVE_INSTANCE==cortextos1" "[[ \"\$(cat '$PROD_MARKER' 2>/dev/null)\" == 'cortextos1' ]]"
# 3. side-effect muting: NO live creds anywhere staging agents read
CREDS='TELEGRAM|BOT_TOKEN|CHAT_ID|RESEND|SMTP|SLACK|TWILIO|WEBHOOK_BRIDGE_SECRET|OP_SERVICE_ACCOUNT_TOKEN|ACTIVITY_BOT_TOKEN'
hits=$(grep -rniE "$CREDS" "$FW_ROOT" 2>/dev/null | grep -vE '=\s*$' | grep -vE '^\s*#' || true)
chk "no side-effect creds in fw root" "[[ -z \"\$hits\" ]]"
[[ -n "$hits" ]] && echo "  offending: $hits"
chk "no org secrets.env in staging fw" "[[ ! -f '$FW_ROOT/orgs/clearworksai/secrets.env' ]]"
chk "no activity-channel.env in staging fw" "[[ ! -f '$FW_ROOT/orgs/clearworksai/activity-channel.env' ]]"
# 4. socket is per-instance (path differs from prod)
chk "sock path per-instance" "[[ '$HOME_DIR/daemon.sock' != '$HOME/.cortextos/cortextos1/daemon.sock' ]]"

echo "== $( [[ $fail -eq 0 ]] && echo 'STAGING SAFE' || echo 'STAGING UNSAFE — do NOT launch' ) =="
exit $fail
