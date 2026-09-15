# Client State v1 — Gmail thin slice — R3 TIER B: Gmail push infrastructure (`goal-client-state-gmail-v1-tierb`)

```text
WORKFLOW PACK: fast-release (single release; HUMAN-GATED entry)
  Split reason: patch-1 spec FR-011 is bucket D — the Pub/Sub topic, push subscription
  and API enablement live in GCP project `cortextos-gws-495505` and are UNVERIFIABLE
  from this host (no gcloud; G-28..G-30); Josh (or an agent with gcloud on that project)
  provisions them (A-07). Everything code-side (hub integration, bridge lane auth mode +
  subscription config + durable-enqueue-before-ack, watch-renewal cron, activation
  manifest probe) is built here; the lane flips `active` only in the activate goal after
  the manifest probe is green. Depends on `goal-client-state-gmail-v1-delta` (the
  `--history-id` entry and cursor semantics it wires to).
  bonesify: chain `/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`,
  node `goal-client-state-gmail-v1-tierb`, staging mutex `cortextos-staging`.

ENTRY GATE (HALT until ALL hold — quote the evidence on the ledger before any write):
  E1. `goal-client-state-gmail-v1-delta` is `done` and its G3 merge is in
      `origin/feature/client-state-gmail-v1`.
  E2. Josh's explicit go for this goal in THIS session's transcript (the hub + bridge
      changes are production surfaces: webhook-hub deploys from `main` on Railway; the
      bridge runs under launchd on this host).
  E3. Provisioning receipt from Josh or a gcloud-equipped agent, quoted on the ledger:
      topic `projects/cortextos-gws-495505/topics/<name>` exists with
      `gmail-api-push@system.gserviceaccount.com` as Publisher; a push subscription
      targets `https://<hub>/webhooks/gmail-pubsub` with an OIDC token for a named
      service account; Gmail + Pub/Sub APIs enabled. Without E3 the goal can still build
      and unit-test the code side (E1+E2) but MUST stop before the live G4 items and
      record `provisioning: pending` as a carried blocker — never fabricate a receipt.

MODEL MAP: as the delta goal (sonnet plan; opus G0a + risk packages P-bridge, P-hub;
codex G0b/G2a/G2b; grok skipped-by-Josh; Fable FINAL). TS gates: `npx tsc --noEmit -p
tsconfig.json` + the named vitest files (bridge lane tests) + hub repo `npm test`.

SOURCE OF TRUTH
- Patch spec FR-011 (BINDING, items 1–5 + the lane-resolver rule), FR-002 Tier B bullets,
  API Contracts rows, G-18, G-19, G-22, G-26..G-35:
  `/Users/joshweiss/code/cortextos/state/specs/2026-09-15-client-state-gmail-v1-patch1-spec.md`
- Delta goal + its ledger (the `--history-id` entry, cursor file, queue):
  `/Users/joshweiss/code/cortextos/docs/pipeline/goals/2026-09-15-client-state-gmail-v1-delta-goal.md`
- Chain / ledger: `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-tierb.md`
- Plan: `/Users/joshweiss/code/cortextos/docs/pipeline/plans/2026-09-15-client-state-gmail-v1-tierb.md`
- Anchors (re-verify before they decide a gate): bridge lane handler + missing OIDC
  verifier `src/daemon/provider-shadow-ingress.ts:144-168`, `:200-233` (subscription
  check `:213`, cursor-before-spawn `:225-233`); lane config `src/daemon/provider-lane-config.ts:37-43`,
  `:68-69`; live server constructs no `gmailShadow` `src/daemon/webhook-bridge.ts:723-748`,
  `:1127-1136`; hub `~/code/webhook-hub/src/server.ts:31,35`, `integrations/index.ts:1-10`,
  `relay.ts:45-66` (bridge secret, no Authorization header); Railway variable NAMES only
  (G-33); DWD identity + scopes (G-31); `users.watch` 7-day renewal (G-22).

STANDING RULES: the delta goal's STANDING RULES apply verbatim (generated regions,
workspace discipline, external-write boundary, watchdogs, standing facts) with these
deltas:
- **Workspace.** cortextos: worktree `feat/client-state-gmail-v1-tierb` cut from
  `origin/feature/client-state-gmail-v1` after E1. webhook-hub: `~/code/webhook-hub` on
  a branch `feat/gmail-pubsub-integration` from its `main`; `railway variables` names
  only — never print values; never `railway up` (auto-deploy on merge to main is Josh's
  /promote there too).
- **FR-010 allowlist for this goal:** `src/daemon/provider-shadow-ingress.ts`,
  `src/daemon/provider-lane-config.ts`, `src/daemon/webhook-bridge.ts` (gmail lane
  option wiring only), their tests, `scripts/brain/gmail_watch_renew.py` (new), hub
  `src/integrations/gmail-pubsub.ts` (new) + `integrations/index.ts` registration + tests,
  `docs/pipeline/**`. Nothing else.
