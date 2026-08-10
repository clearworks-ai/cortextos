# Staging cortextOS — Design (do-it-right, 2026-08-09)

> Josh: "design staging right we need it i always break the fleet." Purpose = a DURABLE, isolated
> staging cortextOS instance so any fleet-touching change (cron/daemon/bus/worker) is proven live
> BEFORE it hits prod `cortextos1`. Replaces the ad-hoc, unproven Variant-C sketch.
> Non-negotiable: staging can NEVER touch prod state and can NEVER fire real side effects.

## Invariants (safety — must all hold before any launch)
1. **Instance isolation.** `CTX_INSTANCE_ID=cortextos-staging`; own home `~/.cortextos/cortextos-staging/`;
   own `daemon.sock`; ephemeral PTY ports (PR#94). Prod marker `~/.cortextos/state/ACTIVE_INSTANCE`
   stays `cortextos1` — staging is launched ONLY by explicit env var, never by flipping the marker.
2. **No prod writes.** Staging reads prod config to SEED (copy), never opens prod's home for write.
   Verify after every op: prod `daemon.pid`/`crons.json` mtimes unchanged.
3. **Side-effect muting (provable).** Staging agent env has NO Telegram bot token, NO Resend/SMTP,
   NO Slack, NO Twilio, NO webhook secrets. A global `CTX_STAGING=1` + blank creds → every send path
   fails closed. Proof gate: `grep -riE 'TELEGRAM|BOT_TOKEN|RESEND|SMTP|SLACK|TWILIO|WEBHOOK_SECRET'
   ~/.cortextos/cortextos-staging` returns only empty/placeholder values.
4. **Cost control.** Staging agents run a cheap model (haiku / glm) — never Opus/Sol. Prefer
   mechanics-only verification (cron fires, spawn receipts, bus writes) over full LLM reasoning.

## Seeding (config-only, secrets scrubbed — no copy of real .env)
- Copy from prod, per seeded agent: `config.json`, `crons.json`, `AGENTS.md` (non-secret).
- Write a FRESH staging `.env` / `secrets.env` with: cheap-model key only, ALL side-effect creds
  blank, `CTX_STAGING=1`. Never `cp` a prod `.env` (avoids a real-token window).
- Seed a REPRESENTATIVE subset, not the whole fleet: the agents whose fleet-mechanics we test —
  `larry-codex`, `frank2-codex`, `pa-codex`, `crm-codex` (+ one base `larry` to reproduce the
  base→codex stranding). Enough to catch fleet-breaking changes; cheap to run.
- Clean `enabled-agents.json` listing exactly the seeded subset (also the reference for the
  enabled-agents-repair we need to verify).

## Lifecycle scripts (the durable part — this is what makes it reusable)
- `staging-seed.sh` — (re)build `~/.cortextos/cortextos-staging/` from prod config with scrubbed
  secrets + muting. Idempotent; safe to re-run to refresh staging against prod drift.
- `staging-up.sh` / `staging-down.sh` — launch/stop the staging daemon with `CTX_INSTANCE_ID=cortextos-staging`.
- `staging-verify.sh` — assert isolation (separate socket, ACTIVE_INSTANCE unchanged) + muting
  (no live side-effect creds) BEFORE declaring staging usable.
- `staging-reset.sh` — wipe + reseed (staging is disposable).

## Promote path (how a fleet change ships)
change → apply on staging → `staging-verify` → reproduce/verify the change live on staging
(the LIVE receipt) → apply the SAME change to `cortextos1` → verify prod receipt. Control-plane
changes (cron registry, daemon spawn, bus mutation) NEVER go straight to prod.

## First use = Track B
Reproduce cron-stranding (cron under base `larry`, only `larry-codex` running → no fire), then prove
the fix (move entry → -codex, reload → fires), the enabled-agents repair, and the FR-B3 alarm — all
on staging, then apply to prod.

## Open choice (pick during build, don't stall)
Staging agent runtime: cheap real LLM (haiku) vs a stub/echo runtime. Default = haiku for the seeded
subset; revisit if a stub runtime exists that fires crons without LLM cost.
