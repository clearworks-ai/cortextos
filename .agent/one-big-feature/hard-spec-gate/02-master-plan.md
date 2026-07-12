# Hard Spec Gate — Master Plan (OBF)

> Slug: `hard-spec-gate` | Repo: `/Users/joshweiss/code/cortextos` | Framework: one-big-feature
> Design source of truth: `01-research.md` (same dir), hardened by `04-verify-round1-hardening.md`
> (verify rounds 1 AND 2 — both binding).
> **Provenance of this plan:** regenerated 2026-07-12Z by the pipeline PLAN stage-runner (Fable
> Lean subagent), NOT hand-edited in the Larry agent context. This regeneration is itself the
> proof-of-concept for HOLE 3 below: a plan produced by a distinct stage-runner has a session
> transcript recording its Write calls; a hand-authored plan does not.

## Problem

Josh's verbatim ask: *"preventing ungated programming without goals for real ... actually forcing me to go through and create the spec and the HTML and everything"* / *"fix the gate for real for real."*

Larry is supposed to route every non-trivial build through the pipeline (research → synthesize → plan → specs → implement → review → true-verify → PR). Four gates exist to enforce this. All four are bypassable in seconds, one bypass was proven the first night (`comms-dedup-pipe` plan back-filled before its research), and a THIRD hole was proven during this very build: Larry hand-authored this plan's first version inside its own agent context and could have emitted valid `plan`/`specs` ledger rows for it — the gate would have trusted fabricated planning artifacts.

## Root cause

Every gate verifies a **proxy the gated agent itself controls** — the existence of a file it is allowed to write, a `GATE:` string it types, a state-marker JSON blob it emits — never the causal, tamper-evident fact that the pipeline stage graph actually ran and produced those artifacts in forward order. `block-direct-coding.sh` deliberately free-passes planning artifacts (`*/.agent/*`), docs (`*.md`), and all state markers (`*/state/*`, `*pipeline-run*`), so Larry can fabricate exactly the evidence every gate inspects. The gates ask "do the tokens of a completed pipeline exist?" instead of "did the pipeline actually execute, and does the artifact content match the scope being dispatched?"

**Threat model (settled, verify round 2):** the adversary is the LAZY agent — one that takes a shortcut a weak gate lets pass (hand-rolling code, back-filling a plan, self-attesting a marker). It is NOT the malicious agent that rewrites its own hook source or forges filesystem state at effort exceeding the honest path. Josh explicitly rejected building an OS privilege boundary (separate user / container / deploy-from-merged-main) for the theoretical malicious case — "months of troubleshooting" over-engineering. Design consequence: every mechanism below must make the shortcut **more expensive than running the real pipeline stage**, and every theoretical residual must be either closed cheaply or routed to the nightly audit with a stated detection method.

## Approach

> Verify round 1 (binding): no named residual bypass; sink-level enforcement; freshness 2h→24h;
> exemptions alerted >~10/week, no hard cap; fail-closed loud with restore command.
> Verify round 2 (binding): merge-anchor is NOT the enforcement point (it gates shipping, not
> programming); enforcement fires at DISPATCH via the sink; the separate-OS-user/container path is
> REJECTED; CODEOWNERS survives only as a lightweight proposal-side review on gate-machinery files.
> HOLE 3 (this rerun): stage rows must prove a distinct stage-runner AUTHORED the artifact, not
> just that the artifact has a sha.

Replace self-attested proxies with four mechanisms:

**A. Signed stage ledger (anti-fabrication core).** Append-only `state/pipeline-ledger.jsonl`, one HMAC-signed row per stage transition, chained via `prev_sha256`. `sig = HMAC-SHA256(secret, canonical-payload)`; the secret (`~/.pipeline-secret`, mode 600) is read-denied to the agent's tool policy and loaded only by the emitter `bin/pipeline-stage-emit` and the daemon's `verifyChain`. Larry can invoke the emitter but cannot forge a row (cannot compute a valid sig) nor fabricate a chain `research→plan→specs→review` (N chained HMACs). Spec: `03-specs/01-signed-stage-ledger.md`.

**B. Content-binding + ordering.** The dispatch must carry `scope-sha=<64-hex>` equal to the terminal `specs` row's `artifact_sha256`; `verifyChain` takes an optional `scopeSha` and fails `SCOPE_SHA_MISMATCH` on divergence. Ordering invariant: reject if `02-master-plan.md` mtime precedes `01-research.md` mtime, or any required artifact lacks a matching signed row — deterministically catches the comms-dedup-pipe back-fill signature.

**C. Real freshness — 24h.** Terminal `specs` row `ts` within **86400 s** of dispatch (verify round 1: freshness is not the security, the HMAC chain is; it only kills "one ancient spec authorizes forever." 2h caused false blocks on long days).

