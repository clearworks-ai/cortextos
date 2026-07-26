# fleet-context-diet — rollback / re-enable runbook (2026-07-25)

All diet changes are per-agent and reversible with one edit + one agent restart. No fleet bounce needed to revert a single agent.

## MCP diet (per-agent `.mcp.json`)
Each active agent has `orgs/<org>/agents/<agent>/.mcp.json` disabling the 10 global MCP servers via `{"command":"false"}`, except keep-lists (crm=mailchimp,resend; muse=+omi; larry=+railway,sequential-thinking). Own servers (ophir→monarchmoney, auditmaster→cxportal-audit) preserved.

**Re-enable ONE server for ONE agent:** remove that server's `{"command":"false"}` entry from the agent's `.mcp.json`, then `cortextos restart <agent>`. It re-inherits that server from `~/.claude.json`.

**Full revert for an agent:** each file has a sibling `.mcp.json.bak` (pre-diet state). `cp .mcp.json.bak .mcp.json && cortextos restart <agent>`.

**Watch for:** an agent reaching for a tool it lost (e.g. larry needing codebase-memory-mcp or filesystem MCP for a code op — note built-in Read/Write/Edit are NOT MCP and always remain). If it hits a missing `mcp__<server>__*`, re-enable that one server.

## Plugin diet (per-agent `.claude/settings.json` `enabledPlugins`)
8 heavy design/planning plugins disabled fleet-wide (frontend-design, playwright, ui-ux-pro-max, visual-explainer, superpowers, impeccable, planning-with-files, context-mode). larry keeps context7 enabled.
**Re-enable:** set the plugin key to `true` in the agent's `enabledPlugins`, restart that agent.

## Verification
`python3 bin/verify-fleet-context.py snapshot <label>` then `diff <baseline> <label>` — proves mcp-reinjection + floor deltas per agent. `/tmp/fleet-ctx-baseline.json` is the pre-diet reference.
Authoritative per-agent check that a server is actually gone: grep the agent's newest transcript for `mcp__<server>__` (fable proved `claude mcp list` gives a false "connected" and cannot be trusted for this).

## PTY fix (the crash/flap root — PR #811)
If the daemon ever throws `Cannot find module '.../dist/pty-host-entry.js'`, the pty-host path resolution regressed — the leak fix is off and agents will fail to spawn (daemon ptmx reads 0 because there are NO ptys, a false "healthy"). Rebuild from a branch containing PR #811 and bounce. Verify by BOTH: agents `running` in `cortextos status` AND `lsof -p <daemon> | grep -c ptmx` staying ~0 WHILE `ps aux | grep -c pty-host-entry` is >0.
