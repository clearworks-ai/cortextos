# Telegram authorization-disclaimer guard

## Goal

Prevent routine statements that an agent will not take an action without approval from reaching the owner-facing Telegram send path.

## Scope

- Add a pure classifier for routine authorization-disclaimer phrasing.
- Enforce it before deduplication and Telegram delivery in `bus send-telegram`.
- Preserve explicit approval requests and material incident reporting.
- Cover allow/block behavior with unit tests.

## Acceptance

1. `I will not deploy without Josh's approval.` is rejected before `sendMessage`.
2. `Please approve the production deploy?` is delivered.
3. `Incident: production deploy failed; rollback is running.` is delivered.
4. Existing normalization behavior remains green.
