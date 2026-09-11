# CRM test fixtures — anonymization rule

`contacts.json` mirrors the *shape* of the real
`orgs/clearworksai/agents/crm-codex/crm/contacts.json` (which `.gitignore` deliberately
excludes) but carries no real PII. Per row, only `id`, `name`, `company`, `emails`,
`aliases`, `type` survive — every other real-CRM field (phones, notes, context,
enrichment, source_refs, tags, ...) is dropped because `resolve_meeting.py` never
reads them.

Rules when regenerating:
- `id` -> `fixture-NN` (sequential).
- `emails` -> same count as the source row; local-part -> `contactNN`; real domain
  kept (domain-label resolution is what the resolver tests exercise). Rows with no
  emails stay empty.
- `company` stays verbatim (drives the client/org slug resolution under test).
- `name` stays verbatim ONLY for a person a test participant actually names;
  every other row becomes `"<Company> Contact NN"`.
- `org-aliases.json` has no PII and is copied as-is.