**D. AUTHORSHIP PROVENANCE (closes HOLE 3 — the gated agent fabricating the planning artifacts the gate trusts).** The failure just demonstrated: content-sha binding proves *what* was dispatched matches *what* was signed, but not *who produced it*. Larry can hand-author `02-master-plan.md` + `03-specs/`, invoke the emitter against them, and get valid signed rows — the whole chain is then formally valid over fabricated planning. Fix, in two halves:

  1. **Emit-time authorship proof.** For the authored stages (`synthesize`, `plan`, `specs`, `review`), the emitter REQUIRES provenance flags — `--runner <agent-type>`, `--session <subagent-session-id>`, `--transcript <path to the subagent's session .jsonl>` — and, before signing, **parses the transcript and verifies the subagent's own Write/Edit tool_use calls produced the exact artifact bytes on disk** (reconstructed final content sha == `artifact_sha256`; for a directory, every file covered). A Larry-hand-authored file has no transcript containing those writes → the emitter refuses to sign (`PROVENANCE_MISMATCH`), no row exists, dispatch blocks. The provenance fields (`runner`, `session_id`, `transcript_path`, `transcript_sha256`) are inside the signed payload, so they cannot be swapped after the fact. The emitter is invoked by the pipeline runner at subagent completion; but even a manual invocation cannot cheat, because the authorship check binds to real transcript content, not to who called the binary.
  2. **Dispatch-time provenance verification.** `verifyChain` (used by both the sink and the shell hook) checks that every authored-stage row carries provenance, that the referenced transcript still exists and sha-matches `transcript_sha256` (unmodified since emit), and fails `NO_PROVENANCE` / `TRANSCRIPT_MISSING` / `TRANSCRIPT_TAMPERED` otherwise. A build whose plan/specs rows lack valid subagent-authorship provenance is blocked **at dispatch**.

  **Honest residual, stated and routed (not deferred):** on a single local machine an agent could in principle fabricate a synthetic session `.jsonl` containing fake Write blocks matching its hand-authored spec. Closing that airtight requires the OS privilege boundary Josh rejected. Cheap belt instead: (i) transcripts must live under the real Claude projects dir, which `block-direct-coding.sh` write-denies to the agent (defense-in-depth); (ii) the **nightly audit** cross-checks every authored-stage row against ground truth the lazy path cannot cheaply synthesize — a real subagent run leaves a matching Task/Agent spawn record in *Larry's own conversation buffer*; a row whose session has no matching spawn in the parent transcript for that slug in the window is flagged as hand-authored provenance forgery (detection method specced in `03-specs/03-nightly-bypass-audit.md` §HOLE-3). Fabricating BOTH a synthetic session file AND coherent spawn records in the parent buffer is strictly more work than running the real stage — which, under the settled lazy-agent threat model, closes the hole.

**E. Sink-level enforcement (closes HOLE 2 — AUTHORITATIVE).** A `Bash`-tool hook only sees shell invocations. Enforcement lives at the dispatch SINK — `sendMessage()` in `src/bus/message.ts` (~line 51), which every path (CLI, node script, MCP, direct enqueue) funnels through — verifying the signed chain **including provenance** before accepting any codexer/opencoder/opencode BUILD dispatch. Fires at DISPATCH, before any code is written. Fail-closed with a LOUD error naming what broke + the single restore command. The shell hooks (rewritten in `03-specs/02-gate-rewrites.md` §1–5) are defense-in-depth only.

**F. Gate-machinery review (was "off-machine anchor" — DOWNGRADED per verify round 2).** `04-merge-gate-anchor.md` is rewritten as a lightweight CODEOWNERS + branch-protection note requiring Josh's review for changes to the gate machinery files (hooks, emitter, ledger/sink code, settings). It is **proposal-side review only, explicitly NOT a runtime privilege boundary**; the separate-user/container/deploy-from-merged-main mechanism was considered and rejected. The theoretical "agent edits its own hook source" hole is belted by git-visibility (CODEOWNERS-blocked merge) + the nightly audit flagging any hook/settings mtime change in the trailing 24h.

All gates are hard denies. Trivial work routes through signed `exempt` rows only — charted, counted, alerted when >~10/week, never capped, never silently self-granted.

## Phases

