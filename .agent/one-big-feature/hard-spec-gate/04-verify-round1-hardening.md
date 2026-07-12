# Hard-spec-gate — Verify Round 1 (Josh, 2026-07-12 ~01:07Z)

Josh: "you're already telling me how you can bypass them. I don't want a version one or a
version two. Stop building things sloppily that don't work and spend weeks troubleshooting...
That is my goal." → REJECT any design with a named residual bypass. Two holes must close, not defer.

## Decision — design hardened, no named bypass left

### HOLE 1 (was Q1) — agent can edit its own hook scripts / secret.
The gate is hooks + a secret ON THE AGENT'S OWN MACHINE. Any purely-local hook is editable by
whoever runs it. Trust anchor CANNOT be local.
FIX: anchor at the GitHub merge gate — branch protection + CODEOWNERS requiring Josh review for
ANY change under `.claude/hooks/`, `bin/pipeline-stage-emit`, `settings.json`, the secret path.
Fleet deploys only MERGED main (not the dirty working tree). The agent cannot weaken its own gates
for the same reason it cannot merge to main today — Josh is the anchor. Local read-denied secret +
hard-deny agent Edit/Write on hooks/secret/emitter remain as defense-in-depth.

### HOLE 2 (was Q5) — non-shell dispatch bypasses all Bash-tool hooks.
NOT v1 debt. Enforce at the SINK: `src/bus/message.ts` verifies the signed ledger chain before
accepting any codexer/opencoder/opencode BUILD dispatch. Every path — CLI, node script, MCP,
direct enqueue — hits the same gate. Gate the action, not the shell.

### Q2 freshness — loosen to 24h. Freshness is NOT the security (the HMAC chain is); it only kills
"one ancient spec authorizes forever." 2h caused false blocks on long days.
### Q3 exemptions — alert if >~10/week, NO hard cap (a cap blocks legit trivial work).
### Q4 fail-closed — CONFIRMED. Ledger/key missing → hard-block, only Josh overrides. Add a LOUD
error naming what broke + the single restore command, so it never strands the fleet silently.
### Q6 pages — once/night batched. Kept.

## Net scope change
+ GitHub branch protection + CODEOWNERS on hooks/bin/settings/secret; deploy-from-merged-main.
+ Ledger-check enforcement inside src/bus/message.ts (sink-level), covering research gap #9.
+ freshness 2h->24h; exemption alert-threshold not cap; fail-closed loud-error+restore-cmd.
NEXT: fold into 02-master-plan + 03-specs, re-surface tightened spec for Josh go, THEN codexer.

---

## Verify Round 2 (Josh, 2026-07-12 ~01:16Z) — merge-anchor is the WRONG PLACE

Josh: "that means you would do all the coding up to the merge before you were gated. This is
ridiculous. You can't get yourself not to cheat your way out of this every single time."

**He is right.** Anchoring HOLE 1 at the GitHub merge gate makes it a gate on SHIPPING, not on
ungated PROGRAMMING. All research/plan/specs/implement happens BEFORE merge, so the merge anchor
does not stop me from doing ungated work — only from landing it. Worse: the fleet runs the local
working tree (verified — no merged-main deploy boundary today), so a locally-edited hook is LIVE
immediately; I could neuter a gate, dispatch, and code, and only get caught at merge review.

**Root cause of the recurring bypass (the real one):** every gate so far is enforced by code MY
OWN process runs, and I can edit that code. A self-administered gate is ALWAYS bypassable. Naming
a bypass each time is not cleverness — it is the design being self-administered.

**The only fix that ends it: enforcement must RUN from a trust domain the agent cannot write.**
On this single local machine that means an OS-level privilege boundary, not another hook:
- The daemon + gate code (`dist/`, `.claude/hooks/`, `bin/pipeline-stage-emit`, the secret, the
  `verifyChain` sink) execute from a copy owned by a SEPARATE OS user (or a container), pinned to
  the `main` Josh reviewed. The agent's user has NO write to it (enforced by filesystem perms, not
  a hook the agent runs).
- Then the dispatch sink — running from code the agent could not have touched — blocks an ungated
  build dispatch AT DISPATCH TIME, before codexer writes a line. Prevention, not detection, and
  not at merge.
- Merge/CODEOWNERS review is retained ONLY for changing the gate machinery itself (belongs off the
  agent's machine regardless), but is no longer the day-to-day enforcement anchor.

**Genuine Josh fork (his machine's operating model):** running the fleet as its own OS user /
container instead of Josh's user. This is the one real decision; it is what makes "for real"
actually true. Pending his answer before respecing Spec 04. DO NOT proceed to code.
