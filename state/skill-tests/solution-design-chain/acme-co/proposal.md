# Proposal: Acme Co · lead-triage + quote automation
**Prepared:** 2026-08-10
**For:** Dana Okafor, COO
**Patterned from:** default structure
**OUTCOME:** pending

---

## The Problem
"Every lead sits in a spreadsheet until someone remembers to look" — Dana's words on
the call. Two ops people spend most of a day triaging inbound and hand-building quotes.

## What We'll Build
An automated lane that triages every inbound lead, drafts a quote from your price book,
and files it against the CRM record — so the ops team reviews and sends instead of
building from scratch.

## Audit & Pilot
<!-- phase: phase-0-audit -->
- Map the current triage + quoting flow end to end
- Wire a read-only pilot against 20 real leads
- **Done when:** the pilot reproduces last week's triage decisions
- Investment: [CONFIRM PRICE: $X]

## Lead-Triage Build
<!-- phase: phase-1-build -->
- CRM sync (idempotent), calendar sync for booked calls
- Quote drafting from the price book
- **Done when:** every new lead lands triaged + quote-drafted in the CRM
- Investment: [CONFIRM PRICE: $X]

## Retainer & Iteration
<!-- phase: ongoing-retainer -->
- Tuning, new price-book rules, monitoring
- **Done when:** monthly — the lane stays accurate as the offer changes
- Investment: [CONFIRM PRICE: $X/mo]

## Timeline
- Audit & Pilot: begins on signing (~2 weeks)
- Lead-Triage Build: begins on Phase 0 sign-off (~4 weeks)
- Retainer: begins on Build acceptance

## Next Step
Reply to confirm and we'll send the agreement.

---

## ⚠ Confirm Before Sending
- [CONFIRM PRICE] on all three phases (see Investment lines)