1. **Ledger core + provenance** (spec `03-specs/01-signed-stage-ledger.md`): `src/pipeline/ledger.ts` (row schema incl. provenance fields, canonical serialization, `verifyChain` with `scopeSha` + provenance checks), `src/pipeline/stage-emit.ts` + `bin/pipeline-stage-emit` (emit CLI incl. transcript-authorship verification), secret provisioning, unit tests.
2. **Gate rewrites — shell layer, defense-in-depth** (spec `03-specs/02-gate-rewrites.md` §1–5): `gate-codexer-planning.sh` (signed chain + ordering + content-binding + provenance via `--verify`; add `opencode` to worker regex), `gate-pr-push.sh` (chain to `true-verify` + evidence + slug↔branch), `block-direct-coding.sh` (remove marker free-passes; deny secret, ledger, and Claude-projects transcript writes), `settings.json` (remove `validate-active-spec.sh`; delete dead `gate-directive-detect.sh`).
3. **Sink enforcement — AUTHORITATIVE** (spec `03-specs/02-gate-rewrites.md` §6): build-dispatch guard inside `sendMessage()` calling the shared `verifyChain` (content-sha AND provenance). Every dispatch path gated at the action, before code. Fail-closed + loud + restore command.
4. **HOLE-3 provenance wiring** (specs 01 §Provenance + 02 §6.3): pipeline runner invokes the emitter at subagent completion passing session-id + transcript path; emitter authorship check; `verifyChain` provenance verification; `NO_PROVENANCE`/`PROVENANCE_MISMATCH`/`TRANSCRIPT_MISSING`/`TRANSCRIPT_TAMPERED` failure codes surfaced by sink and hook.
5. **Gate-machinery review note** (spec `03-specs/04-merge-gate-anchor.md`): `.github/CODEOWNERS` on gate files + branch-protection requiring code-owner review. Josh applies the GitHub setting; explicitly NOT a runtime boundary.
6. **Pipeline doc**: `LARRY/PIPELINE.md` — every stage MUST be emitted at completion by the runner with provenance; a stage that did not emit did not happen; a planning artifact without subagent authorship provenance is untrusted by definition.
7. **Nightly bypass audit** (spec `03-specs/03-nightly-bypass-audit.md`): transcript+git+bus-store vs ledger, INCLUDING the HOLE-3 check (authored-stage rows ↔ real subagent spawn records in the parent buffer).
8. **Prove it**: run all acceptance criteria (every forgery class must fail deterministically), then PR for Josh.

Order matters: Phases 2–3 cannot land before Phase 1 (or every dispatch hard-blocks with no way to pass). Phase 5 is a GitHub-side config Josh applies at merge time.

## Files to change

| # | File | Change |
|---|------|--------|
| 1 | `src/pipeline/ledger.ts` (NEW) | Row schema incl. provenance fields (`runner`, `session_id`, `transcript_path`, `transcript_sha256`), canonical serialization, `verifyChain` (chain + sig + order + freshness + `scopeSha` content-binding + provenance verification). Shared by emitter, hooks (via `--verify`), sink. |
| 2 | `src/pipeline/stage-emit.ts` + `bin/pipeline-stage-emit` (NEW) | Sole writer of the ledger. For authored stages: requires `--runner/--session/--transcript`, parses the subagent transcript, verifies its Write/Edit calls produced the exact artifact bytes (else `PROVENANCE_MISMATCH`, no row). HOLE-3 recording point. |
| 3 | `src/bus/message.ts` (SINK — AUTHORITATIVE) | Before accepting any codexer/opencoder/opencode `GATE: build` dispatch: `verifyChain({slug, throughStage:'specs', maxAgeSeconds:86400, scopeSha})` incl. provenance. Throw `BuildGateError` naming the failed check; fail-closed loud + restore command. HOLE-3 verification point. |
| 4 | `LARRY/.claude/hooks/gate-codexer-planning.sh` | Replace file-proxy block with `pipeline-stage-emit --verify` (chain + ordering + scope-sha + provenance); add `opencode` to worker alternation. Defense-in-depth. |
| 5 | `LARRY/.claude/hooks/gate-pr-push.sh` | Replace two-marker check with signed chain to `true-verify` + non-empty evidence + slug↔branch binding. |
| 6 | `LARRY/.claude/hooks/block-direct-coding.sh` | Remove `*pipeline-run*` free-pass; narrow `*/state/*`; deny `~/.pipeline-secret`, ledger writes, and agent writes under `~/.claude/projects/` (transcript-forgery belt). |
| 7 | `LARRY/.claude/settings.json` | Remove `validate-active-spec.sh` wiring; delete dead `gate-directive-detect.sh`. One authoritative dispatch gate. |
| 8 | `.github/CODEOWNERS` (NEW) + branch-protection note | Josh review required for gate-machinery paths. Proposal-side review ONLY (verify round 2); separate-user runtime boundary documented as considered-and-rejected. |
| 9 | `LARRY/PIPELINE.md` | Stage-emission contract incl. provenance: runner emits at subagent completion with session-id + transcript; non-emitted stage = didn't happen. |
| 10 | `LARRY/scripts/pipeline-bypass-audit.sh` (NEW) + cron | Nightly: dispatches/PRs/bus-store vs ledger chains; HOLE-3 check: authored-stage provenance ↔ real subagent spawn in parent buffer; exemption-count alert >~10/week. |

