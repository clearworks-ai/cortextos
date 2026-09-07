#!/usr/bin/env python3
"""
collect_evidence.py — snapshot every cortextOS diagnostic surface at once.

Reads a consistent moment across logs, bus, state, and daemon output so the
investigation is not chasing files that shift underneath it. Writes a bundle to
disk so findings survive a daemon restart (which kills the calling agent).

    python3 collect_evidence.py --agent opsbot --since 2h
    python3 collect_evidence.py                    # whole fleet
    python3 collect_evidence.py --root <path> --out <dir>

Runs on Linux, macOS, and Windows. Standard library only. Strictly read-only —
it never restarts, edits, or deletes anything.

This is a fast path over the standard layout, not a substitute for looking.
Installs drift. A thin bundle means "go read by hand" (see surface-map.md), not
"nothing is wrong."
"""

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

IS_WIN = os.name == "nt"
HOME = Path.home()

# Secrets are scrubbed at write time: a bundle often gets pasted into a report or
# a PR discussion, so scrubbing later is too late.
REDACTIONS = [
    (re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"), "[REDACTED_BOT_TOKEN]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED_GH_TOKEN]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b"), "[REDACTED_JWT]"),
    (re.compile(r"(?i)\b((?:api[_-]?key|token|secret|password|authorization)\b[\"']?\s*[:=]\s*[\"']?)"
                r"[^\"'\s,}]+"), r"\1[REDACTED]"),
]

ERROR_PAT = re.compile(r"error|exception|fatal|refused|timeout|ENOENT|crash|429|rate.?limit", re.I)
AGENT_LOGS = ["stdout.log", "stderr.log", "restarts.log", "crashes.log",
              "fast-checker.log", "activity.log"]
SMALL_LOGS = {"restarts.log", "crashes.log"}


def redact(text):
    for pat, rep in REDACTIONS:
        text = pat.sub(rep, text)
    return text


def read_text(p, limit=None):
    """Tail `limit` lines. Reads bytes so a truncated UTF-8 log never raises."""
    try:
        data = Path(p).read_bytes()
    except Exception as e:
        return f"<unreadable: {e}>"
    text = data.decode("utf-8", "replace")
    if limit:
        lines = text.splitlines()
        if len(lines) > limit:
            text = "\n".join(lines[-limit:])
    return text


def run(cmd, timeout=25):
    """Run a command if it exists. Windows ships pm2 as pm2.cmd, so resolve first."""
    exe = shutil.which(cmd[0])
    if not exe:
        return None
    try:
        r = subprocess.run([exe] + cmd[1:], capture_output=True, text=True,
                           timeout=timeout, encoding="utf-8", errors="replace")
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"<failed: {e}>"


