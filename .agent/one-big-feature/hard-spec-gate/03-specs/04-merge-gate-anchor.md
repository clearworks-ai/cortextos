# Spec 04 — Gate-machinery review protection (CODEOWNERS + branch protection)

> Source: `../04-verify-round1-hardening.md` — verify round 2 REVERSED the round-1 design of this
> spec. Read this header before anything else in this file.
> Regenerated 2026-07-12Z by the pipeline PLAN stage-runner.

## What this spec is — and explicitly is NOT

**IS:** a lightweight, proposal-side review lock on the gate-machinery files. Any PR that changes
the gate code must be reviewed by Josh before it can merge — the same authority that already
guards every merge to `main`.

**IS NOT:** a runtime privilege boundary, an enforcement anchor, or any part of the day-to-day
dispatch gate. Enforcement lives at the dispatch sink (`src/bus/message.ts`, Spec 02 §6), which
fires BEFORE any code is written. This spec only makes changes to that machinery visible and
Josh-reviewed on their way into the repo.

## Decision history (why this file is small)

- **Round 1** proposed anchoring HOLE 1 ("the agent can edit its own hook source / secret") at the
  GitHub merge gate + deploy-from-merged-main.
- **Round 2 (Josh):** *"that means you would do all the coding up to the merge before you were
  gated. This is ridiculous."* Correct — a merge anchor gates SHIPPING, not PROGRAMMING; all
  ungated work happens pre-merge. Enforcement moved to the dispatch sink (Spec 02 §6).
- **Round 2 also considered** making the gate code itself agent-unwritable at runtime: a separate
  OS user / container / pinned deploy-worktree executing only merged `main`. **Josh REJECTED this
  as disproportionate over-engineering** ("months of troubleshooting"). The threat model is the
  LAZY agent taking a shortcut a weak gate permits — not a MALICIOUS agent rewriting its own hook
  source. The self-edit hole is theoretical and has never been hit.
- **Settled posture:** belt the theoretical hole cheaply with git-visibility (this spec) + the
  nightly audit's advisory scan (Spec 03: any mtime change to hooks/settings/emitter/sink sources
  in the trailing 24h is flagged), and spend zero effort on an OS boundary. The
  separate-user/container/deploy-worktree path is documented here as **considered and rejected**
  so it is not re-proposed.

## The mechanism (both halves required — CODEOWNERS is inert without branch protection)

### 1. `.github/CODEOWNERS` (NEW)

```
# Gate machinery — Josh reviews any change (proposal-side lock, not runtime enforcement)
/orgs/clearworksai/agents/larry/.claude/hooks/           @grandamenium
/orgs/clearworksai/agents/larry/.claude/settings.json    @grandamenium
/bin/pipeline-stage-emit                                 @grandamenium
/bin/pipeline-provision-secret                           @grandamenium
/src/pipeline/                                           @grandamenium
/src/bus/message.ts                                      @grandamenium
```

(Owner handle = Josh's GitHub login; confirm exact login at apply time. The signing secret itself
is never committed; only its provisioning script is owned.)

### 2. Branch-protection rule on `main` (Josh applies in GitHub repo settings — an agent has no
token to set this): require PR, require review from Code Owners, dismiss stale approvals, no
force-push, no direct push. Larry already cannot push to main; this adds that changes to the gate
machinery ITSELF need Josh's explicit review, not just any green PR.

## What this buys, honestly stated

- A weakening of the gates cannot LAND in the repo without Josh reading the diff. Combined with
  the nightly advisory scan (Spec 03), a local, unmerged edit to a hook or the emitter is flagged
  within 24h even though nothing prevents it at runtime.
- It does NOT prevent a locally-edited hook from running before merge — by decision. The
  authoritative dispatch gate (the sink + the HMAC ledger + HOLE-3 provenance) is compiled daemon
  code whose weakening requires exactly the kind of deliberate multi-step effort that is out of
  the lazy-agent threat model, and whose diff this spec makes Josh-reviewed and whose local
  modification the audit makes visible.

## Acceptance criteria

1. `.github/CODEOWNERS` present with the paths above; a test PR touching
   `gate-codexer-planning.sh` shows the "Review required from code owners" block and cannot merge
   without Josh's review.
2. Branch protection on `main` requires code-owner review (Josh confirms in settings; screenshot
   in evidence).
3. This file and `LARRY/PIPELINE.md` both state plainly that there is NO runtime privilege
   boundary and that the separate-user/deploy-worktree design was considered and rejected
   (verify round 2) — so the decision is durable and not re-litigated.

## Out of scope

- Separate OS user, container, or pinned deploy-worktree execution — REJECTED, see decision
  history. Do not build.
- Multi-machine / hosted fleet deploy. If the fleet later moves to a hosted platform,
  deploy-from-merged-main is the platform default and arrives free — note for the
  productize-cortext track, not this build.
