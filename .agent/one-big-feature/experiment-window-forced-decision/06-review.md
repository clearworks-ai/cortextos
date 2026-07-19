# Review — experiment-window-forced-decision

**Verdict: PASS**

Adversarial review of `04-review-packet.diff` against spec §Guardrails. Each guardrail checked below with file:line references (diff line context in parens).

- **No `any`** — PASS. No `any` in any changed file. `catch (err)` blocks narrow via `err instanceof Error ? err.message : String(err)` (experiment-sweep.ts none; reconcile-trigger.ts:319,344; experiment.ts uses typed `Experiment`). Sweep interfaces use concrete union/`string|null`/`number` types.
- **No `console.log` in library/daemon code** — PASS. `src/bus/experiment-sweep.ts` and `src/bus/experiment.ts` have zero console calls. `src/daemon/reconcile-trigger.ts` uses only `console.error` for swallowed errors (diff L318, L343). `src/cli/bus.ts` uses `console.log` only inside the CLI `.action()` output (diff L257,L260) — allowed per spec §File 5.
- **Additive-only Experiment JSON** — PASS. `window_flagged_at?: string | null` appended after `changes_description` on the interface (experiment.ts:28 / diff L116) as optional. NOT added to the `createExperiment` object literal (verified src/bus/experiment.ts:165–185 — field absent), so existing history lacking the field parses fine.
- **Injectable clock** — PASS. `sweepExperiments` uses `const now = opts?.now ?? Date.now();` (experiment-sweep.ts / diff L60). Flag timestamp derives from injected `now`: `new Date(now).toISOString()...` (diff L94). All 6 tests pass explicit `now` (tests/experiment-sweep.test.ts). `autoCloseExpiredExperiment` uses `nowISO()` for `completed_at`, consistent with `evaluateExperiment`.
- **Idempotent — flag gated by window_flagged_at** — PASS. Grace-window branch: `if (experiment.window_flagged_at) continue;` before pushing a `flag` action (diff L82). Test 1 asserts second sweep returns `[]` and `window_flagged_at` unchanged.
- **Idempotent — autoclose flips status out of running** — PASS. `autoCloseExpiredExperiment` sets `status='completed'` (diff L153) with a `status !== 'running'` guard (diff L149–151). Re-sweep filters via `listExperiments(..., { status: 'running' })` (diff L62). Test 2 asserts second sweep returns `[]`.
- **skip-unparseable never mutates** — PASS. On `Number.isNaN(windowMs)` the action is pushed and `continue` runs before any expiry/mutation logic (diff L67–72). The apply loop (diff L90–104) only handles `flag`/`autoclose`; skip-unparseable has no branch, so no mutation occurs even when `dryRun` is false. Test 3 confirms `status==='running'`, no `window_flagged_at`, `decision` unchanged.
- **Never auto-close on unparseable window** — PASS. Unparseable path short-circuits before the expiry comparison that leads to `autoclose` (diff L67–72). No autoclose reachable for NaN windowMs.
- **results.tsv column order matches evaluateExperiment** — PASS. `autoCloseExpiredExperiment` header (diff L169) and row order (diff L173–182): experiment_id, agent, metric, measured_value(''), baseline(`String(experiment.baseline_value)`), decision('discard'), hypothesis, timestamp(`completed_at`) — byte-identical column order to evaluateExperiment (verified src/bus/experiment.ts:315,319–328). measured_value is empty string per spec; baseline uses `String(experiment.baseline_value)`.
- **Exactly the 6 enumerated tests present** — PASS. tests/experiment-sweep.test.ts has exactly 6 `it(...)` blocks mapping 1:1 to spec cases: flag+idempotent, autoclose+idempotent+fields, skip-unparseable, not-yet-expired, proposed/completed ignored, dryRun mutates nothing. No extra/missing cases.

**Additional spec-conformance spot checks (not core guardrails):**
- Auto-close reason string built in the sweep and passed to `autoCloseExpiredExperiment` (diff L97–101) matches EXACT spec format with `ageHrs = Math.round(ageMs/3_600_000)`.
- I/O helpers `loadExperiment`/`saveExperiment` exported (diff L124,L133); sweep imports them + `autoCloseExpiredExperiment` from `./experiment.js`, no duplicate I/O, no daemon/event imports.
- `DeclaredAgent.dir?` added (diff L223); `gatherDeclaredAgents` pushes `dir` (diff L282); daemon wiring after `runDueSweep` in own try/catch (diff L291–297).
- CLI `--grace` NaN falls back to undefined (diff L253–254); `--apply` wins over default dry-run (diff L255).