- **External-write boundary.** No `users.watch` call before E3; the renewal script is
  built with `--dry-run` and tested against a fake client. No Pub/Sub publish. No
  bridge restart (`cortextos webhook-bridge restart` is the activate goal's, after
  Josh's go). No lane flip: `provider-config.json` stays absent/shadow. Hub changes are
  merged to hub `main` ONLY by Josh's promote.
- **Locked decisions:** FR-011 items 1–5; the hub-verified second auth mode (a valid
  `x-webhook-bridge-secret` relay is accepted; OIDC Bearer stays for direct delivery);
  durable enqueue BEFORE ack; `active` in config alone never enables Tier B — the
  activation manifest probe must be green; initial cursor = persisted `users.watch`
  historyId.

RELEASES
[R3] Packages: P-bridge (lane auth modes, `subscription` config, enqueue-before-ack
  into `<state-dir>/inbox-queue.jsonl` via the delta goal's `inbox_queue` contract — the
  bridge is TS, so it writes the same one-line JSON shape with `O_APPEND`; a Python
  fixture test in the delta module reads a bridge-written line; then a detached drain
  `client_state_gmail.py --drain-queue …`; `gmail_not_configured` diagnostics; vitest
  incl. mutation rows: ack-before-enqueue ⇒ RED, secret-mode disabled ⇒ hub relay 401);
  P-hub (`gmail-pubsub` integration: OIDC verify with audience + service account from
  env, relay envelope verbatim, 401 on bad token, tests); P-renew
  (`scripts/brain/gmail_watch_renew.py --dry-run`: DWD identity, persists returned
  `historyId` + expiration to the cursor file, cron text `bus add-cron pa-codex
  gmail-watch-renew "0 6 */6 * *" …` written to `activation-r3.md`, NOT installed);
  P-manifest (`scripts/brain/gmail_tierb_manifest.py`: probes hub `/healthz`, hub
  integration presence, bridge lane config, cursor file freshness, watch expiration;
  the lane resolver consults its JSON — `active` + red manifest ⇒ shadow + diagnostic).
  DONE when: G0 (compile both languages + opus + codex; grok skipped) → plan stamped →
  G1 (COUNT DELTA vs BASELINE-r3: vitest + pytest named new tests; hub suite green) → G2
  (codex review + challenge; allowlist empty; locked-decision findings rejected by row)
  → G3 PR merged into `feature/client-state-gmail-v1` (cortextos) + hub PR OPEN against
  hub `main` (NOT merged — Josh) → G4 `record-gate --gate G4-matrix` over:
    1. `suite.json` counts at merge SHA; 2. `bridge-lane.json`: local bridge test server
    (NOT the launchd one — a vitest-spawned instance on an ephemeral port) accepts a
    hub-secret relay of a recorded envelope, enqueues BEFORE responding 200 (assert
    queue line exists when the response is sent — instrumented), rejects a bad secret
    and a bad OIDC token, and in `active`+red-manifest resolves to shadow; 3.
    `hub-integration.json`: hub tests green + a local `node` run of the integration with
    a recorded OIDC token fixture (expired ⇒ 401); 4. `renew-dry-run.json`: the renewal
    script against a fake client persists the historyId and expiration; 5.
    `manifest.json`: probe output on this host = RED with each missing item named
    (E3 pending) or GREEN with the receipts; 6. `no-prod-writes.json` (no watch call, no
    publish, no restart, no lane flip, no hub deploy); 7. `floor.txt`.
  FINAL: Fable once on `<kickoff>..<HEAD>` + artifacts; `record-gate --gate FINAL-review`.

DONE: R3 DONE-when + FINAL clean from this session's own output → `b mark-done … --evidence`
with `matrix: GREEN`, merge SHA, gate invocations; carried blockers: hub PR merge (Josh),
provisioning receipt if E3 was pending, lane flip + bridge restart (activate goal).

HALT: (0) ENTRY GATE E1–E3 (E3 may be pending: build + unit-test, stop before live G4
items 2–3's OIDC-live variants and item 5 GREEN, record `provisioning: pending`);
(1) a gate fails — stop, report; (2) spec ambiguity — stop, ask; (3) done — Learn-from
proposal, report with carried blockers, await /promote. No auto-promote; no hub deploy;
no lane flip; no bridge restart.

OVERRIDE: `/stage` = PR `feat/client-state-gmail-v1-tierb` → `feature/client-state-gmail-v1`
(plain merge) + hub PR opened, not merged. `/test-on-staging` = G4 items 1–7. Grok gates
recorded `skipped-by-Josh`. Zero production writes; zero GCP writes.
```
