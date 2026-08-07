# Master Plan — Calasia Project Delivery Command Center

## Feature summary
A static, single-page visual prototype for CalAsia Construction (design-build; contact: Rob) showing a centralized "delivery spine" over their existing Excel/folder system: per-project phase, checklist status, owner, and next action from lead through closeout. Sales prototype for a follow-up call — must look polished, calm, and construction-real, not generic SaaS.

Target repo: `clearworks-ai/calasia-construction-command-center` (empty, public, created by frank2 2026-08-05). Do NOT touch `clearworks-ai/kadre-os-room-74328219` — it is a live separate client site used only as the format reference.

## Non-goals
- No Procore replacement, no AI product framing, no platform recommendation.
- No backend, persistence, auth, or build step. No React/Vercel (brief superseded by Josh's Kadre-pattern decision in 00-discovery.md).
- No real client project data — sample/fictional projects only.
- No IT/cybersecurity content.
- No GitHub Pages publish, no merge — PR only.

## Architecture approach (Kadre reference pattern, verified in 01-research.md)
- Repo root: `index.html` + `assets/` — exactly two entries, matching the Kadre repo shape.
- `index.html`: hand-authored single file. Inline `<style>` block (CSS variables for the CalAsia palette: warm orange + charcoal/gray; Google Fonts import allowed). Inline `<script>` vanilla JS.
- View switching: tab-based, `.view` / `.view.on` class toggle (Kadre pattern). Filters, stage controls, task toggles, and drawers are all local-state JS — no network calls except loading assets/fonts.
- `assets/`: CalAsia logo (source: `https://calasiaconstruction.com/wp-content/uploads/2023/10/logo-new.png` — verify it loads, download a local copy) + real project photos pulled from `calasiaconstruction.com/projects/`. No stock imagery.
- Sample data: a JS object literal in the same file (6 projects, tasks, records, queue items) — keeps the whole prototype one self-contained artifact.
- GitHub Pages legacy mode serves `main` root directly, so the built branch needs zero CI config. Do not add `package.json`, workflows, or `railway.*` files.

## Shard list
**One spec.** The 6 views share one data model, one stylesheet, one tab system, and one file; splitting would create merge overhead with no isolation benefit.

| Spec | File | Scope |
|---|---|---|
| 01 | `03-specs/01-command-center.md` | Entire prototype: all 6 views, drawers, sample data, branding, assets |

## File ownership
| Path (in target repo) | Owner | Notes |
|---|---|---|
| `index.html` | codexer (spec 01) | Single-file app: markup + inline CSS + inline JS + data |
| `assets/*` | codexer (spec 01) | Downloaded logo + real CalAsia project photos |
| `README.md` (optional, 1 short paragraph) | codexer (spec 01) | What this is, sample-data disclaimer |

Greenfield repo — no read-only files, no shared-checkout risk. Build in an isolated worktree/clone of the target repo, not the cortextos checkout.

## Test / validation strategy
No framework, no test runner — validation is manual/visual, performed by codexer before PR and re-verified by larry at review:

1. **Loads clean:** open `index.html` from disk (`file://`) — renders with zero console errors; all assets load locally (no broken images).
2. **All 6 views present and reachable** via tabs: portfolio dashboard, Cedar Grove command center, master checklist, Existing Project Records panel, drawers (all 6), role queues (all 4).
3. **Interactions work:** portfolio filters (phase / owner / attention-needed) actually filter; lifecycle spine stage advance/pause/manual-override changes visible state; checklist tasks toggle complete; every drawer opens and closes.
4. **Branding is real:** CalAsia logo in header, orange/charcoal palette, real project photos from calasiaconstruction.com — screenshot-check no stock/placeholder imagery.
5. **Content audit:** 7 lifecycle stages in exact order; the 10 mandated checklist tasks all present; 11 record categories all present; 6 sample projects named; zero IT/cybersecurity mentions; zero real client data.
6. **Evidence:** codexer attaches screenshots of each view (browser-harness or equivalent) to the PR description.

## Rollout / approval gates
1. codexer builds on a feature branch in `clearworks-ai/calasia-construction-command-center`, opens a PR with view screenshots. **No merge.**
2. larry reviews (visual + content audit against checklist above).
3. Josh approves. Only then: merge + enable GitHub Pages (legacy, main root). Rob receives the link 24–48h before the follow-up call, per the brief's timing — that send is also Josh-gated.
4. Hard stops: never merge, never flip Pages settings, never touch the Kadre repo.
