# 01-research — cron-register-reliability

Authoritative root-cause: `orgs/clearworksai/agents/auditmaster/deliverables/CRON-REGISTER-ROOTCAUSE.md`
(auditmaster, verified file:line chain). Summary: `add-cron` writes crons.json then fires a
fire-and-forget IPC reload with three silent-failure points and zero verification; the scheduler's
tick loop never re-reads the file despite two code comments claiming a "30s tick" pickup; agents
"verify" with file-only `list-crons` and report success for crons that will never fire. All line
numbers below re-confirmed against the working tree on 2026-07-25.

## Confirmed findings (quoted from source)

**FP1 — CLI swallows the reload result. `src/cli/bus.ts:3544-3549`:**
```ts
async function signalCronReload(agentName: string, instanceId: string): Promise<void> {
  try {
    const ipc = new IPCClient(instanceId);
    await ipc.send({ type: 'reload-crons', agent: agentName, source: 'cortextos bus cron-cmd' });
  } catch { /* non-fatal — scheduler picks up file change on next 30s tick */ }
}
```
Return type `void`; `await ipc.send(...)` response discarded; the comment is FALSE (no tick
re-read exists). Unconditional success print at `bus.ts:3594-3595`:
```ts
    await signalCronReload(agent, env.instanceId);
    console.log(`Added cron '${name}' for ${agent}`);
```
Also called result-blind at `bus.ts:3616` (remove-cron) and `bus.ts:4005` (update-cron).
Note: `IPCClient.send` (`src/daemon/ipc-server.ts:887-896`) RESOLVES
`{success:false, error:'Daemon is not running…'}` on ECONNREFUSED/ENOENT — not even an
exception — so the discard hides both the timeout path and the daemon-down path.

**FP2 — daemon handler always replies success. `src/daemon/ipc-server.ts:722-733`:**
```ts
        case 'reload-crons': {
          const agentToReload = request.agent;
          if (!agentToReload) {
            response = { success: false, error: 'reload-crons requires agent name' };
          } else {
            // crons.json was already written atomically by the CLI — acknowledge the reload.
            // CronScheduler picks up the change on its next 30s tick.
            this.agentManager.reloadCrons(agentToReload);
            response = { success: true, data: `Crons reloaded for ${agentToReload}` };
          }
```
`agentManager.reloadCrons()` (`src/daemon/agent-manager.ts:1278-1302`) DOES return a boolean
(false when agent unregistered) — the handler discards it. The "next 30s tick" comment at
727-728 is the second copy of the false claim. `reloadCrons` is also called result-blind at
`ipc-server.ts:799, 814, 828`.

**No tick re-read. `src/daemon/cron-scheduler.ts`:** `loadCrons()` is called ONLY at
`start()` (line 289) and `reload()` (line 323). `tick()` (line 464) iterates only
`this.scheduled`:
```ts
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [name, sc] of this.scheduled) {
      if (sc.nextFireAt > now) { continue; }
```
`TICK_INTERVAL_MS = 30_000` (line 268). `getNextFireTimes()` exists (lines ~330-337), returns
`Array<{name, nextFireAt}>` — currently not exposed over IPC.

**FP3 — instance-dir split.** `src/bus/crons.ts:42-45`:
```ts
function cronsFilePath(agentName: string): string {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  return join(ctxRoot, CRONS_DIRECTORY, agentName, CRONS_FILENAME);
}
```
`src/utils/env.ts:39-49`: instanceId = overrides → `CTX_INSTANCE_ID` env → `.cortextos-env`
file → `resolveActiveInstance('default')`; ctxRoot defaults to `~/.cortextos/{instanceId}`.
Marker `~/.cortextos/state/ACTIVE_INSTANCE` currently reads `cortextos1`, but any shell/agent
with a stale `CTX_INSTANCE_ID=default` (env var or env file) writes to the dead tree AND
signals the dead socket (ENOENT → resolved as success:false → discarded). Field proof: 13
orphaned `~/.cortextos/default/.cortextOS/state/agents/*/crons.json` files exist right now
(alice, auditmaster, automator, codexer, crm, frank2, hunter, larry, maven, muse, …).
`ensureCtxRootEnv` (`bus.ts:159-163`) is a no-op when CTX_ROOT is already set — even to the
wrong instance.

**Scope-A surface — in-memory cron creation.** Template settings.json allowlists do NOT
contain CronCreate, and `templates/agent/CLAUDE.md:27,146` already teach against it. But
`bus fix-agent-settings` REQUIRED_ALLOW (`bus.ts:4605-4611`) re-injects it fleet-wide:
```ts
    const REQUIRED_ALLOW = [
      'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      'ToolSearch', 'CronCreate', 'CronList', 'CronDelete', 'Skill', 'Agent',
    ];
```
`cron-teaching-scanner` (`src/utils/cron-teaching-scanner.ts`, CLI `bus cron-teaching` at
`bus.ts:4195`) already exists to find stale CronCreate//loop teaching — reuse it. Residual
CronCreate mentions live in `templates/*/CLAUDE.md`, `AGENTS.md`, `ONBOARDING.md`, and
`templates/*/.claude/skills/{agent-management,cron-management,guardrails-reference}/SKILL.md`.

**Scope-C surface — fast-checker.** `src/daemon/fast-checker.ts` (1894 lines): `FastChecker`
class, 1s `pollCycle()`, existing restart machinery (`sessionRefresh()`, loop-stall circuit
breaker at ~1311-1322 — 3 restarts/15min trips a 30min pause). Already has
`getLastCronFireAt()` (~1186-1192) reading cron-state.json and `getLastProgressAt()`. This is
the extension point — NOT a new launchd agent. (The `core/scripts/fast-checker.sh` named in
frank-reliability-fixes.md is the legacy shell ancestor; the TS class replaced it —
header comment at fast-checker.ts:124 "Replaces fast-checker.sh".)

**Scope-D surface — kb-job-run.** `bus.ts:2392` `.command('kb-job-run')`, `bus.ts:2404`
`.allowUnknownOption(true)` — `.allowExcessArguments(true)` is missing, so excess positional
args after the wrapped command error out in commander v13+.

**D-hang suspect (documented, follow-up).** `src/pty/agent-pty.ts:64-66` still lazy-requires
node-pty in-process:
```ts
    if (!this.spawnFn) {
      const nodePty = require('node-pty');
      this.spawnFn = nodePty.spawn;
    }
```
and spawns at line 137 (`this.pty = this.spawnFn!(claudeCmd, claudeArgs, …)`).
`src/pty/pty-host-client.ts` / `pty-host-entry.ts` exist but the client is imported nowhere on
the spawn path (matches memory incident `incident_pty_leak_fix_never_on_spawn_path_2026-07-25`;
branch `fix/pty-host-wire-agent-pty` is already open for this). Out of this OBF's build scope.