def mtime(p):
    try:
        return datetime.fromtimestamp(Path(p).stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "?"


def populated(root):
    """Agent-log subdirectory count — the test for 'is this root actually in use'."""
    d = Path(root) / "logs"
    if not d.is_dir():
        return 0
    try:
        return sum(1 for x in d.iterdir() if x.is_dir())
    except Exception:
        return 0


def resolve_root(explicit):
    """
    Precedence is env > env-file > canonical > legacy, but existence is not the
    same as being in use: installs that migrated often leave an empty
    ~/.cortextos/<instance> beside a populated legacy root. Picking the empty one
    makes a healthy fleet look dead, so candidates are scored.
    """
    notes = []
    chosen, source = None, None

    if explicit:
        chosen, source = Path(explicit).expanduser(), "--root"
    elif os.environ.get("CTX_ROOT"):
        chosen, source = Path(os.environ["CTX_ROOT"]).expanduser(), "CTX_ROOT"
    else:
        for envf in (Path.cwd() / ".cortextos-env", HOME / ".cortextos-env"):
            if envf.is_file():
                m = re.search(r"^CTX_ROOT=(.+)$", envf.read_text("utf-8", "replace"), re.M)
                if m:
                    chosen, source = Path(m.group(1).strip()).expanduser(), str(envf)
                    break

    candidates = []
    ctxdir = HOME / ".cortextos"
    if ctxdir.is_dir():
        candidates += [p for p in sorted(ctxdir.iterdir()) if p.is_dir()]
    legacy = HOME / ".business-os"
    if legacy.is_dir():
        candidates.append(legacy)

    if chosen:
        if populated(chosen) == 0:
            alt = [c for c in candidates if c != chosen and populated(c) > 0]
            if alt:
                notes.append(f"{source} points at {chosen}, which has no agent logs; "
                             f"{alt[0]} looks populated (--root to inspect it)")
    else:
        scored = sorted(candidates, key=populated, reverse=True)
        if scored and populated(scored[0]) > 0:
            chosen, source = scored[0], "auto-detected"
        elif candidates:
            chosen, source = candidates[0], "fallback"

    if chosen:
        others = [str(c) for c in candidates if c != chosen and populated(c) > 0]
        if others:
            notes.append("other populated roots present: " + ", ".join(others))
    return chosen, source, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", help="single agent (default: whole fleet)")
    ap.add_argument("--root", help="runtime root override")
    ap.add_argument("--out", help="bundle directory")
    ap.add_argument("--since", default="2h", help="recorded in the summary for context")
    ap.add_argument("--lines", type=int, default=300, help="tail length for large logs")
    a = ap.parse_args()

    root, source, notes = resolve_root(a.root)
    if not root or not Path(root).is_dir():
        print("ERROR: could not resolve the runtime root.", file=sys.stderr)
        print("Set CTX_ROOT or pass --root. See references/surface-map.md section 1.",
              file=sys.stderr)
        sys.exit(1)
    root = Path(root)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # tempfile.gettempdir() resolves correctly on all three platforms; a bare
    # "/tmp" fallback does not exist on Windows.
    bundle = Path(a.out).expanduser() if a.out else \
        Path(tempfile.gettempdir()) / f"cortext-evidence-{stamp}"
    for sub in ("logs", "bus", "state", "daemon", "config"):
        (bundle / sub).mkdir(parents=True, exist_ok=True)

    def write(rel, label, body):
        p = bundle / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(f"===== {label} =====\n{redact(body or '')}\n\n")

    print(f"root:   {root}  ({source})")
    for n in notes:
        print(f"NOTE:   {n}")
    print(f"bundle: {bundle}\n")

    # ---------- agents ----------
    if a.agent:
        agents = [a.agent]
    else:
        # Directories only: logs/ also collects loose .log files from other
        # tooling, and counting those as agents produces phantom rows.
        ld = root / "logs"
        agents = sorted(x.name for x in ld.iterdir() if x.is_dir()) if ld.is_dir() else []
    if not agents:
        print("WARN: no agents found under logs/", file=sys.stderr)

    # ---------- environment ----------
    env = [f"collected:    {datetime.now()}",
           f"runtime root: {root}  ({source})",
           f"agents:       {', '.join(agents) or 'none'}",
           f"since window: {a.since}",
           f"platform:     {platform.platform()}",
           f"python:       {sys.version.split()[0]}",
           f"node:         {(run(['node', '--version']) or 'not found').strip()}"]
    for n in notes:
        env.append(f"NOTE:         {n}")
    env.append("\n--- roots present ---")
    for c in ([p for p in sorted((HOME / '.cortextos').iterdir()) if p.is_dir()]
              if (HOME / ".cortextos").is_dir() else []) + \
             ([HOME / ".business-os"] if (HOME / ".business-os").is_dir() else []):
        env.append(f"  {c}   agent-log dirs: {populated(c)}")
    try:
        du = shutil.disk_usage(root)
        env.append(f"\ndisk: {du.free // 2**30} GiB free of {du.total // 2**30} GiB")
        if du.free / du.total < 0.05:
            env.append("  WARNING: under 5% free — a common cause of write failures")
    except Exception:
        pass
    write("ENVIRONMENT.txt", "environment", "\n".join(env))

    doc = run(["cortextos", "doctor"])
    if doc:
        write("ENVIRONMENT.txt", "cortextos doctor", "\n".join(doc.splitlines()[:60]))

    # ---------- daemon + pm2 ----------
    pm2_list = run(["pm2", "list"])
    write("daemon/pm2.txt", "pm2 list", pm2_list or "<pm2 not installed or not on PATH>")
    desc = run(["pm2", "describe", "cortextos-daemon"])
    if desc:
        write("daemon/pm2.txt", "pm2 describe cortextos-daemon", "\n".join(desc.splitlines()[:40]))

    pm2_logs = HOME / ".pm2" / "logs"
    for name in ("cortextos-daemon-out.log", "cortextos-daemon-error.log"):
        f = pm2_logs / name
        if f.is_file():
            write(f"daemon/{name}.txt", f"{f}  (mtime {mtime(f)})", read_text(f, a.lines))

    out_log = pm2_logs / "cortextos-daemon-out.log"
    if out_log.is_file():
        hits = [l for l in read_text(out_log).splitlines() if ERROR_PAT.search(l)]
        write("daemon/errors-grepped.txt", "daemon-out.log error lines (last 80)",
              "\n".join(hits[-80:]) or "<none>")

    # IPC differs by platform: a Unix socket on POSIX, a named pipe on Windows.
    # A named pipe is not a filesystem object, so absence here proves nothing.
    if IS_WIN:
        write("daemon/ipc.txt", "IPC",
              r"Windows: named pipe \\.\pipe\cortextos-<instance>." "\n"
              "Not a filesystem path — cannot be stat'd. Confirm the daemon via pm2 instead.")
    else:
        sock = root / "daemon.sock"
        write("daemon/ipc.txt", "IPC",
              f"{sock}: {'present' if sock.exists() else 'MISSING'}\n"
              "A missing socket while the daemon reports online is a real inconsistency.")

    # ---------- per-agent logs ----------
    for ag in agents:
        d = root / "logs" / ag
        if not d.is_dir():
            continue
        rel = f"logs/{ag}.txt"
        inv = [f"{x.name:<24} {x.stat().st_size:>10} bytes   mtime {mtime(x)}"
               for x in sorted(d.iterdir()) if x.is_file()]
        write(rel, f"{ag}: file inventory (mtime shows when activity stopped)",
              "\n".join(inv) or "<empty>")
        for lf in AGENT_LOGS:
            f = d / lf
            if f.is_file():
                write(rel, f"{ag}/{lf}  (mtime {mtime(f)})",
                      read_text(f, 100 if lf in SMALL_LOGS else a.lines))
        cc = d / ".crash_count_today"
        if cc.is_file():
            write(rel, f"{ag}/.crash_count_today", read_text(cc))
        so = d / "stdout.log"
        if so.is_file():
            hits = [l for l in read_text(so).splitlines() if ERROR_PAT.search(l)]
            write(rel, f"{ag}/stdout.log ERROR LINES (last 40)", "\n".join(hits[-40:]) or "<none>")

    # ---------- message bus ----------
    depths = [f"{'AGENT':<22}{'INBOX':>8}{'INFLIGHT':>10}{'PROCESSED':>11}{'OUTBOX':>9}"]
    for ag in agents:
        counts = []
        for q in ("inbox", "inflight", "processed", "outbox"):
            p = root / q / ag
            counts.append(sum(1 for _ in p.iterdir()) if p.is_dir() else 0)
        depths.append(f"{ag:<22}{counts[0]:>8}{counts[1]:>10}{counts[2]:>11}{counts[3]:>9}")
    write("bus/queue-depths.txt",
          "queue depths (inflight climbing = work claimed, not finished)", "\n".join(depths))

    for ag in agents:
        rel = f"bus/{ag}.txt"
        for q in ("inbox", "inflight", "processed", "outbox"):
            p = root / q / ag
            if not p.is_dir():
                continue
            items = sorted((x for x in p.iterdir() if x.is_file()),
                           key=lambda x: x.stat().st_mtime, reverse=True)[:10]
            write(rel, f"{q}/{ag} (10 most recent)",
                  "\n".join(f"{mtime(x)}  {x.name}" for x in items) or "<empty>")
        # A stuck message is the highest-value artifact here — capture it whole.
        infl = root / "inflight" / ag
        if infl.is_dir():
            for m in sorted(infl.glob("*.json")):
                write(rel, f"STUCK INFLIGHT: {m.name}", read_text(m))

    # ---------- state + markers ----------
    for ag in agents:
        rel = f"state/{ag}.txt"
        sd = root / "state" / ag
        if sd.is_dir():
            write(rel, f"state/{ag} (markers are dotfiles)",
                  "\n".join(f"{x.name:<28} mtime {mtime(x)}" for x in sorted(sd.iterdir())) or "<empty>")
        # Heartbeat sits in one of two places depending on install age.
        for hb in (sd / "heartbeat.json", root / "state" / "heartbeat" / f"{ag}.json"):
            if hb.is_file():
                write(rel, f"heartbeat: {hb}  (mtime {mtime(hb)})", read_text(hb))

    # ---------- config ----------
    cfg = root / "config"
    if cfg.is_dir():
        write("config/inventory.txt", "config/",
              "\n".join(f"{x.name:<30} mtime {mtime(x)}" for x in sorted(cfg.iterdir())))
    ea = cfg / "enabled-agents.json"
    if ea.is_file():
        write("config/enabled-agents.txt", "enabled-agents.json", read_text(ea))

    # Malformed JSON is a common crash-loop cause and cheap to rule out.
    checks = list(cfg.glob("*.json")) if cfg.is_dir() else []
    checks += list((root / "orgs").glob("*/crons.json")) if (root / "orgs").is_dir() else []
    lines, bom_hits = ["JSON validity:"], []
    for f in checks:
        raw = f.read_bytes() if f.is_file() else b""
        if raw.startswith(b"\xef\xbb\xbf"):
            bom_hits.append(str(f))
        try:
            json.loads(raw.decode("utf-8-sig"))
            lines.append(f"  ok   {f.name}")
        except Exception as e:
            lines.append(f"  BAD  {f}  <-- {e}")
    write("config/json-validity.txt", "config json", "\n".join(lines))

    for c in ((root / "orgs").glob("*/crons.json") if (root / "orgs").is_dir() else []):
        write("config/crons.txt", str(c), read_text(c))

    # BOM check. On Windows, PowerShell and VS Code write UTF-8 with a byte-order
    # mark; the daemon parses .env with a ^-anchored regex, so a BOM on line 1
    # hides BOT_TOKEN, the Telegram poller never starts, and the agent goes
    # silent with no error anywhere. Cheap to check, painful to find by hand.
    env_bom = []
    if (root / "orgs").is_dir():
        for envf in list((root / "orgs").glob("*/agents/*/.env")) + list((root / "orgs").glob("*/.env")):
            try:
                if envf.read_bytes().startswith(b"\xef\xbb\xbf"):
                    env_bom.append(str(envf))
            except Exception:
                pass
    write("config/bom-check.txt", "UTF-8 BOM scan (.env and config json)",
          ("BOM FOUND — breaks ^-anchored parsing; agent may be silent:\n  " +
           "\n  ".join(env_bom + bom_hits)) if (env_bom or bom_hits)
          else "no BOM found in scanned .env / config files")

    recent = []
    for p in root.rglob("*.md"):
        try:
            age = (datetime.now().timestamp() - p.stat().st_mtime) / 86400
            if age <= 7:
                recent.append(f"{mtime(p)}  {p}")
        except Exception:
            pass
    write("config/recently-modified-md.txt", "behavior .md files changed in last 7 days",
          "\n".join(sorted(recent, reverse=True)[:30]) or "<none>")

    # ---------- summary ----------
    fast = ["daemon:"]
    if pm2_list:
        fast += ["  " + l for l in pm2_list.splitlines()
                 if "cortextos-daemon" in l or " name " in l][:5] or ["  (daemon not in pm2 list)"]
    else:
        fast.append("  pm2 unavailable")
    fast += ["", "queue depths:"] + ["  " + l for l in depths]
    fast.append("")
    fast.append("crash counts today:")
    any_crash = False
    for ag in agents:
        cc = root / "logs" / ag / ".crash_count_today"
        if cc.is_file():
            v = read_text(cc).strip()
            if v and not v.endswith(":0"):
                fast.append(f"  {ag}: {v}")
                any_crash = True
    if not any_crash:
        fast.append("  none")
    fast += ["", "stdout freshness (stalled mtime = stopped agent):"]
    for ag in agents:
        f = root / "logs" / ag / "stdout.log"
        if f.is_file():
            fast.append(f"  {ag}: {mtime(f)}")
    bad = [l for l in lines if l.strip().startswith("BAD")]
    fast += ["", "malformed json:"] + (["  " + b.strip() for b in bad] or ["  none"])
    if env_bom or bom_hits:
        fast += ["", "BOM detected (can silence an agent): " + str(len(env_bom + bom_hits)) + " file(s)"]

    contents = sorted(str(p.relative_to(bundle)) for p in bundle.rglob("*") if p.is_file())
    summary = "\n".join([
        "# Evidence Bundle", "",
        f"- Collected: {datetime.now()}",
        f"- Root: `{root}` ({source})",
        f"- Platform: {platform.platform()}",
        f"- Agents: {', '.join(agents) or 'none'}", "",
        *([f"- NOTE: {n}" for n in notes] + [""] if notes else []),
        "## Fast signals", "", "```", *fast, "```", "",
        "## Contents", "", "```", *contents, "```", "",
        "## Next", "",
        "Route the symptom to its surface with the table in SKILL.md Phase 2, then work",
        "the confirm/refute pairs in `references/symptom-playbooks.md`. If the machinery",
        "is healthy and the *behavior* is wrong, go to `references/behavioral-audit.md`",
        "instead. Thin or empty sections mean read by hand — see `references/surface-map.md`.",
    ])
    (bundle / "SUMMARY.md").write_text(summary, encoding="utf-8")

    print("Bundle written.\n")
    print("\n".join(fast))
    print(f"\nFull summary: {bundle / 'SUMMARY.md'}")


if __name__ == "__main__":
    main()
