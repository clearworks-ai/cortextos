# Solution-Design Chain — Fixture Coherence Evidence

Tests for the on-demand 5-stack chain (S1 lane). Two fixture deals live here:

| Directory | Intent |
|---|---|
| `acme-co/` | POSITIVE — all three artifacts share the phase spine; coherence-check exits 0 |
| `acme-co-INCOHERENT/` | NEGATIVE — pricing drops a phase, deal room has an unresolved placeholder; coherence-check exits 1 and names every violation |

## How to run

```bash
# Build first (once per session)
npm run build -C /path/to/cortextos

# Positive fixture — must exit 0
node dist/pipeline/deal-context.js coherence-check \
  --dir state/skill-tests/solution-design-chain/acme-co

# Negative fixture — must exit 1 and name violations
node dist/pipeline/deal-context.js coherence-check \
  --dir state/skill-tests/solution-design-chain/acme-co-INCOHERENT

# Scoping gate on positive fixture — must exit 0
node dist/pipeline/scoping-gate.js --check --action deal-room \
  --manifest state/skill-tests/solution-design-chain/acme-co/scoping-manifest.json
```

## Captured output (2026-08-10 · coherence evidence for S1 PR)

### Positive fixture (`acme-co/`) — exit 0

```json
{
  "ok": true,
  "slug": "acme-co",
  "phases": [
    "phase-0-audit",
    "phase-1-build",
    "ongoing-retainer"
  ]
}
```

**Scoping gate (`--action deal-room`)** — exit 0:

```json
{"ok":true,"action":"deal-room","slug":"acme-co","manifest":"<path>/acme-co/scoping-manifest.json"}
```

### Negative fixture (`acme-co-INCOHERENT/`) — exit 1

```
INCOHERENT (acme-co):
  PHASE_MISMATCH: pricing-analyst phase set != deal spine — missing [ongoing-retainer]. Every stage must reuse the deal-context phase ids (marker "<!-- phase: id -->").
  UNPRICED_PHASE: phase 'ongoing-retainer' has no pricing line in the pricing artifact.
  UNCONFIRMED_PRICE_IN_DEALROOM: deal-room still contains a [CONFIRM PRICE]/[CONFIRM SCOPE] marker — resolve it (founder decision) before the room ships.
```

## What the coherence check proves

| Guarantee | Positive result | Negative (caught) |
|---|---|---|
| One deal slug collates all artifacts | `acme-co` matches | — |
| Proposal scope == pricing line items == deal-room sections | All 3 phases present in all 3 artifacts | `ongoing-retainer` missing in pricing |
| Every context phase is priced | 3/3 priced | `ongoing-retainer` unpriced |
| No placeholder ships in the room | No `[CONFIRM *]` left | Caught `[CONFIRM PRICE: $X]` in deal-room |
| Scoping gate: integration ran before deal-room | exit 0 | N/A (not tested on INCOHERENT) |

## Deal spine (positive fixture)

The three artifacts — `proposal.md`, `pricing.md`, `deal-room.md` — all thread through:

```
phase-0-audit    → Audit & Pilot         → $7,500 (deal-room confirmed price)
phase-1-build    → Lead-Triage Build     → $34,000 (deal-room confirmed price)
ongoing-retainer → Retainer & Iteration  → $2,750/mo (deal-room confirmed price)
```

Proposal authored the phase ids; pricing-analyst and deal-room-producer reused them exactly
(machine marker `<!-- phase: <id> -->`). This is the coherence guarantee: scope, pricing, and
sections describe ONE deal.
