#!/usr/bin/env bash
# staging-seed — build an ISOLATED cortextOS staging instance (do-it-right).
# Design: state/specs/staging-cortextos-design-2026-08-09.md
# Safety: staging has its OWN instance home AND its OWN framework root (agent dirs),
# with EMPTY .env (zero side-effect creds) — it can never message anyone or touch prod.
set -euo pipefail

INSTANCE="cortextos-staging"
HOME_DIR="$HOME/.cortextos/$INSTANCE"          # instance home (state/config/sock)
FW_ROOT="$HOME/.cortextos/$INSTANCE-fw"          # staging framework root (agent dirs)
ORG="clearworksai"
AGENTS=("tlab" "tlab-codex")                     # tlab runs; tlab-codex = phantom for stranding repro

# --- hard guard: never operate on prod ---
[[ "$INSTANCE" == "cortextos1" ]] && { echo "REFUSE: never seed onto prod"; exit 2; }

echo "== seeding $INSTANCE =="
mkdir -p "$HOME_DIR/config" "$HOME_DIR/state" "$HOME_DIR/logs" "$HOME_DIR/inbox" \
         "$HOME_DIR/inflight" "$HOME_DIR/processed"

# clean enabled-agents.json — ONLY tlab enabled (tlab-codex intentionally NOT enabled)
cat > "$HOME_DIR/config/enabled-agents.json" <<EOF
{ "tlab": { "enabled": true, "org": "$ORG", "status": "configured" } }
EOF

# framework-root marker: findFrameworkRoot() validates a candidate by reading a
# package.json with name==='cortextos'. Prod's fw-root IS the repo (has one); staging
# needs its own or the bridge silently resolves the framework root elsewhere and the
# FR-A1 deterministic spawn skill-lookup misses -> false-negative NL fallback.
mkdir -p "$FW_ROOT"
cat > "$FW_ROOT/package.json" <<EOF
{ "name": "cortextos", "private": true, "version": "0.0.0-staging" }
EOF

# staging framework root — minimal agent dirs, EMPTY .env (no creds = no side effects)
for a in "${AGENTS[@]}"; do
  d="$FW_ROOT/orgs/$ORG/agents/$a"
  mkdir -p "$d"
  cat > "$d/config.json" <<EOF
{ "model": "claude-haiku-4-5-20251001", "runtime": "claude-code", "org": "$ORG" }
EOF
  : > "$d/.env"                                  # EMPTY — zero side-effect creds
  cat > "$d/AGENTS.md" <<EOF
# $a (STAGING — muted)
Staging test agent. No credentials. Do nothing but acknowledge injected prompts.
EOF
  # meeting-writeback-worker skill stub — REQUIRED for FR-A1 validation:
  # planMeetingWritebackSpawn() gates on existsSync(.../meeting-writeback-worker/SKILL.md).
  # Without it the deterministic path returns null and we only ever exercise the NL
  # fallback, never proving the daemon spawn. Stub only — staging worker is muted.
  sk="$d/.claude/skills/meeting-writeback-worker"
  mkdir -p "$sk"
  cat > "$sk/SKILL.md" <<EOF
# meeting-writeback-worker (STAGING STUB)
FF_MEETING_ID is injected. Real writeback is muted in staging. Acknowledge and output DONE.
EOF
done
# org secrets.env intentionally ABSENT in staging fw root -> no shared creds
echo "seeded: home=$HOME_DIR fw=$FW_ROOT agents=${AGENTS[*]}"
