# Deal Room: Acme Co · lead-triage + quote automation

## Hero
Acme Co — the lane that triages every lead and drafts the quote before your team opens it.

## The Problem
"Every lead sits in a spreadsheet until someone remembers to look." Two ops people,
most of a day, on triage and hand-built quotes.

## The Solution
An automated triage + quoting lane, filed straight against the CRM record. Your team
reviews and sends instead of building.

## Scope & Phases

### Audit & Pilot
<!-- phase: phase-0-audit -->
Map the flow, run a read-only pilot on 20 real leads. Price: $7,500.

### Lead-Triage Build
<!-- phase: phase-1-build -->
Idempotent CRM sync, calendar sync, quote drafting from the price book. Price: $34,000.

### Retainer & Iteration
<!-- phase: ongoing-retainer -->
Tuning, new price-book rules, monitoring. Price: $2,750/mo.

## Proof
Comparable lead-ops automation cut a prior client's triage time ~70% (anonymized).

## Pricing
Phased, value-first: $7,500 → $34,000 → $2,750/mo. Anchored to ~$100k/yr of ops time today.

## FAQ
- Does it write to our CRM safely? Yes — every write is idempotent; retries can't dupe.
- What if a lead is ambiguous? It's flagged for human review, never guessed.
- Can we start small? Yes — Audit & Pilot is the low-risk entry.

## Next Step
Reply to confirm and we'll send the agreement.
