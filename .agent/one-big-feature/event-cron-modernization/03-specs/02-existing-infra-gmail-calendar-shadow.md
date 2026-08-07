# Gmail + Calendar Shadow Ingress on Existing Fireflies/Ops Infrastructure

Status: APPROVED by Larry

## Scope

Extend the existing `src/cli/webhook-bridge.ts#createBridgeServer` process and its existing `/relay/:integration` tunnel rule with in-process branches for `gmail-pubsub` and `calendar-watch`. These are callback path suffixes on the existing hostname, port 20242, launchd service, and Cloudflare tunnel—not a second server, listener, process, or endpoint stack. Reuse PR #322 `recordIngressReceipt`, `ShadowRouter`, cursor index, state directories, process, port, tunnel, deployment, and telemetry. Processing receipts and inbox transport remain unchanged but are reserved for a later active-mode PR and must not be called by this shadow PR.

No new external infrastructure may be created. This change is code + tests in shadow mode only: no topic/subscription/watch/IAM creation, no live Gmail/Calendar call, no cron/schedule change, no provider credential write, no deployment.

## Gmail adapter

- Accept Google Pub/Sub push envelopes only on `/relay/gmail-pubsub`.
- Authenticate through an in-process verifier/JWKS dependency seam suitable for Google OIDC verification; the production default must fail closed. Require signature against Google keys, allowed issuer, exact existing-tunnel callback audience, `exp`, bounded `iat`/clock skew, `email_verified`, exact configured push-auth service-account identity, and exact Pub/Sub subscription before decoding.
- Strictly bound body and decoded payload; canonicalize mailbox email + numeric history ID without logging message content.
- Decode `message.data` only after authentication. Require strict base64 and exact JSON fields `emailAddress` and canonical digit-string `historyId`.
- Record a durable ingress receipt and propose route code `pa.comms-check-worker` in `shadow` mode only. The eventual existing consumer is PA's `.claude/skills/comms-check-worker/SKILL.md`.
- Add arbitrary-precision numeric compare-and-set semantics using canonical digit strings with `BigInt` or length-plus-lexical comparison, never JavaScript `Number`. Reject signs, decimals, whitespace, empty values, leading-zero ambiguity, and bounded-length violations.
- Shadow writes only `gmail.shadow.notification_high_water`; it must never touch the future active `gmail.processed_history_cursor`.
- Return redacted stable error codes only.

## Calendar adapter

- Accept empty-body Calendar watch notifications only on `/relay/calendar-watch`.
- Validate `X-Goog-Channel-ID`, `X-Goog-Resource-ID`, documented resource state, `X-Goog-Message-Number`, expiration, and a constant-time configured channel-token digest through atomic files beneath the existing cortextOS agent state directory. Token comparison must be safe for unequal lengths. Reject unknown/expired channels and channel/resource mismatches.
- Treat notification as a fetch hint only; do not claim it contains the event. Record a durable ingress receipt and propose route code `pa.booking-calendar-delta` in shadow mode only. The eventual existing consumers are PA's `scripts/booking_coordinator.py calendar-delta` and the existing booking/pre-meeting worker seam.
- Treat initial `sync` as acknowledged registration evidence, not a calendar-change worker proposal.
- Enforce arbitrary-precision numeric monotonic message-number semantics and duplicate/out-of-order safety. Cursor keys are scoped by channel ID + resource ID so overlapping renewal channels work and a new channel's counter may restart.
- Shadow notification high-water is distinct from the future active Calendar API sync token and canonical event snapshot.
- Return redacted stable error codes only.

## Shared invariants

- Provider handlers execute before the generic bridge-secret/envelope branch; existing Zoom, Fireflies, and ops behavior must remain unchanged. Provider branches use smaller explicit body/header bounds and provider-scoped rate accounting so Google bursts cannot consume Fireflies/Ops capacity.
- Shadow router cannot receive a delivery capability and therefore cannot enqueue/wake a worker.
- Shadow writes only ingress plus routing `proposed`; it must not write processing started/succeeded, call `sendMessage`, `wakeFastChecker`, `appendInboundLog`, or spawn a worker.
- Receipt persists before notification high-water advances. Cursor never advances if receipt persistence fails. If receipt persists and cursor write fails, the retry must heal/advance the cursor even though ingress is already duplicate. Concurrent copies yield one accepted receipt and one monotonic high-water result.
- Valid first-seen shadow notifications return 2xx after accepted + proposed receipts. Duplicate/stale/out-of-order notifications record a durable duplicate/rejected classification and return 2xx. Transient receipt/cursor/storage failures return non-2xx. Permanent auth/schema failures return stable redacted 4xx.
- Stable identity excludes local receive time: Gmail mailbox identity + history ID (Pub/Sub message ID only secondary telemetry); Calendar channel + resource + message number.
- No raw mailbox, JWT, subscription, channel token, resource ID, message body, attendees, or subject in responses, receipts, logs, thrown errors, or inbound files. Provider errors may not fall through to the bridge's raw outer `details` response.
- If an existing Ops Inbound Google project/topic/subscription is not available for reuse, live Gmail activation is blocked. This work must not create a replacement. Calendar watch registration/renewal is an unavoidable provider lease attached to the existing tunnel, not new infrastructure.
- Add unit/integration coverage to existing webhook bridge, event receipt/cursor, and tunnel route suites.

## Gates

- Existing bridge and PR #322 tests remain green.
- Gmail tests cover signature, issuer, audience, expiry/future `iat`, verified/exact service account, subscription, strict base64/JSON, required fields, provider bounds, huge numeric IDs, `9→10`, duplicate/decreasing, concurrency, restart dedup, receipt/cursor failure ordering and retry healing.
- Calendar tests cover required/duplicate headers, token mismatch, unknown/expired channel, channel/resource mismatch, allowed state and `sync`, empty-body enforcement, huge message IDs, duplicate/out-of-order, overlapping renewal channels, and new-channel counter reset.
- Isolation tests prove provider traffic cannot exhaust Fireflies/Ops capacity and shadow creates zero inbox files, wake signals, inbound logs, worker calls, or processing receipts.
- Leakage assertions cover responses, receipts, captured logs, and thrown errors. Tests prove no watch/provider call, IAM/topic/subscription creation, cron mutation, deployment, or external call.
- Typecheck, build, `git diff --check`, and fresh independent security/correctness review pass.
