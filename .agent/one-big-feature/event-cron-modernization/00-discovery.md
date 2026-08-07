# Discovery — Existing-Infrastructure Provider Ingress

Josh verbatim (2026-08-07):

> "gor gmail and gcakl use the same infra as fireflies and ops inbound dont build new external infra"

The implementation must extend the existing `webhook-bridge`/Cloudflare ingress and PR #322 durable receipt/router primitives. It must not create a new hosted service, public endpoint stack, queueing system, cloud project, daemon, or deployment target.
