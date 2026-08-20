# Behavioral Audit

For when the machinery is fine and the *behavior* is wrong. Nothing crashed,
nothing is stuck, no log shows an error — because nothing errored. The agent did
what its instructions told it to do, and the instructions are the problem.

**Only open this file for behavior symptoms.** If an agent is silent, crash
looping, or missing messages, that is infrastructure — go back to
`symptom-playbooks.md`. Running an instruction audit on a wedged PTY wastes an
hour and finds nothing, because the agent never got far enough to read anything.

Behavior symptoms sound like: doing a thing it was told not to, skipping a step
it was told to take, being weirdly anxious or over-cautious, ignoring a skill,
using the wrong skill, forgetting something it was told this morning, answering
in the wrong voice, refusing work it should accept, or two agents behaving
differently from identical instructions.

**Contents**
1. [The instruction surface](#1-the-instruction-surface)
2. [Work backwards first](#2-work-backwards-first)
3. [Pass A — Inventory and context budget](#pass-a--inventory-and-context-budget)
4. [Pass B — Contradictions](#pass-b--contradictions)
5. [Pass C — Staleness and dead references](#pass-c--staleness-and-dead-references)
6. [Pass D — Skill collisions](#pass-d--skill-collisions)
7. [Pass E — Pressure and distortion](#pass-e--pressure-and-distortion)
8. [Pass F — Org vs. agent conflicts](#pass-f--org-vs-agent-conflicts)
9. [Reporting and fixing](#9-reporting-and-fixing)

---

## 1. The instruction surface

Everything below shapes behavior. The audit covers all of it, because a
contradiction between any two layers produces exactly the same symptom.

**Agent workspace** — the agent's own directory:

| File | Role |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | Entry point and session-start checklist |
| `SOUL.md`, `IDENTITY.md` | Character, voice, self-conception |
| `SYSTEM.md`, `USER.md` | System framing and who it works for |
| `GUARDRAILS.md` | Prohibitions and limits |
| `GOALS.md`, `goals.json` | What it is trying to achieve |
| `TOOLS.md` | Available tools and usage rules |
| `HEARTBEAT.md` | Recurring-cycle behavior |
| `ONBOARDING.md` | First-boot flow |
| `MEMORY.md`, `memory/` | Durable and daily memory |
| `experiments/learnings.md` | Accumulated adjustments |
| `config.json` | Approvals, comms, goal config |
| `.claude/settings.json` | Harness-level settings, hooks |
| `.claude/skills/*/SKILL.md` | Loaded capabilities |

**Org / shared** — reaches every agent, so a defect here is fleet-wide:

| Path | Role |
|---|---|
| `knowledge.md` | Org knowledge loaded at boot |
| `context/USER.md` | Shared operator profile |
| `context/brand-voice.md` | Voice and tone |
| `context/business.json`, `context.json` | Org facts |
| `context/agent-profiles/`, `agents-registry.json` | Who is who |
| `context/patterns/`, `research/`, `customer-insights/` | Reference material |
| `config/enabled-agents.json` | The roster agents consult |
| `config/business-kpis.json` | What counts as success |

Two facts about this surface that drive most findings:

**It is large by default.** The stock agent template is roughly 1,700 lines
before anyone customizes anything, and `AGENTS.md` alone carries a multi-step
session-start checklist. Add org docs, memory, and a dozen skills and a
meaningful share of the window is spent before the agent reads its first message.

**Precedence is mostly implicit.** `CLAUDE.md` points at `AGENTS.md`, which points
at the bootstrap files, which coexist with org docs. Where two of them disagree,
nothing declares a winner — so the agent picks, and picks differently on different
days. **Nondeterministic behavior across restarts with unchanged files is the
signature of an undeclared precedence conflict**, and it is the single most
useful pattern in this file.

---

## 2. Work backwards first

Do not audit everything. A full sweep of this surface returns dozens of true-but-
irrelevant findings and buries the one that matters.

Start from the observed behavior and ask: **what would an agent have to believe
for this to be the correct action?** Then go looking for the sentence that would
make it believe that. Usually it exists, and usually it is close to the words the
user used to describe the problem.

```bash
# Search the whole surface for the concept, not the exact phrasing.
cd <agent-workspace>
grep -rniE "<concept>|<synonym>|<related term>" . ../../context ../../knowledge.md 2>/dev/null | head -40
```

Three cheap, high-yield questions before any systematic pass:

**What changed?** Behavior that changed on a date has a cause with an mtime.

```bash
find . ../../context -name "*.md" -o -name "*.json" | xargs ls -lt 2>/dev/null | head -20
git log --oneline -20 -- . 2>/dev/null       # if the workspace is versioned
```

**Is it one agent or all of them?** One agent → its own files. Several → org
layer or a shared skill. This halves the search immediately.

**Did it ever work?** Never-worked is a missing or wrong instruction.
Used-to-work is a change, a staleness, or a newly introduced conflict.

Run the systematic passes below when working backwards comes up empty, when the
user asks for a general health check of the instruction surface, or when you have
found one defect and want to know whether it is isolated.

---

## Pass A — Inventory and context budget

Overload is the failure nobody attributes correctly, because it produces no error
and no single bad instruction — it produces *inconsistency*. Instructions late in
a long context get followed unreliably, so the agent obeys a rule one day and not
the next, and every file involved looks fine in isolation.

```bash
python3 scripts/audit_instructions.py --agent <name>
```

The script inventories the surface, estimates a token budget, and flags dead
references and duplicated directives. Read its numbers, then judge:

- **What fraction of the window is spent before the first user message?** Past
  roughly a quarter, expect degraded instruction-following at the tail.
- **What is the biggest single file, and does it earn its size?** Long
  session-start checklists are the usual offender — they are re-read every boot.
- **Is anything loaded that no longer applies?** Old project context, completed
  initiatives, superseded processes.
- **Is the same rule stated in four places?** Duplication is not reinforcement.
  It multiplies the surface where a future edit creates a contradiction.

The fix is deletion, not rewording. Ask of each block: if this were removed,
what would go wrong? If the answer is "nothing specific", it is costing more than
it returns.

---

## Pass B — Contradictions

Two kinds, and the second is far more common.

**Direct** — two files state opposing rules. Rare, easy to spot, easy to fix.

**Latent** — each instruction is individually sensible, but they cannot both be
satisfied in some situation the author did not picture. These survive review for
months because nobody reads the two files together.

Classic shapes worth checking explicitly:

| Shape | Example |
|---|---|
| Autonomy vs. approval | "Act autonomously on routine work" + "Confirm before any action affecting a customer" — who wins for a routine customer email? |
| Speed vs. thoroughness | "Respond immediately" + a multi-step pre-response checklist |
| Terse vs. complete | "Keep replies short" + "Always include context, reasoning, and next steps" |
| Prohibition vs. duty | A tool forbidden in `GUARDRAILS.md` but required by a skill's workflow |
| Scope | Agent told it owns something the org doc assigns elsewhere |
| Voice | `SOUL.md` character vs. `brand-voice.md` tone |

```bash
# Pull every imperative into one place so conflicts become visible side by side.
grep -rniE "^\s*[-*0-9.]*\s*(always|never|must|do not|don't|avoid|require|ensure|before you|only if)" \
  *.md .claude/skills/*/SKILL.md ../../knowledge.md ../../context/*.md 2>/dev/null
```

Read that list as a set rather than line by line. The question is not "is each
of these reasonable" — they almost always are — but **"can all of these be true
at once, in the situation the user is describing?"**

When you find a real conflict, the fix is usually not deleting one side. It is
**stating the precedence explicitly** in the higher-authority file: which rule
wins, and under what condition. That converts nondeterministic behavior into
predictable behavior and survives future edits.

---

## Pass C — Staleness and dead references

Instructions rot silently. They point at files that moved, commands that were
renamed, agents that were removed, projects that ended — and the agent keeps
faithfully trying, then improvising when it fails.

The audit script checks referenced paths and commands mechanically. Beyond that,
look for staleness the machine cannot see:

- **Finished work still described as current** — a launch that shipped, a
  migration that completed, a quarter that ended
- **People or roles that changed**
- **Superseded process** — the old way documented beside the new way, with
  nothing marking which is current
- **Deprecated framework guidance** — e.g. instructions written before crons
  became daemon-managed, or before a CLI command was renamed

```bash
grep -rniE "\b(20[0-9]{2}|Q[1-4]|current(ly)?|for now|temporar|until we|upcoming|this (week|month|quarter))\b" \
  *.md ../../context/*.md 2>/dev/null | head -30
```

Date-anchored language is the best proxy for rot. Anything written as "currently"
or "for now" was true once and is unowned now.

A dated note that is still accurate should be re-dated or made unconditional; the
point is not to purge time references but to remove the ones that are lying.

---

## Pass D — Skill collisions

Skills are selected by their descriptions. When two descriptions cover
overlapping ground, selection becomes a coin flip — which reads to the user as
"it used the wrong skill" or "it ignored the skill entirely".

```bash
for f in .claude/skills/*/SKILL.md; do
  echo "--- $f"; sed -n '1,12p' "$f"
done
```

Check for:

- **Overlapping descriptions or triggers** — two skills that both plausibly own
  the same request. Fix by narrowing both and stating the boundary in each,
  explicitly naming the other skill.
- **A description that undersells the skill** — it never fires because it does
  not sound relevant to the cases it actually handles.
- **A description that oversells** — it fires constantly and crowds out better
  matches. This is the more damaging direction.
- **Instructions inside a skill that contradict bootstrap files** — skills are
  written independently and drift from the agent's guardrails.
- **Skills that duplicate bootstrap content** — the same rule in both places,
  now with two owners and one future contradiction.

A catalog description that promises more than the skill body delivers is worth
checking specifically: selection is driven by the description, so the mismatch
mis-routes work before anyone reads the body.

---

## Pass E — Pressure and distortion

Instructions do not only convey information; they set stance. Language calibrated
for emphasis often over-corrects, and the resulting behavior is legible as
anxiety, rigidity, or theater.

Look for:

- **Threats and scores** — "your effectiveness will be 0%", "you will have
  failed". These reliably produce over-compliance: performative task creation,
  padded reports, reluctance to say "I don't know".
- **Stacked absolutes** — when everything is ALWAYS or NEVER, nothing is
  prioritized, and the agent cannot tell which rule to break when two collide.
- **Emphasis inflation** — bold, caps, and MUST used so widely that genuinely
  critical rules no longer stand out.
- **Vague superlatives** — "be extremely thorough", "always be proactive" — which
  give no decision procedure and tend to produce more output rather than better
  judgment.
- **Unexplained rules.** A rule with its reasoning attached generalizes to
  situations the author did not anticipate. A bare imperative does not, and gets
  misapplied at the edges.

```bash
grep -rnE "(ALWAYS|NEVER|MUST|CRITICAL|MANDATORY|CONSEQUENCE|IMPORTANT)" *.md .claude/skills/*/SKILL.md 2>/dev/null | wc -l
```

A high count is not automatically wrong, but it is worth showing the user: if
every rule is critical, the emphasis has stopped carrying information. The
remedy is usually to explain *why* a rule matters and let the model reason from
it, reserving hard absolutes for the few things that genuinely admit no
exception.

---

## Pass F — Org vs. agent conflicts

Org-level documents reach every agent, so a defect here presents as several
agents misbehaving in similar ways — which is also the signal that you are in the
right layer.

Check specifically:

- **Org instruction contradicting an agent's own role** — most common where an
  agent has a specialty the org doc generalizes over
- **Roster disagreement** — `enabled-agents.json` versus `agents-registry.json`
  versus what `agent-profiles/` describes. Agents consult the roster to know who
  exists; a mismatch produces "agent A doesn't know agent B exists"
- **Ownership gaps and overlaps** — work nobody owns, or two agents both told
  they own it
- **Stale org knowledge** outliving the situation it described
- **Voice conflicts** between `brand-voice.md` and individual `SOUL.md` files

```bash
diff <(python3 -c "import json;print('\n'.join(sorted(json.load(open('../../config/enabled-agents.json')))))" 2>/dev/null) \
     <(ls ../../context/agent-profiles 2>/dev/null | sed 's/\.[a-z]*$//' | sort) 2>/dev/null
```

Fixes at this layer affect the whole fleet, so they warrant more caution and an
explicit heads-up to the user about blast radius.

---

## 9. Reporting and fixing

**Name the specific instruction.** "Your instructions are bloated" is not
actionable. "`GUARDRAILS.md:23` forbids the tool that `tasks/SKILL.md:41`
requires, so it stalls on every task needing that tool" is.

Report in this shape:

```
Behavior:     what the agent did, in the user's terms
Instruction:  file, line, and the text responsible
Why it fires: how that text produces this behavior
Conflicts:    the other instruction it contradicts, if any
Fix:          the minimal edit
Blast radius: this agent, or the whole fleet
```

**Back up before editing**, and prefer the smallest change that resolves the
conflict. Deleting a contradictory line is usually better than adding a third
rule to arbitrate between the first two — every added rule is future surface for
the next conflict.

**Change one thing at a time.** Instruction edits interact, and a batch of five
changes that together fix the symptom teaches nobody which one mattered.

**Restart to take effect.** Bootstrap files are read at session start, so an edit
does nothing until the agent restarts — a real source of "I fixed it and nothing
changed". Say so, warn before restarting, and remember that a restart drops the
agent's working context.

**Verify by behavior, not by file.** The file now says the right thing; that is
not evidence the behavior changed. Reproduce the original trigger and watch what
the agent actually does.

Finally, record what you changed and why. Instruction surfaces rot fastest where
nobody remembers the reasoning behind a line, and today's fix is tomorrow's
mysterious rule — `experiments/learnings.md` is the conventional home for that
note.
