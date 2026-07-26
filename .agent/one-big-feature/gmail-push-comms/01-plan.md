# Plan: gmail-push-comms

**Branch:** feat/gmail-push-comms  
**Date:** 2026-07-26  
**Goal:** Replace 45m poll-cron for pa/comms-check with a Gmail history.list push listener for near-real-time (≤120s) inbox surface.

---

## Background

The pa agent runs `comms-check` on a 45m cron (fire_count=2562, live as of 2026-07-26). Each fire spawns a haiku worker that reads .claude/skills/comms-check-worker/SKILL.md and triages Gmail/iMessage/CI. Latency is up to 45 minutes.

**Desired state:** A persistent listener (LaunchAgent) polls Gmail history every 60s. On new inbox mail, it debounces 120s then spawns the same comms-check worker. The 45m cron becomes a 4h safety-net sweep. Dedup ledger (comms-event-dedup.json) makes double-fire harmless.

---

## Design Decision: history.list polling vs. Pub/Sub push

**Chosen: Option 2 — history.list polling loop (60s interval)**

The `gws-dwd` shim (the canonical Gmail API path) does NOT implement `+watch`. Pub/Sub push requires a public HTTPS endpoint and additional IAM/project configuration. A 60s history.list poll achieves the same <120s latency goal without needing a Railway endpoint or Pub/Sub setup.

The history.list approach:
- Calls `GET /gmail/v1/users/me/history?startHistoryId=<id>&historyTypes=messageAdded&labelId=INBOX`
- Persists `historyId` in state file between polls
- On new messages: applies hard-exclusion prefilter, debounces 120s, then spawns worker

---

## Files Changed

1. `orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py` — NEW long-lived listener
2. `orgs/clearworksai/agents/pa/scripts/com.clearworks.gmail-push-listener.plist` — NEW LaunchAgent template
3. `orgs/clearworksai/agents/pa/scripts/gmail-push-deploy.sh` — NEW Josh-run deploy script
4. `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md` — EDIT (15m→4h, 1h→5h)
5. `templates/agent/.claude/skills/comms-check-worker/SKILL.md` — EDIT (same edits to keep template in sync)
6. `templates/agent-codex/plugins/cortextos-agent-skills/skills/comms-check-worker/SKILL.md` — EDIT (same)
7. `.agent/one-big-feature/gmail-push-comms/01-plan.md` — this file
8. `.agent/one-big-feature/gmail-push-comms/VERIFY.md` — evidence log

---

## Brief Discrepancy Note

The SKILL.md says `update-cron-fire comms-check --interval 15m`. The live pa crons.json shows `schedule: "45m"` with fire_count=2562. The deploy script targets the cron by name (`comms-check`), not by assumed interval, so it will correctly update regardless.

---

## Morning Deploy Steps (for Josh)

After PR merges:

```bash
# 1. Run the deploy script (interactive only — will refuse if run non-interactively)
/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/scripts/gmail-push-deploy.sh

# 2. Verify listener is registered
launchctl list | grep gmail-push-listener

# 3. Expected post-deploy state:
#    - gmail-push-listener appears in launchctl list
#    - comms-check cron in pa crons.json shows schedule 4h
#    - Logs streaming at ~/Library/Logs/gmail-push-listener.out.log

# 4. Send one test email (from weissjosh0@gmail.com to josh@clearworks.ai)
#    Expect: Telegram surface within 2 minutes

# 5. Rollback (if needed):
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist
cortextos bus update-cron pa comms-check --interval 45m
```

---

## Verify One-Liners (post-deploy)

```bash
# Listener running
pgrep -f gmail_push_listener && echo "RUNNING" || echo "NOT RUNNING"

# State file
cat ~/.cortextos/cortextos1/state/pa/gmail-push-listener.json

# Recent worker spawns
cortextos list-workers 2>/dev/null | grep comms-check-push || echo "none yet"

# Log tail
tail -f ~/Library/Logs/gmail-push-listener.out.log

# Dedup ledger entry
python3 -c "import json; d=json.load(open(os.path.expanduser('~/.cortextos/cortextos1/state/comms-event-dedup.json'))); gmail=[k for k in d if k.startswith('gmail:')]; print(f'{len(gmail)} gmail entries')" 2>/dev/null
```

---

## Rollback

```bash
# Stop listener
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist
rm ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist
pkill -f gmail_push_listener

# Restore poll interval
cortextos bus update-cron pa comms-check --interval 45m
```
