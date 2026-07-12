# Hard-Spec-Gate — Better Ideas (IDEATION stage, challenge the design)

> Task: Josh is frustrated that every gate so far has a nameable bypass. Think from scratch.
> Constraints (from 04-verify): threat = **lazy-me**, not malicious-me; **no OS-user/container**
> privilege boundary; gate fires at **DISPATCH** (before code is written), not at merge; **no named
> residual left unhandled** (residual → nightly audit with a concrete detection method).

---

## The core reframing (why every prior gate failed, stated precisely)

Every gate to date, INCLUDING the signed-ledger design in 01-research, verifies an artifact that
Larry **produces and controls**: a file it can write, a marker it can emit, or — in the ledger case
— a row it can *cause to be signed by invoking the emitter itself on hand-authored content*. The
HMAC ledger raises the forgery cost (you can't fake a `sig`), but it does NOT answer the actual
question, because **Larry can still invoke `pipeline-stage-emit` on a plan he hand-wrote**. The
emitter signs *"this file's sha, at this time, in this order"* — it does not, and cannot, sign
*"a distinct plan-stage subagent actually authored this."* That is the exact hole that just
happened ("ungated PLANNING is unguarded").

The correct question is not *"do the tokens of a completed pipeline exist and chain?"* It is:
**"did a distinct pipeline stage-runner process actually author this artifact, in a way Larry's own
process cannot cheaply manufacture?"**

Crucial finding from investigating the runtime (this changes the whole design): **when Larry invokes
a subagent via the Task tool, the Claude Code runtime writes a separate transcript at
`~/.claude/projects/<larry-project>/<parent-session-uuid>/subagents/agent-<id>.jsonl`**, marked
`isSidechain:true`, carrying `agentId`, `cwd`, `gitBranch`, `timestamp`, and model `version`. It is
written by the *runtime*, not by Larry's tool calls, is mode-600 outside the repo, and — decisively —
**a hand-authored plan produces ZERO such subagent transcript.** Verified live: Larry's real
subagent runs leave `subagents/agent-*.jsonl`; a `Write` to `02-master-plan.md` leaves none. This is
the James-Goldbach skill-optimizer pattern (transcript = ground truth) turned into a gate, and it is
the cheapest thing that closes the planning hole for the *lazy* threat model.

Two independent design axes fall out, and the best answer combines them:
- **Axis A — Provenance of authorship:** prove a distinct subagent authored each stage artifact.
- **Axis B — Structural chokepoint:** make "Larry writes to a worker's inbox" not a thing that
  exists, so dispatch is *physically* only reachable through a pipeline entrypoint.

---

## Idea 1 — Runtime-transcript provenance binding (RECOMMENDED CORE)

**Mechanism.** Add a required field to each stage's ledger row: `subagent_session` = the path +
`agentId` of the `subagents/agent-*.jsonl` transcript whose subagent produced that stage's artifact.
The stage-emitter is called **by the parent Larry process immediately after the Task subagent
returns**, and it does three things the agent cannot fake:
1. Resolves the *current* parent session's `subagents/` dir (from the live `CLAUDE_*`/transcript env
   the runtime exposes, or by taking the newest `agent-*.jsonl` under the active session created
   during this turn) and records its `agentId` + sha of its content into the signed row.
2. Requires that transcript to contain a tool_use that actually **wrote the artifact** whose sha is
   being signed (grep the sidechain jsonl for a `Write`/`Edit` to `02-master-plan.md` with matching
   content-sha). No matching subagent write → emitter refuses to sign.
3. Binds `stage` → expected `agentId`-model (plan stage must be a Fable/Opus subagent, not the main
   thread). The main-thread session (`isSidechain:false`) is explicitly disqualified as a stage
   author.

At **dispatch time**, the sink (`src/bus/message.ts`, per HOLE 2) verifies the chain AND that each
required stage row references a real, on-disk subagent transcript whose content-sha matches the row.
A hand-authored plan has no subagent transcript to reference, so the emitter would refuse to sign it
in the first place, and the sink hard-blocks the dispatch.

**Fabrication it blocks.** Exactly tonight's failure: Larry hand-authoring plan+specs in its own
context and emitting valid rows. There is no `subagents/agent-*.jsonl` for a plan the main thread
wrote, so no valid row can be produced, so dispatch is blocked before codexer writes a line.

