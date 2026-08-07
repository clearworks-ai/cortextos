# Discovery — Calasia Project Delivery Command Center

## What
A static, single-page (no backend, no build step) visual prototype showing a construction/design-build client (Calasia) a "central spine" view of their project delivery process, without replacing their existing Excel/folder system.

## Target repo
`clearworks-ai/calasia-construction-command-center` — new, EMPTY repo created by frank2 2026-08-05 (replaces earlier wrong target `clearworks-ai/kadre-os-room-74328219`, which is a LIVE separate client site — do not touch it, only use it as a reference pattern).

## Format decision (Josh, 2026-08-05 Telegram, overrides brief doc)
Brief doc (`orgs/clearworksai/agents/auditmaster-codex/outputs/solutions-engineer/2026-08-05-1619-callasia.md`) says "React app, deploy to Vercel" — SUPERSEDED. Real format: copy the Kadre OS proposal site's pattern. Verified via `gh api repos/clearworks-ai/kadre-os-room-74328219`:
- GitHub Pages, `build_type: legacy`, served from `main` branch root (`path: "/"`).
- Repo root contents: `index.html` + `assets/` dir only — no `package.json`, no build config, no framework.
- `index.html` is hand-authored: inline `<style>` CSS, tab-based view switching (`.view.on` class toggle), no React/bundler — plain HTML/CSS/vanilla JS single file.
- So: CalAsia build must be the same shape — a single self-contained `index.html` (+ `assets/` for images/logo) with client-side JS for filters/tabs/drawers, no framework, no build step, no backend. Simpler than a React app in tooling, same in UI/interaction scope.

## Brand (real, verified sources)
- Logo: `https://calasiaconstruction.com/wp-content/uploads/2023/10/logo-new.png`
- Palette: warm orange + charcoal/gray.
- Project photos: real, from `calasiaconstruction.com/projects/` — NOT stock photos.
- Company: real CalAsia Construction, design-build.

## Scope corrections (Josh + frank2, 2026-08-05, on top of brief)
1. GitHub Pages static site, not Vercel/React (see Format decision above).
2. Real CalAsia brand assets (logo + real project photos), not generic placeholders.
3. Lifecycle stages, exact order: Lead Intake -> Qualification -> Estimating & Bid -> Award & Turnover -> Production -> Billing & Change Orders -> Closeout.
4. Exclude IT/cybersecurity entirely (per Josh's direction, brief's own Evidence Boundary section already says this).
5. Realistic SAMPLE data only — never real client project data (Cedar Grove, Harbor View, + 4 more fictional projects, per brief).
6. No publish/deploy of GitHub Pages without Josh's explicit approval after larry reviews — codexer builds + pushes a PR only. Never merges, never flips Pages settings live.
7. auditmaster-codex (separate reviewing agent) additionally wants preserved: 7-stage delivery spine, project owner/checklist/next-action/blockers visible per project, existing Excel/folder records surfaced as sources of truth (not replaced) — all of this is already in the brief's required views below, just confirming it's not dropped.

## Required views (from brief, unchanged)
1. Portfolio dashboard — 6 sample projects, each showing lifecycle phase, checklist completion %, overdue/blocked tasks, PM, superintendent, next action, last activity. Filters: phase, owner, attention-needed.
2. Project command center for **Cedar Grove Renovation** — horizontal lifecycle spine across top, stage advance/pause/manual-override controls.
3. Grouped master checklist — every task has owner, due date, completion state, source doc/form, one-click link to existing work area. Must include: create project folder, validate lead record, publish standardized RFP, confirm subcontractor responses, complete job startup checklist, submit daily report, review two-week look-ahead, log change order, issue billing package, finish completion list.
4. Existing Project Records panel — Plans, Scopes, Estimating Schedule, Subcontractor Bids, Production Schedule, Daily Reports, Site Photos, Budget, Billing, Change Orders, Closeout.
5. Drawer/modal prototypes — New Lead Intake, Standard Bid Package, Daily Field Report, Photo Log, Two-Week Look-Ahead, Change Order.
6. Role-aware work queues — Estimator, Project Manager, Superintendent, Accounting.

## Sample data
Cedar Grove Renovation, Harbor View Addition, + 4 more fictional projects. Realistic subcontractor trades, bid due dates, field-photo captions, change-order examples. All illustrative — not real client data.

## Non-goals
- Not a Procore replacement, not an AI product.
- Not locking Calasia into a platform choice.
- No backend, no persistence, no auth — local-only JS interactions (filters, stage selection, task completion, form drawers).
- No deploy/publish of GitHub Pages without Josh's sign-off.

## Plan engine
Fable (Josh's standing answer for planning tonight, 2026-08-05 session).
