---
name: solution-design-chain
description: "On-demand (Josh-driven, NOT autonomous) entrypoint that chains the 5 solution-design producer skills — integration-engineer → solutions-engineer → proposal-writer → pricing-analyst → deal-room-producer — into ONE coherent quote/solution artifact of delegatable quality. Threads a single deal context so the proposal's scope, the pricing's line items, and the deal room's sections all describe the same deal with the same phases and the same numbers. Use when Josh says 'run the solution-design chain', 'build the full quote for [deal]', 'produce the deal package for [prospect]', 'scope and price [deal] end to end', or wants the whole quote/solution pipeline run coherently from one entry point. NOT wired to any event or cron — Josh invokes it manually."
---

# Solution-Design Chain · one coherent quote from five producers (ON-DEMAND)

## What this is
The five solution-design producer skills each do one job well, but run independently
they DRIFT: each re-gathers the deal, re-invents phase names, and re-derives numbers,
so the proposal, the pricing, and the deal room end up describing three subtly
different deals. That is not delegatable.

This skill is the **on-demand entrypoint** that runs the five in the Kadre-proven
order threading **one shared deal context**, then **refuses to call the package done
until the artifacts line up** (same deal slug, same phase ids, every phase priced, no
placeholder left in the room).

> **On-demand only.** Josh invokes this by hand. It is NOT wired to any webhook, cron,
> or event. It does not spawn a worker. It is a documented skill-chain.

## The chain (fixed order)
```
1. integration-engineer   — per live-external Worker (CRM/calendar/payments/etc).
                            Sets integrationEngineerRan in scoping-manifest.json.
                            (Producer + the code-enforced gate: a live-3rd-party
                            write may not price until this has run — no override.)
2. solutions-engineer      — (optional producer) discovery → prototype brief, to
                            ground "what we'll build" before the proposal.
3. proposal-writer         — authors the PHASE SPINE (scope as phases). Every price
                            marked [CONFIRM PRICE]. This stage OWNS the phase ids.
4. pricing-analyst         — anchor + phase RANGES + ROI. Reuses the exact phase ids
                            from stage 3. Every phase priced.
5. deal-room-producer      — packages proposal + pricing + proof into one room.
                            Same phase ids, same numbers, no [CONFIRM] placeholder.
```

Stages 1 and 5 also sit on the existing code-enforced `scoping-gate` (integration +
exemplar-grounding). This skill's coherence check is complementary: the scoping gate
guards *predecessor ran*; this guards *outputs agree*.

## The shared spine
Two JSON files live in the deal directory and thread every stage:

- `deal-context.json` — slug, client, engagement, and the **phase spine** (id + name).
  proposal-writer authors the phases; pricing-analyst and deal-room-producer **reuse
  the ids, never re-invent them**. Each stage records its artifact path here.
- `scoping-manifest.json` — the code-enforced integration/grounding gate (shared with
  `scoping-gate`).

The one rule that makes the package coherent: **every stage tags each phase heading
with a machine marker `<!-- phase: <id> -->`** using the ids from `deal-context.json`.
The coherence check keys off the marker, not prose, so wording can differ freely while
scope/pricing/sections stay provably the same deal.

## How to run

### Step 0 · Seed the shared deal context
Pick a deal directory (per-agent, e.g. `outputs/deals/<slug>/`). Draft the phase spine
FIRST (this is the proposal-writer's job — do it before pricing so pricing inherits the
phases). Then seed:

```bash
node <cortextos>/dist/pipeline/deal-context.js init \
  --dir outputs/deals/<slug> \
  --client "Acme Co" \
  --engagement "lead-triage automation" \
  --contact "Dana Ops, COO" \
  --phases "phase-0-audit:Audit & Pilot,phase-1-build:Main Build,ongoing-retainer:Retainer" \
  --live-workers "crm-sync,calendar-sync"
```

`--live-workers` are the Workers that write to a live external system — each seeds an
UNCLEARED row in `scoping-manifest.json`, so the scoping gate blocks pricing/deal-room
until integration-engineer runs for each.

### Step 1-5 · Run the producers in order
Run each producer skill for THIS deal, pointing every stage at the deal directory:

1. **integration-engineer** for each live-external Worker. After each, set that
   Worker's `integrationEngineerRan: true` in `scoping-manifest.json`.
2. **solutions-engineer** (optional) — prototype brief, saved into the deal dir.
3. **proposal-writer** — write `proposal.md` into the deal dir. Tag each phase heading
   `<!-- phase: <id> -->` with the ids from `deal-context.json`. Record the path:
   set `artifacts.proposal` in `deal-context.json`.
4. **pricing-analyst** — write `pricing.md`. Reuse the SAME phase ids + markers; price
   every phase. Record `artifacts.pricing`. Set `exemplarGroundingPass2: true` in the
   manifest once the pricing re-check + prior-work sweep has run.
5. **deal-room-producer** — write `deal-room.md` (or `room.html`). Same phase ids +
   markers. Resolve every `[CONFIRM PRICE]`/`[CONFIRM SCOPE]` (founder decision) before
   the room ships. Record `artifacts.dealRoom`.

> Each producer still owns its own quality bar and safety gate (integration-engineer's
> never-write-live-without-a-yes rule, proposal-writer's price-confirmation, etc.). This
> skill does not relax any of them.

### Step 6 · Prove coherence (the deliverable)
```bash
node <cortextos>/dist/pipeline/deal-context.js coherence-check --dir outputs/deals/<slug>
```
Exit 0 = the proposal, pricing, and deal room all describe ONE deal: same slug, same
phase ids, every phase priced, no unresolved placeholder in the room, and the scoping
manifest agrees on the slug. Non-zero prints the exact mismatch (`PHASE_MISMATCH`,
`UNPRICED_PHASE`, `UNCONFIRMED_PRICE_IN_DEALROOM`, …) — fix it and re-check. Do NOT
hand the package to a human until this passes.

## Coherence contract (what "consistent enough to delegate" means)
| Guarantee | Enforced by |
|-----------|-------------|
| One deal slug collates every artifact | `deal-context.json.slug` + `slugifyClient` |
| Proposal scope == pricing line items == deal-room sections | phase-id set equality across the three artifacts (`<!-- phase: id -->`) |
| No phase quoted naked | every context phase must appear in the pricing artifact |
| No placeholder ships in the room | deal room must carry no `[CONFIRM PRICE]`/`[CONFIRM SCOPE]` |
| Live-external write is scoped before it's priced | `scoping-gate` integration gate (no override) |
| The two spines agree | scoping-manifest slug == deal-context slug |

## Worked example (fixture)
`state/skill-tests/solution-design-chain/` contains a runnable proof: a fictional
"Acme Co" deal with a proposal, pricing, and deal room that all share the phase spine,
plus a NEGATIVE variant where the pricing dropped a phase. Running the coherence check
on the positive dir exits 0; on the negative dir it exits non-zero naming the dropped
phase. See that directory's `README.md` for the exact commands and captured output.

## Rules
- **On-demand only.** No event/cron wiring. Josh drives it.
- **proposal-writer owns the phase ids.** Pricing and deal-room reuse them; they never
  re-invent phases.
- **Tag every phase heading** `<!-- phase: <id> -->`. That marker is what makes scope,
  pricing, and sections provably the same deal.
- **Coherence check is the gate to delegate.** A package that fails it is not done.
- **Each producer keeps its own gate.** This skill chains them; it does not weaken any
  producer's safety, price-confirmation, or grounding rule.
