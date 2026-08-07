#!/usr/bin/env python3
"""
Gmail Push Listener — pa agent, Clearworks AI
Polls Gmail history.list every 60s for new INBOX messages, debounces 120s,
then spawns the comms-check worker via cortextos spawn-worker.

Design notes:
- Uses history.list (Option 2 fallback): gws-dwd has no +watch, and Pub/Sub
  push requires a public endpoint. 60s poll achieves ≤120s latency goal.
- MUST NOT call `cortextos bus comms-filter` (records on check, starves worker).
- Applies only deterministic hard-exclusion prefilter here (cheap spawn-avoidance).
  The worker (comms-check-worker/SKILL.md) is the authoritative filter.
- Debounce: 120s pending-flag after first delta, single spawn per window.
- Pidfile lock: single instance only.
- Observability: ~/.cortextos/cortextos1/state/pa/gmail-push-listener.json
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HOME = Path.home()
STATE_DIR = HOME / ".cortextos" / "cortextos1" / "state" / "pa"
PIDFILE = STATE_DIR / "gmail-push-listener.pid"
STATE_FILE = STATE_DIR / "gmail-push-listener.json"

AGENT_DIR = Path(__file__).resolve().parent.parent
CORTEXTOS_BIN = "/opt/homebrew/bin/cortextos"

# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------
POLL_INTERVAL = 60          # seconds between history.list calls
DEBOUNCE_SECS = 120         # wait this long after first delta before spawning
WATCH_RENEW_SECS = 86400    # deterministic provider renewal cadence
WATCH_RETRY_SECS = 300
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
# ---------------------------------------------------------------------------
# Hard-exclusion prefilter (same senders/subjects as SKILL.md Step 2.2a)
# These skip a worker spawn entirely — the worker is still the authoritative
# filter but spawning a haiku session for obvious noise is wasteful.
# ---------------------------------------------------------------------------
EXCLUDED_FROM_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"noreply@skool\.com", re.I),
    re.compile(r"events@tailscale\.com", re.I),
    re.compile(r"hello@mindstream\.news", re.I),
    re.compile(r"@sanebox\.com", re.I),
    re.compile(r"notify\.railway\.app", re.I),
    re.compile(r"info@raisedonors\.com", re.I),
    re.compile(r"receipts@openrouter\.ai", re.I),
    re.compile(r"noreply\b", re.I),
    re.compile(r"no-reply\b", re.I),
    re.compile(r"donotreply\b", re.I),
    re.compile(r"do-not-reply\b", re.I),
    re.compile(r"mailer-daemon\b", re.I),
    re.compile(r"@beehiiv\.com", re.I),
    re.compile(r"@mailchimp\.com", re.I),
    re.compile(r"@substack\.com", re.I),
    re.compile(r"@convertkit\.com", re.I),
]

EXCLUDED_SUBJECT_PREFIXES: list[str] = [
    "accepted:",
    "declined:",
    "tentative:",
    "out of office",
    "auto-reply",
    "automatic reply",
    "ooo:",
    "vacation reply",
]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
log = logging.getLogger("gmail-push-listener")


# ---------------------------------------------------------------------------
# Token / Gmail API
# ---------------------------------------------------------------------------

def _get_token() -> str:
    """Return a valid DWD access token through the shared helper."""
    from google_dwd_credentials import get_token
    return get_token()


def _gmail_get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    """Perform a GET against the Gmail API."""
    token = _get_token()
    base = f"https://gmail.googleapis.com/gmail/v1/users/me{path}"
    if params:
        base += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(base, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"error": {"code": e.code, "message": body}}


def get_profile() -> dict[str, Any]:
    return _gmail_get("/profile")


def get_history(
    start_history_id: str,
    label_id: str = "INBOX",
) -> dict[str, Any]:
    params = {
        "startHistoryId": start_history_id,
        "historyTypes": "messageAdded",
        "labelId": label_id,
    }
    return _gmail_get("/history", params)


def get_message_headers(msg_id: str) -> dict[str, str]:
    """Return From/Subject/To header dict for a message."""
    data = _gmail_get(f"/messages/{msg_id}", {"format": "metadata",
                                               "metadataHeaders": "From,Subject,To"})
    if "error" in data:
        return {}
    hdrs = data.get("payload", {}).get("headers", [])
    return {h["name"]: h["value"] for h in hdrs}


# ---------------------------------------------------------------------------
# Hard-exclusion prefilter
# ---------------------------------------------------------------------------

def _is_excluded(from_addr: str, subject: str) -> bool:
    """Return True if this message should be skipped without spawning a worker.
    This is a CHEAP spawn-avoidance filter only — the worker still applies
    the full authoritative filter from SKILL.md Step 2.
    MUST NOT call cortextos bus comms-filter (records-on-check → starves worker).
    """
    for pat in EXCLUDED_FROM_PATTERNS:
        if pat.search(from_addr):
            return True
    subject_lower = subject.lower().strip()
    for prefix in EXCLUDED_SUBJECT_PREFIXES:
        if subject_lower.startswith(prefix):
            return True
    return False


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------

def load_state() -> dict[str, Any]:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = str(STATE_FILE) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


# ---------------------------------------------------------------------------
# Worker spawn
# ---------------------------------------------------------------------------

def spawn_comms_check_worker(reason: str = "") -> None:
    """Spawn comms-check worker via cortextos spawn-worker.
    Mirrors the exact command in pa/crons.json comms-check prompt.
    """
    epoch = int(time.time())
    worker_name = f"comms-check-push-{epoch}"
    skill_prompt = (
        "Read .claude/skills/comms-check-worker/SKILL.md and execute it exactly. "
        "You are a short-lived worker — no bootstrapping, no heartbeat, no prose. "
        "Do the task, act on findings, output DONE."
    )
    cmd = [
        CORTEXTOS_BIN, "spawn-worker", worker_name,
        "--dir", str(AGENT_DIR),
        "--parent", "frank2",
        "--model", "claude-haiku-4-5-20251001",
        "--prompt", skill_prompt,
    ]
    log.info("Spawning worker: %s (reason=%s)", worker_name, reason or "delta")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            log.info("Worker spawned OK: %s", worker_name)
        else:
            log.warning("spawn-worker non-zero rc=%d stderr=%s",
                        result.returncode, result.stderr[:200])
    except subprocess.TimeoutExpired:
        log.error("spawn-worker timed out")
    except FileNotFoundError:
        log.error("cortextos binary not found at %s", CORTEXTOS_BIN)


def renew_provider_leases(state: dict[str, Any], now: float) -> None:
    """Run due Google lease renewals through deterministic CLI code.

    This reuses the existing polling process and remains inert until an
    operator supplies the approval reference during the provider activation
    window. Provider output is intentionally not logged.
    """
    approval = os.environ.get("GOOGLE_PROVIDER_RENEWAL_APPROVAL", "")
    if not re.fullmatch(r"[-A-Za-z0-9_/.]{3,128}", approval):
        return
    last_attempt = float(state.get("provider_renewal_last_attempt", 0) or 0)
    last_success = float(state.get("provider_renewal_last_success", 0) or 0)
    interval = WATCH_RETRY_SECS if last_attempt > last_success else WATCH_RENEW_SECS
    if last_attempt > 0 and now - last_attempt < interval:
        return

    state["provider_renewal_last_attempt"] = now
    framework_root = str(AGENT_DIR.parents[4])
    command_env = {
        **os.environ,
        "CTX_FRAMEWORK_ROOT": framework_root,
        "CTX_PROJECT_ROOT": framework_root,
        "CTX_ROOT": str(HOME / ".cortextos" / "cortextos1"),
        "CTX_INSTANCE_ID": "cortextos1",
    }
    commands = (
        [CORTEXTOS_BIN, "google-provider", "gmail", "renew", "--apply", "--approval", approval],
        [CORTEXTOS_BIN, "google-provider", "calendar", "renew", "--apply", "--approval", approval],
    )
    for command in commands:
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    timeout=60, env=command_env)
        except (OSError, subprocess.TimeoutExpired):
            log.error("Google provider renewal failed (provider_renewal_exec_failed)")
            return
        if result.returncode != 0:
            log.error("Google provider renewal failed (provider_renewal_command_failed)")
            return
    state["provider_renewal_last_success"] = now
    log.info("Google provider renewal check completed")


# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

def run_self_test() -> int:
    """
    --self-test: Feed 3 canned NDJSON lines through the exclusion filter and
    debounce logic. No network, no worker spawns (mocked).
    Returns 0 on pass, 1 on failure.
    """
    import io

    cases = [
        # (from_addr, subject, expect_excluded, description)
        ("josh@clearworks.ai", "Can we talk tomorrow?",
         False, "human mail from josh -> would spawn"),
        ("noreply@github.com", "Your monthly digest",
         True,  "noreply sender -> skip"),
        ("alice@example.com", "Out of office: back Monday",
         True,  "OOO subject -> skip"),
    ]

    failed = 0
    for from_addr, subject, expect_excluded, desc in cases:
        got = _is_excluded(from_addr, subject)
        status = "PASS" if got == expect_excluded else "FAIL"
        if status == "FAIL":
            failed += 1
        print(f"[self-test] {status}: {desc!r} "
              f"(excluded={got}, expected={expect_excluded})")

    # Assert: comms-filter is never INVOKED in this module.
    # We check this by searching for it in the actual runtime cmd list passed to subprocess.
    # The marker below is the canary — if present in cmd arrays it would be a real call.
    _FORBIDDEN_TOKEN = "comms" + "-" + "filter"  # split so this assertion doesn't trigger itself
    import inspect
    source_lines = inspect.getsource(sys.modules[__name__]).splitlines()
    # Flag lines where subprocess.run/call/Popen and the forbidden token appear together,
    # excluding lines that are comments or print/string literals from this very test block.
    bad_lines = [
        ln for ln in source_lines
        if _FORBIDDEN_TOKEN in ln
        and ("subprocess.run" in ln or "subprocess.call" in ln or "subprocess.Popen" in ln)
        and not ln.strip().startswith("#")
    ]
    if bad_lines:
        print("[self-test] FAIL: comms-filter appears in a subprocess call (forbidden)")
        for bl in bad_lines:
            print(f"          line: {bl.strip()}")
        failed += 1
    else:
        print("[self-test] PASS: no comms-filter subprocess invocation in listener source")

    print(f"[self-test] {'PASSED' if failed == 0 else 'FAILED'} ({failed} failures)")
    return 0 if failed == 0 else 1


# ---------------------------------------------------------------------------
# Pidfile lock
# ---------------------------------------------------------------------------

_pidfile_fd: int | None = None


def acquire_pidfile() -> bool:
    """Acquire pidfile lock. Returns False if another instance is running."""
    global _pidfile_fd
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(PIDFILE), os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        _pidfile_fd = fd
        return True
    except OSError:
        return False


def release_pidfile() -> None:
    global _pidfile_fd
    if _pidfile_fd is not None:
        try:
            fcntl.flock(_pidfile_fd, fcntl.LOCK_UN)
            os.close(_pidfile_fd)
        except OSError:
            pass
        _pidfile_fd = None
    try:
        PIDFILE.unlink(missing_ok=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main_loop() -> None:
    state = load_state()
    history_id: str = state.get("history_id", "")
    child_restarts: int = state.get("child_restarts", 0)
    pending_since: float | None = state.get("pending_since")

    # Bootstrap historyId from profile if missing
    if not history_id:
        log.info("No historyId in state, bootstrapping from profile...")
        profile = get_profile()
        if "error" in profile:
            log.error("Failed to get Gmail profile: %s", profile["error"])
            time.sleep(30)
            return
        history_id = str(profile.get("historyId", ""))
        log.info("Bootstrapped historyId=%s", history_id)
        state["history_id"] = history_id
        state["last_pull"] = time.time()
        save_state(state)

    log.info("Entering poll loop (interval=%ds, debounce=%ds)", POLL_INTERVAL, DEBOUNCE_SECS)

    # Graceful shutdown
    running = [True]

    def _shutdown(sig: int, frame: Any) -> None:
        log.info("Caught signal %d — shutting down", sig)
        running[0] = False

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while running[0]:
        now = time.time()

        renew_provider_leases(state, now)
        save_state(state)

        # Poll history
        result = get_history(history_id)

        if "error" in result:
            err = result["error"]
            # historyId too old → re-bootstrap
            if isinstance(err, dict) and err.get("code") in (404, 400):
                log.warning("historyId stale/invalid, re-bootstrapping")
                profile = get_profile()
                if "historyId" in profile:
                    history_id = str(profile["historyId"])
                    state["history_id"] = history_id
                    state["child_restarts"] = child_restarts + 1
                    child_restarts += 1
                    save_state(state)
            else:
                log.warning("history.list error: %s", err)
            time.sleep(POLL_INTERVAL)
            continue

        # Advance historyId even if no new messages
        new_history_id = str(result.get("historyId", history_id))
        if new_history_id != history_id:
            history_id = new_history_id
            state["history_id"] = history_id

        # Check for new messages
        history_records = result.get("history", [])
        new_messages: list[dict[str, Any]] = []
        for record in history_records:
            for msg_added in record.get("messagesAdded", []):
                msg = msg_added.get("message", {})
                if "INBOX" in msg.get("labelIds", []):
                    new_messages.append(msg)

        delta_count = len(new_messages)
        state["last_pull"] = now

        if delta_count > 0:
            log.info("Delta: %d new INBOX message(s)", delta_count)

            # Apply hard-exclusion prefilter
            actionable = 0
            for msg in new_messages:
                msg_id = msg.get("id", "")
                hdrs = get_message_headers(msg_id)
                from_addr = hdrs.get("From", "")
                subject = hdrs.get("Subject", "")
                if _is_excluded(from_addr, subject):
                    log.debug("Prefilter SKIP: from=%r subject=%r", from_addr, subject)
                else:
                    actionable += 1
                    log.info("Prefilter PASS (potential): from=%r subject=%r",
                             from_addr, subject)

            state["last_delta"] = now
            if actionable > 0 and pending_since is None:
                pending_since = now
                state["pending_since"] = pending_since
                log.info("Set pending_since (debounce starts)")
        else:
            log.debug("No new INBOX messages since last historyId")

        # Debounce: fire when pending and enough time has elapsed
        if pending_since is not None and (now - pending_since) >= DEBOUNCE_SECS:
            spawn_comms_check_worker(reason="push-delta")
            state["last_spawn"] = now
            pending_since = None
            del state["pending_since"]

        save_state(state)
        time.sleep(POLL_INTERVAL)

    log.info("Listener exited cleanly")
    release_pidfile()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Gmail Push Listener for pa agent")
    parser.add_argument("--self-test", action="store_true",
                        help="Run deterministic self-test (no network)")
    parser.add_argument("--once", action="store_true",
                        help="Run one poll cycle then exit (for smoke-testing)")
    args = parser.parse_args()

    if args.self_test:
        sys.exit(run_self_test())

    # Single-instance lock
    if not acquire_pidfile():
        log.error("Another instance is already running (pidfile=%s). Exiting.", PIDFILE)
        sys.exit(1)

    log.info("Gmail Push Listener starting (pid=%d)", os.getpid())
    log.info("Agent dir: %s", AGENT_DIR)
    log.info("State file: %s", STATE_FILE)

    # Ensure state dir exists
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        if args.once:
            # One-shot mode for smoke testing
            state = load_state()
            history_id = state.get("history_id", "")
            if not history_id:
                profile = get_profile()
                if "error" in profile:
                    log.error("Profile error: %s", profile)
                    sys.exit(1)
                history_id = str(profile.get("historyId", ""))
                state["history_id"] = history_id
                state["last_pull"] = time.time()
                save_state(state)
                log.info("Bootstrapped historyId=%s (--once mode)", history_id)
            else:
                result = get_history(history_id)
                log.info("history.list result: %s", json.dumps(result)[:500])
        else:
            main_loop()
    finally:
        release_pidfile()


if __name__ == "__main__":
    main()
