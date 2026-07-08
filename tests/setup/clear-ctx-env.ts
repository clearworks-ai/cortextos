// Neutralize live-agent-shell env leakage so tests never inherit CTX_* paths
// that trip the sandbox/live isolation guard in src/utils/env.ts. This fixes
// the TEST harness only — the CLI guard itself must stay strict.
for (const k of ['CTX_AGENT_DIR', 'CTX_PROJECT_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_ROOT', 'CTX_INSTANCE_ID']) {
  delete process.env[k];
}
