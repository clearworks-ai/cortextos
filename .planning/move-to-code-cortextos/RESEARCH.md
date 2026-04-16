# RESEARCH — What references the current framework path

## Method
`grep -rln "/Users/joshweiss/cortextos"` across the framework tree and `~/.cortextos/`, excluding node_modules, dist/, log files, and the socket.

## Active hardcoded paths (MUST rewrite)

### 1. `ecosystem.config.js` (5 lines)
```
line 11:  script: "/Users/joshweiss/cortextos/dist/daemon.js"
line 13:  cwd: "/Users/joshweiss/cortextos"
line 17:  env.CTX_FRAMEWORK_ROOT: "/Users/joshweiss/cortextos"
line 18:  env.CTX_PROJECT_ROOT: "/Users/joshweiss/cortextos"
line 29:  dashboard cwd: "/Users/joshweiss/cortextos/dashboard"
```
All must become `/Users/joshweiss/code/cortextos/...`.

### 2. `~/.cortextos/cortextos1/dashboard.env` and `~/.cortextos/default/dashboard.env`
Need inspection — likely contain CTX_FRAMEWORK_ROOT. Rewrite both.

### 3. PM2 process registry (in-memory + `~/.pm2/dump.pm2`)
PM2 caches cwd. A `pm2 delete ... && pm2 start ecosystem.config.js` is required — `pm2 restart` alone will not re-read the cwd.

### 4. Global npm symlink `/opt/homebrew/bin/cortextos`
Points at `../lib/node_modules/cortextos/dist/cli.js`. This is from `npm install -g` and is unaffected by moving the source tree. After the move, `npm unlink -g cortextos` then `npm install -g .` in the new location re-links to the new source — safer than leaving the old symlink.

### 5. Agent configs under `orgs/clearworksai/agents/*/config.json`
`working_directory` fields point at `~/code/auditos` etc. These are the REPOS the agents operate on, NOT framework paths. They stay unchanged.

### 6. `~/.cortextos/` runtime state
No framework-path references inside config (only log history, which is historical and fine). Stays put.

## Inactive references (ignore)

- Log files under `~/.cortextos/*/logs/*/stdout.log` — historical, will roll
- `inbound-messages.jsonl` — historical message bodies
- `dashboard/.next/` build artifact — regenerated on next build
- Processed inbox files — historical

## What depends on git remote / GitHub

- `origin` = `grandamenium/cortextos.git` (upstream)
- `fork` = `clearworks-ai/cortextos.git` (what Josh pushes to)
- `.git/` moves with the dir — no remote changes needed.

## PM2 startup hooks

Check if PM2 is configured for startup (launchd on macOS):
```
launchctl list | grep pm2
```
If yes, the launchd plist references the pm2 dump file path — that path is in `~/.pm2/`, unaffected by the move. But the dump content still caches old cwd, so step 3 above matters.

## Running state at move time

- `cortextos-daemon` (pm2) — owns all agent PTYs. Restart = all agents die cleanly and respawn.
- `cortextos-dashboard` (pm2) — Next.js, stateless aside from the SQLite file under `~/.cortextos/*/dashboard.db`.
- Agents (auditos, frank2, sage, maven) — Claude Code subprocesses under daemon PTY. They have active transcripts under `~/.claude/projects/`.

## Time estimate

- Preparation (verify commit clean, freeze writes): 5 min
- Move + path rewrites: 10 min
- PM2 restart + npm re-link: 3 min
- Smoke test all 4 agents + dashboard: 10 min
- Rollback plan on standby: symlink `~/cortextos` → `~/code/cortextos` if anything external breaks.

**Total planned outage: ~15 min.**
