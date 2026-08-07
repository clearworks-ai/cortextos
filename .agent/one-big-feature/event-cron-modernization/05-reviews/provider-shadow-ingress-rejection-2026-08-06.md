# Independent Security/Correctness Review — REJECT

Status: REMEDIATION REQUIRED

## Findings

1. Calendar event identity used resource state as `eventType`, so the same channel/resource/message number could be accepted twice when state changed. Identity must be constant `calendar/notification`; state affects validated routing only.
2. Body-limit rejection continued retaining later chunks. After the limit, stop retaining immediately and drain/destroy without buffering.
3. Proposed-route dedup scanned only the newest 2,000 receipts while ingress dedup retains more. Replace tail scanning with an atomic durable indexed route-proposal claim and crash/retry healing.
4. Provider failures could theoretically reach the bridge outer catch that returned raw error details. Provider requests must only return stable redacted codes; remove raw details.

Production provider configuration may remain explicitly fail-closed in this code-only/no-live-config PR. Do not create provider resources or calls.

## Required regressions

- Calendar same channel/resource/message with `sync→exists`, `exists→not_exists`, and reordered states produces one identity and at most one proposal.
- Multi-chunk streaming continues after crossing the body limit without retaining later chunks.
- Duplicate retry after >2,000 intervening receipts and restart still has one proposal.
- Calendar receipt failure, cursor failure, and retry healing.
- Provider response-write/error failures never expose injected mailbox/JWT/subscription/channel/token/resource/body values.
- Provider buckets cannot starve Fireflies/Ops.
- Both success and failure paths create zero processing receipts, inbox files, wake signals, inbound logs, worker/provider calls, or infrastructure mutations.

## Gate

Expanded focused/broader tests, typecheck, build, diff-check, and fresh independent review must PASS.
