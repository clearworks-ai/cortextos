# SESSION HANDOFF — Claude-in-cortextos (frank2 main-thread)
_Last updated: 2026-07-31 18:48 PDT (01:48Z Aug 1). Author: frank2 main session b2985966._

> Read this first when Claude opens in this repo. It is a snapshot of live runtime
> state — treat every "X is running/merged/live" claim as a HYPOTHESIS to re-verify
> (mutable-fact rule), not truth. Re-check with the commands noted before acting.

---

## THE GOVERNING WORK: Master Build Plan v9 (FROZEN, executing)

Building Josh's unified knowledge/agent system. Plan + decisions FROZEN, do NOT
re-litigate. Canonical artifacts:
- `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/` — `MASTER-BUILD-PLAN.md`(+.html v9), `DECISIONS-FOR-JOSH.md`, `OUR-SYSTEM-PLAN.md`, `BUILD-PROGRESS.md` (larry's live ledger)
- Diagram: `orgs/clearworksai/agents/frank2/deliverables/clearworks-system-v9.{html,png}`
- Memory: `project_system_plan_v9_decided_2026-07-31.md` (all 5 decisions D1-D5 DECIDED)

**Pipeline:** larry plans (Fable-5 HIGH default) → codexer implements (opencode + GLM-4.7 runtime).
Main thread SUPERVISES + surfaces [HUMAN GATE]s. Does NOT write code directly.

**Phase state (verify via `gh pr list --repo clearworks-ai/cortextos`):**
- P0 DONE — 7 fork PRs merged incl #172 (re-baseline→main), 3 closed-superseded.
- **P1.0 outputs-router — PR #187 OPEN** (`feature/p1-0-outputs-router`). Router now at repo-root `orgs/clearworksai/skills/outputs-router/` (file_output.py + SKILL.md). Content correct: content-type→knowledge-sync taxonomy + frontmatter provenance.
- **P1.1 kb-reconcile — PR #188 OPEN** (`feature/p1-1-kb-reconcile-cron`).
- P2-P7 pending.

---

## OPEN THREADS / CLEANUP (do these)

1. **Stray nested build dir STILL PRESENT** — `orgs/clearworksai/agents/codexer/orgs/clearworksai/` (a whole `orgs/` tree wrongly created under codexer's agent home). Larry said cleaning; verify + `rm -rf` if the real router at repo-root is confirmed good. Also a literal `~` dir codexer created (tilde-not-expanded) — check `ls orgs/clearworksai/agents/codexer/` for a `~` entry, remove.
2. **codexer task_1785526171431_09657213 = `blocked` (01:03Z)** — was P1.0. Now that #187 is open, confirm it's intentionally blocked/done vs stuck. Check codexer heartbeat + opencode proc before any restart.
3. **PRs #187 + #188 need review→merge** — Josh gates main merges (never auto-merge to main). Surface for his go.
4. **Fleet redeploy [HUMAN GATE] pending** — live daemon dist predates the P0 merges. Rebuild + Josh-gated `pm2 restart` (override marker `/tmp/josh-approved-daemon-restart-YYYYMMDDHH`). Rollback: `dist.pre-rebaseline-bak`.

---

## THE CODEXER ROOT-CAUSE (durable — will recur otherwise)

codexer's opencode runtime runs with **cwd = its agent home** (`orgs/clearworksai/agents/codexer`),
NOT repo root. So bare repo-relative spec paths resolve wrong (buried under agent dir), and a
raw `~` won't expand. LOCKED FIX (told larry, apply to every spec):
1. All target paths ABSOLUTE (`/Users/joshweiss/code/cortextos/...`, `/Users/joshweiss/code/knowledge-sync/...`) — never bare-relative, never `~`.
2. Final spec step = assert artifact exists at EXACT absolute target before marking done.
3. codexer runs autonomous — NO "awaiting confirmation" pauses in an unattended loop.

**Watch for confabulation:** larry twice invented a tidy story ("already shipped 3d ago, codexer
duplicating") to explain a miss; receipts (zero git history, no merged PRs) disproved it, larry
walked it back. Verify agent status claims against `gh pr list --state merged` + `git ls-files`,
not the agent's narrative.

---

## SIDE TASK IN FLIGHT (paused — Fable hit weekly limit)

**Cross-org abstraction analysis** — how much of the 137 Altari jobs + skills + the 6-pillar
pattern generalizes from agency-only to any modern business/nonprofit, grounded on our 5 real
audit orgs. Fable subagent dispatched but **hit weekly usage limit (resets Aug 3 7am PT)** —
produced nothing. RE-RUN after reset. Full prompt spec is in this session transcript; output
target `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/CROSS-ORG-ABSTRACTION-ANALYSIS.md`.

**5 audit-deliverable orgs** (all under `orgs/clearworksai/agents/auditmaster/deliverables/<client>/`,
all have full MD sources — never read the PDFs, they're rendered output):
- studio-pch (creative studio) · msia (nonprofit) · rrk (nonprofit/environmental) · alloi (construction-tech) · ocg (investment/investor-onboarding; MD sources under `ocg/report/*.md`)
- MSIA gotcha: `_SENSITIVE-*` / `_RATES-*` files are internal-only, never client-facing. MSIA has multiple branded PDF versions — `99pp-20260709` is newest.

---

## HARD RULES (this repo)
- NEVER commit/push to main directly. Josh approves all main merges. `gh pr create --repo clearworks-ai/cortextos` (defaults to upstream grandamenium otherwise).
- Branch name must == pipeline slug (PR-gate derives slug from branch).
- No pm2 daemon restart without `/tmp/josh-approved-daemon-restart-*` marker.
- Josh works from his PHONE — deliver Josh-facing docs as Google Docs, never local file paths.
- Supervision cadence: report to Josh ONLY on gate / real stall / quality-fail. Silent otherwise.
