# Vertical Guardrails — AI in the AEC Lifecycle (Architecture / Engineering / Construction)

**Source:** Josh, 2026-06-25. Apply these whenever the audited client is an architecture, engineering, or construction (AEC) business. This shapes *where we recommend AI/automation solutions* (`audit-solution-portfolio`, `audit-roadmap`) and *how we frame accountability* in the deliverable. It does NOT change Rule Zero — it sharpens where AI is and isn't appropriate for the client's own work.

> Core thesis: AI does not impact every stage of the AEC lifecycle equally. It creates the most value where work is documentation-heavy, repetitive, or information-dense, and it must be used with caution where work requires strict accuracy, compliance, and professional accountability. Avoid the "AI everywhere" trap.

---

## 1. The AEC Lifecycle Map — core task groups
AI can help in all six, but value/risk differs by group.

1. **Concept / Early Design** — interpreting client brief, exploring design options, early narratives & diagrams, initial visuals & feasibility thinking
2. **Design Development (DD)** — cross-discipline coordination, resolving key design decisions, developing specifications & systems, identifying risks
3. **Construction Documentation (CD)** — detailed drawings, specification writing, coordination consistency, RFIs & submittals prep
4. **Construction / Site** — site reporting, team coordination, QA/QC documentation, progress tracking
5. **Handover / Asset Management** — closeout documentation, asset registers, building information delivery, FM integration
6. **General Works (across stages)** — emails, presentations, websites & visuals, automation & data work

**Insight:** find where AI is *best*, where it's *good*, and where it *isn't necessary right now* — don't blanket-apply.

---

## 2. The AEC Work-Types Model — think in work types, not "AI everywhere"

| Work type | Examples | AI strengths | Accountability note |
|---|---|---|---|
| **Communication** | emails, meeting notes, coordination summaries, client updates | summarization, drafting, tone adjustment | — |
| **Documentation** | reports, specifications, RFIs, submittals, compliance narratives | drafting, structuring, extracting information | compliance narratives still need human verification |
| **Coordination** | issue logs, clash narratives, decision registers, task tracking | organizing info, summarizing problems, structured reports | — |
| **Reasoning Support** | option comparisons, tradeoff analysis, risk framing, brainstorming | exploring alternatives, structuring thinking | **human remains the decision-making authority** |
| **Generation** | design ideas, visual concepts, early narratives, draft outlines | exploration & ideation | **not suitable for final-authority decisions** |
| **Data** | connecting data sources, tasks across apps, analysis | summarizing, connecting/consuming, insights/search/comparison | — |

**AI is excellent at:** drafting, summarizing, organizing, classifying.
**AI is weak at:** truth verification, compliance claims, engineering accountability.
**Always check AI results.**

---

## 3. Where AI Is Risky in AEC — do NOT recommend unverified AI for these
These require professional accountability and human sign-off:
- engineering calculations
- code compliance claims
- contractual language
- safety-critical decisions
- regulatory statements

**Common mistake:** assuming AI outputs are factually reliable by default. AI predicts language — it does not guarantee truth.

When proposing solutions in these areas, always wrap them in a verification pattern below; never propose AI as the final authority.

---

## 4. Human-in-the-Loop (HITL) — the three safe patterns
Every AI/automation solution we propose for an AEC client should map to one of these:

1. **Draft → Review → Approve** — emails, reports, meeting minutes, RFI drafts. AI drafts → human reviews → human approves.
2. **Extract → Verify → Publish** — spec summaries, action registers, meeting outputs, schedule summaries. AI extracts → human verifies → publish verified data.
3. **Compare → Decide → Document** — option comparisons, design alternatives, strategy decisions. AI compares → human decides → AI documents the reasoning.

---

## How to apply in an audit
- When scoping AEC solutions, anchor each recommendation to a **work type** (§2) and a **HITL pattern** (§4); say explicitly which one.
- For anything in the **risky** list (§3), flag the human-accountability requirement in the deliverable — never propose autonomous AI there.
- Prefer high-value, low-risk targets first: documentation-heavy, repetitive, information-dense work (Communication, Documentation, Coordination, Data).
- Six AI tool layers exist (prompting/ChatGPT → copilots → workflow automation → agentic workflows); accountability and compliance always stay with humans via the review patterns.
- Startup/solution archetypes generally fall into: **augment** workflows, **automate** typical tasks, or **reimagine** the process entirely — name which one a proposed solution is.
