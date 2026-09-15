# Why the G4 dry-run carries an `escalated` block

The checker (G0B3-4) requires every outcome shape a real inbox produces — filed,
ignored AND escalated — in the one dry-run evidence file. A read-only scan of the REAL
CRM copy (657 contacts, 402 distinct emails) through the real resolver
(`resolve_email.EmailResolver.resolve_address`) found ZERO ambiguous senders
(`ambiguity-scan.txt`): no contact whose CRM company slug differs from the slug its
domain declares. So the escalated path is unreachable from the live inbox today.

The G4 run therefore uses a CRM COPY (`crm-g4`) with ONE declared edit: contact
`accounting-department` (accounting@alloi.us, company `alloi.us`) has its company set to
`Doug Teiger Consulting`, so the resolver yields `escalated ambiguous:doug-teiger-consulting|alloi`
for that sender. Everything else is the real inbox through the real code path (real
`gws` reads, real escalation text preview, `send-telegram --source-key clientstate:…`
trapped by the shim, escalate-once across the sender's messages). Production CRM was
never touched (`no-prod-writes.json`). Recorded on the build ledger 2026-09-15.