## Lessons Consulted

- **Night-1 smoking gun:** `.agent/one-big-feature/comms-dedup-pipe/` — `02-master-plan.md` mtime `17:12:54` precedes `01-research.md` mtime `17:21:49`. Back-filled plan passed Gate 1 (stat-only). The ordering invariant catches exactly this.
- **Night-2 smoking gun (HOLE 3, this rerun's cause):** Larry hand-authored `hard-spec-gate`'s own plan+specs inside the Larry context. Under mechanisms A–C alone, invoking the emitter on those files would have produced a formally valid signed chain over fabricated planning. Content-sha proves WHAT, not WHO — hence authorship provenance (Approach D).
- **All four prior gates were proxy checks:** Gate 1 stat()s self-authored files; Gate 2 is inject-only; Gate 3 passes on self-written `pipeline-run.json` + yields on 2nd Stop; Gate 4 passes on two self-written markers. Common root: each checks a proxy the gated agent controls. (Research §The 4 gates, §Root cause.)
- **Verify round 2 (Josh):** merge-gating is a gate on SHIPPING, not PROGRAMMING — all ungated work happens before merge. Enforcement must fire at dispatch (sink). And: do not build an OS privilege boundary for the theoretical malicious-agent case; the real adversary is the lazy shortcut.
- **`validate-active-spec.sh` is the same bug shipped twice:** one stale shared `specs/active/` spec rubber-stamps every dispatch.
- **Regex allowlists decay** (2026-07-09 `REQ_RE` miss) — hence the content-based nightly audit that converts any new bypass into a new gate.

## Acceptance criteria (deterministic)

1. **Marker forgery dead:** hand-authored `pipeline-run.json` / `pipeline-review-pass.json` satisfy NO gate; the writes themselves are denied.
2. **Chain forgery dead:** a hand-appended ledger row (agent-computed sig without the secret) fails `verifyChain` (`BAD_SIG`); direct agent write to the ledger is denied.
3. **Ordering enforced:** plan-mtime-before-research-mtime, or any required artifact lacking a signed row → blocked at dispatch.
4. **Content-binding enforced:** dispatch `scope-sha` ≠ signed terminal `specs` `artifact_sha256`, or `03-specs/` edited after signing → `SCOPE_SHA_MISMATCH` block.
5. **HOLE 3 — authorship provenance enforced at emit:** `pipeline-stage-emit --stage plan|specs|synthesize|review` WITHOUT `--runner/--session/--transcript` exits non-zero, no row. With a transcript that does NOT contain Write/Edit calls reconstructing the exact artifact bytes → `PROVENANCE_MISMATCH`, no row. A Larry-hand-authored spec therefore cannot acquire a valid `plan`/`specs` row.
6. **HOLE 3 — provenance enforced at dispatch:** a chain whose `plan`/`specs` rows lack provenance fields (`NO_PROVENANCE`), reference a missing transcript (`TRANSCRIPT_MISSING`), or reference a transcript whose sha no longer matches (`TRANSCRIPT_TAMPERED`) is blocked by BOTH the sink and the shell hook.
7. **HOLE 3 — audit backstop:** nightly audit over a seeded window containing one authored-stage row with valid-looking provenance but NO matching subagent spawn record in the parent conversation buffer flags it as provenance forgery and pages Josh with evidence.
8. **Exempt path signed:** `exempt:true` passes only via a signed emitter-written exempt row; counts alerted >~10/week, never capped.
9. **Coverage widened:** `bus send-message opencode …` hits the gate; `validate-active-spec.sh` removed.
10. **Freshness real:** signed `specs` row older than 24h does not authorize dispatch (`STALE`); 23h-old row passes.
11. **Sink covers non-shell paths (HOLE 2):** `sendMessage()` called directly (no shell) with no valid chain → `BuildGateError`, inbox not written; valid chain incl. provenance → delivered. `GATE: comms` traffic untouched.
12. **Gate-machinery review:** a PR touching CODEOWNERS-listed gate files cannot merge without Josh's review (test PR proves the required-review block). Explicitly NOT tested: any runtime privilege boundary — none exists by decision.
13. **Fail-closed is loud:** ledger/secret removed → every gate hard-blocks AND prints the named breakage + single restore command; `GATE: comms` still flows.

## Gate for this work

Josh VERIFIES this regenerated spec before any code is written. No implementation dispatch until his sign-off. This plan itself was produced by the pipeline PLAN stage-runner (recorded session transcript = its own HOLE-3 provenance evidence).
