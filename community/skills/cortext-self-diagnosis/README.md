# cortext-self-diagnosis

A cortextOS community skill that teaches an agent to debug the framework it is
running inside — and, separately, to audit the instructions that shape its own
behavior.

## Install

Copy this directory into your cortextOS checkout:

```bash
# Linux / macOS
cp -r cortext-self-diagnosis <your-cortextos>/community/skills/
chmod +x <your-cortextos>/community/skills/cortext-self-diagnosis/scripts/*
```

```powershell
# Windows PowerShell — no chmod needed; invoke the scripts with `python`
Copy-Item -Recurse cortext-self-diagnosis <your-cortextos>\community\skills\
```

The scripts are always invoked as `python3 scripts/<name>.py` (or `python` on
Windows), so the executable bit is a convenience rather than a requirement.

To make it available for distribution, add an entry to
`community/catalog.json`:

```json
{
  "name": "cortext-self-diagnosis",
  "description": "Evidence-first diagnosis of the cortextOS framework itself",
  "author": "cortextos",
  "type": "skill",
  "version": "1.1.0",
  "tags": ["debugging", "diagnostics", "troubleshooting", "logs", "daemon"],
  "review_status": "approved",
  "dependencies": [],
  "install_path": "community/skills/cortext-self-diagnosis",
  "submitted_at": "2026-08-19T00:00:00Z"
}
```

## What triggers it

Two distinct investigations, routed by symptom:

**Infrastructure** — an agent gone silent or wedged, crash loops, messages that
never arrive, crons that did not fire, an agent that re-onboards or shows offline
while running, a dead daemon, a downed fleet.

**Behavior** — nothing crashed, but the agent ignores instructions, picks the
wrong skill, acts over-cautious, forgets things, drifts off-voice, or two agents
diverge from identical setup. This routes to `references/behavioral-audit.md`,
which audits the instruction surface rather than the logs.

For stale tasks, stale goals, or workload health, use `system-diagnostics`
instead. That skill covers the work; this one covers the machinery.

## Layout

```
SKILL.md                          the spine — phases, routing, UX rules
references/surface-map.md         every diagnostic surface and how to read it
references/symptom-playbooks.md   playbooks with confirm/refute evidence
references/behavioral-audit.md    instruction-surface audit (behavior only)
references/upstream-pr.md         branch, fix, PII gate, approval, PR
references/test-matrix.md         four-phase verification matrix
scripts/collect_evidence.py       snapshot every runtime surface (read-only)
scripts/audit_instructions.py     inventory the instruction surface (read-only)
scripts/pr_gate.py                scan a diff before anything is published
```

Only `SKILL.md` loads when the skill triggers; references are pulled in as an
investigation calls for them.

## Requirements

Python 3 only — standard library, no packages to install. `pm2`, `git`, and the
`cortextos` CLI are used when present and degraded around when absent.

The runtime root resolves `CTX_ROOT`, then `.cortextos-env`, then
`~/.cortextos/<instance>/`, then the legacy `~/.business-os/` root — preferring
whichever actually holds agent data, since migrated installs often keep an empty
canonical root beside a populated legacy one.

`collect_evidence.py` and `audit_instructions.py` are strictly read-only.
Nothing in this skill restarts, edits, or deletes anything on its own.

## Platform support

All three scripts run identically on **Linux, macOS, and Windows**. Where the
platforms genuinely differ, the skill knows about it — see
`references/surface-map.md` §9:

- **IPC** is a Unix socket on POSIX and a named pipe on Windows, so "the socket
  is missing" is not evidence of anything on Windows.
- **`pm2 startup` does not work on Windows.** A dead fleet after reboot is the
  expected state there unless the "PM2 Resurrect" Scheduled Task was registered.
- **UTF-8 BOM in `.env`** is a Windows-only, silent failure: it hides
  `BOT_TOKEN`, the Telegram poller never starts, and the agent goes quiet with no
  error in any log. `collect_evidence.py` scans for this specifically.
- **`node-pty` build tooling** differs per platform; `cortextos doctor` prints
  the right fix.

Documentation examples are written for Linux and macOS, with a PowerShell
translation table in `surface-map.md` §9.

## The one boundary that matters

Nothing leaves the machine without explicit human approval. A clean PII gate and
a green test matrix are what make it reasonable to *ask* about a fork push or an
upstream PR — they are never permission on their own. See `references/upstream-pr.md`
section 6.