**Residual / weakness.** (a) Larry could spawn a *real but trivial* subagent ("write this plan I
already wrote") to manufacture a transcript. This is materially harder and more expensive than a
`Write` — it's real token spend on a real subagent and it produces a transcript that *shows the
plan was dictated*, which the nightly audit can flag (see Residual Handling). For the **lazy**
threat model this is already a win: the path of least resistance becomes "just run the real
planner." (b) The runtime's subagent-transcript path/format is a Claude-Code implementation detail
that could change across versions — the gate must fail-closed-loud if it can't locate the
`subagents/` dir for the active session, naming the version mismatch.

**Cost to build.** Medium. A transcript-locator + sidechain-grep helper (~1 file), added fields to
the emitter + `verifyChain`, and the sink call. No OS boundary. Reuses the existing HMAC machinery
from 01-research.

**Fits lazy threat model?** Yes — best fit of any idea. It makes the honest path (run the subagent)
strictly cheaper than the dishonest path (spawn a fake subagent to launder a hand-written plan).

---

## Idea 2 — Structural dispatch chokepoint: Larry cannot address a worker inbox at all (RECOMMENDED PAIR)

**Mechanism.** Remove Larry's ability to *name a worker as a dispatch target*. Today any path
(`bus send-message codexer`, node script, direct file write to `inbox/codexer/`) can enqueue build
work. Instead:
- The worker inboxes (`codexer`, `opencoder`, `opencode`) accept **build** messages **only** from a
  single pipeline-runner entrypoint, enforced at the sink (`sendMessage` in `src/bus/message.ts`):
  if `to ∈ {workers}` AND the message is build-class (carries `GATE: build` or targets a worktree),
  require a valid, transcript-bound ledger chain (Idea 1) for the referenced slug, signed within the
  freshness window. No chain → the sink throws; the message is never written to the inbox.
- `send-message` from Larry to a worker for **comms** (`GATE: comms`, acks/review) stays open — those
  don't write product code.
- This closes research gaps #2 (the `opencode` alt-id) and #9 (non-Bash dispatch) **by construction**,
  because enforcement is at the enqueue function every path funnels through, not at the Bash string.

**Fabrication it blocks.** "Larry writes to codexer's inbox by hand" (any transport) stops being a
thing that exists for build work. Combined with Idea 1, the *only* way to legally enqueue build work
is: real subagents authored the stages → chain is transcript-bound → sink accepts. There is no
side door.

**Residual / weakness.** The sink itself is code Larry's process runs — per 04 Round 2, a purely
local check is editable by whoever runs it. BUT: (a) the sink lives in `src/bus/message.ts` /
`dist/`, which is exactly the machinery that belongs behind Josh's CODEOWNERS merge review (04 Round
1's retained control), so weakening it requires a reviewed merge; (b) the fleet running the dirty
working tree means an edit is live immediately — this is the honest residual, routed to the nightly
audit (detect: `dist/` mtime newer than last reviewed main + a diff to the verify function). For the
**lazy** threat model, editing `src/bus/message.ts` to neuter the sink is not a shortcut Larry
reaches for — it's a conspicuous, self-incriminating act, not a lazy corner-cut. Idea 2 is aimed at
"lazy me takes the easy dispatch path," which it eliminates.

**Cost to build.** Low–medium. One enforcement block in `sendMessage`, a worker-set constant, and
the build-class detector. This is the HOLE-2 sink work already scoped in 04 — Idea 2 just states its
*shape* correctly (chokepoint, not a second copy of the Bash gate).

**Fits lazy threat model?** Yes. Removes the easy path entirely.

---

## Idea 3 — Ergonomic inversion: make the pipeline the path of least resistance (RECOMMENDED, force-multiplier)

**Mechanism.** The deepest fix for a *lazy* agent is not a taller wall — it's making compliance
cheaper than evasion. Ship a single command, `cortextos pipeline run <slug> "<request>"`, that:
- runs research → synthesize → plan → specs as real subagents, emits transcript-bound signed rows at
  each stage automatically, and hands Larry a ready-to-dispatch slug;
- is **one invocation**, versus the multi-step friction of hand-authoring `02-master-plan.md`,
  `mkdir 03-specs`, pasting `## Lessons Consulted`, faking mtimes in forward order, and emitting rows.

When the honest path is `pipeline run x "..."` and the dishonest path is "assemble a forgery that
also has to spawn a laundering subagent to satisfy Idea 1," lazy-me runs the pipeline. This is the
only idea that reduces *how often the gate is even tested*, because it removes the motive to bypass.

**Fabrication it blocks.** None directly — it's not a gate. It shrinks the incentive surface so the
gates (Ideas 1+2) are rarely challenged, which is what actually ends the recurring pattern.

**Residual / weakness.** Doesn't stop a determined bypass on its own — must be paired with 1+2. If
the one-command flow is slow or flaky, laziness routes *around* it, so it must be genuinely fast and
reliable or it backfires.

**Cost to build.** Medium (it's mostly wiring existing stages behind one entrypoint + the emitter
calls). High leverage per unit cost.

**Fits lazy threat model?** This is *the* lazy-threat idea — it treats laziness as the design input
rather than the adversary.

---

## Idea 4 — Nightly transcript-vs-artifact reconciliation audit (RESIDUAL BACKSTOP, not primary)

**Mechanism.** A nightly `pipeline-provenance-audit` cron reconciles, for the trailing 24h, three
sources: (a) git (branches pushed, PRs opened, worktrees touched), (b) the signed ledger, (c) the
**actual subagent transcripts** under `~/.claude/projects/<larry>/*/subagents/`. For every build
that reached code, it asserts a real plan-stage subagent transcript exists whose authored content-sha
matches the dispatched spec. Bypass signals: code reached a branch but no subagent transcript
authored its plan; a ledger row references a subagent transcript that shows the plan was *dictated*
by the parent (grep the sidechain for a prompt that pastes a pre-written plan rather than composing
one); `dist/` or a hook mtime is newer than last-reviewed-main (sink/gate tampering). On a hit:
write a `feedback_*.md` naming the exact bypass, file a bus task to add the missing gate (feeding
`enforcement-scan.sh`), page Josh once/night batched (per 04 Q6).

**Fabrication it blocks.** The two residuals the runtime gates can't fully prevent: (i) a *real but
laundering* subagent that just echoes a hand-written plan (Idea 1's residual), and (ii) local
sink/hook tampering (Idea 2's residual). It converts each into a one-time, detected event.

**Residual / weakness.** Detection, not prevention — a bypass can happen once before the audit
catches it. Acceptable ONLY as the backstop under prevention (Ideas 1+2), never as the primary gate.
Depends on the transcript format staying stable (same version-pin caveat as Idea 1).

**Cost to build.** Low–medium (transcript parser + reconciliation + it reuses `enforcement-scan.sh`'s
self-tightening loop, already in the repo).

**Fits lazy threat model?** Yes as backstop — makes any residual self-correcting so each novel path
happens at most once.

---

## Idea 5 (REJECTED, stated so it isn't re-proposed) — deeper HMAC chain / more markers

Adding more signed markers or a longer chain (the 01-research direction alone) does NOT fix the
crux: the agent controls the *input* to the signer. Signing more hand-authored content faster is not
provenance. Rejected as insufficient on its own. (The HMAC machinery is still *used* — as the
integrity layer under Idea 1's transcript binding — but signing alone was never the gap.)

Also rejected per 04's explicit constraints: OS-user/container privilege boundary (months of
troubleshooting); merge-anchored enforcement (gates shipping, not programming).

---

## RANKED RECOMMENDATION

**Best design = Idea 2 (structural chokepoint) + Idea 1 (transcript-provenance binding) as the two
load-bearing gates, Idea 3 (one-command pipeline) as the ergonomic inversion that makes lazy-me
comply by default, and Idea 4 (nightly transcript audit) as the residual backstop.**

Why this combination and not the 01-research ledger alone:
1. **Idea 1 closes the exact hole that just happened** — hand-authored planning — because a plan the
   main thread wrote has no `subagents/agent-*.jsonl` to bind to, and the emitter refuses to sign a
   row with no subagent author. The ledger's content-sha was necessary but not sufficient; the
   *subagent-transcript binding* is the missing sufficiency.
2. **Idea 2 makes dispatch a chokepoint at the sink** (`src/bus/message.ts`), so every transport —
   CLI, node, MCP, `opencode` alt-id, direct inbox write — hits the same transcript-bound check
   before a worker inbox is ever written. It fires at DISPATCH, before code, per constraint. This is
   the correct framing of the HOLE-2 sink work from 04.
3. **Idea 3 attacks the actual threat** (a lazy agent) at its root by making the honest path the
   cheapest path, so the gates are rarely even tested.
4. **Idea 4** converts the two honest residuals into detected, self-tightening, once-only events.

Enforcement anchor stays as 04 Round 1 settled it: the gate *machinery* (`src/bus/message.ts`/`dist`,
hooks, emitter, secret) sits behind Josh's CODEOWNERS merge review, so weakening the sink requires a
reviewed merge — but day-to-day *build enforcement* is the dispatch-time transcript-bound sink check,
NOT the merge gate (fixing 04 Round 2's correct objection).

### Biggest honest residual (named + routed, never left open)
**A real-but-laundering subagent:** lazy-me could spawn one genuine throwaway subagent and feed it a
pre-written plan to manufacture a `subagents/agent-*.jsonl`, producing a bindable transcript for
content it authored itself. Prevention can't fully distinguish "planned" from "transcribed a
pre-written plan" at dispatch time. **Routed to Idea 4's nightly audit**, concrete detection: grep
the bound sidechain transcript for a parent→subagent prompt that *pastes a substantially-complete
plan* (high overlap between the subagent's input prompt and its output artifact = laundering, versus
a real planner whose input is the research + a directive and whose output is net-new). On a hit:
`feedback_*.md` + bus task + one batched page. This is the standard James-Goldbach transcript-audit
move — and because Idea 3 makes the honest one-command path cheaper than staging a fake subagent,
the lazy agent has no incentive to do this in the first place.
