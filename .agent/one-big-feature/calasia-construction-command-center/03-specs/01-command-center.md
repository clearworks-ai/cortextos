# Spec 01 — Calasia Project Delivery Command Center (entire prototype)

## Objective
Build a polished, static, single-page prototype ("Calasia Project Delivery Command Center") for CalAsia Construction, a design-build firm running on Excel/folders. It demonstrates a central delivery spine — where each project is, who owns the next step, what's incomplete, what happens next — while presenting the existing Excel/folder records as the retained source of truth (not replaced). Desktop + tablet layout; calm, legible, construction-real; not a generic SaaS dashboard. No AI framing, no Procore comparison, no platform recommendation.

## Target repo / owned files
Repo: `clearworks-ai/calasia-construction-command-center` (empty, greenfield). Work in an isolated clone/worktree.

Owned (create):
- `index.html` — the whole app: markup, inline `<style>` CSS, inline `<script>` vanilla JS, sample data as a JS object literal.
- `assets/*` — CalAsia logo + real project photos (downloaded local copies).
- `README.md` (optional) — one paragraph: what it is + "all project data is illustrative sample data."

Read-but-not-edit: none (greenfield). Reference only: the Kadre pattern description below — do NOT clone or read from the live `kadre-os-room-74328219` repo beyond pattern confirmation, and never modify it.

Forbidden files: `package.json`, any build config, CI workflows, `railway.json`/`railway.toml`.

## Architecture constraints (non-negotiable)
- Vanilla HTML/CSS/JS. No framework, no bundler, no build step, no backend, no persistence, no auth.
- Single `index.html`; view switching via `.view` / `.view.on` class toggles on tab click (Kadre pattern).
- All interactions are local JS state: filters, stage selection, task completion toggles, drawer open/close.
- Must render fully from `file://` with zero console errors (fonts via Google Fonts import are acceptable; images must be local in `assets/`).

## Branding (real, mandatory)
- Logo: download `https://calasiaconstruction.com/wp-content/uploads/2023/10/logo-new.png` → `assets/`. Verify it loads before embedding; if the URL is dead, fetch the current logo from calasiaconstruction.com — do not substitute a generic mark.
- Palette: warm orange primary + charcoal/gray, as CSS variables.
- Project photos: real images pulled from `calasiaconstruction.com/projects/`, saved to `assets/`. NO stock or AI-generated imagery.

## Sample data (all fictional — never real client data)
Six design-build projects: **Cedar Grove Renovation**, **Harbor View Addition**, plus 4 more you invent (realistic names, e.g. tenant improvement / civic / commercial jobs). Each project: lifecycle phase, checklist completion %, overdue/blocked task counts, project manager, superintendent, next action, last activity date. Include realistic subcontractor trades (electrical, mechanical, framing, roofing, etc.), bid due dates, field-photo captions, and change-order examples. Zero IT/cybersecurity content anywhere.

Lifecycle stages — exact order, used everywhere:
`Lead Intake → Qualification → Estimating & Bid → Award & Turnover → Production → Billing & Change Orders → Closeout`

## Implementation steps

### 1. Shell + tabs
Header with CalAsia logo + product title; horizontal tab nav switching between the main views (Portfolio, Cedar Grove Command Center, Master Checklist, Project Records, Work Queues). Drawers overlay any view. Responsive at desktop and tablet widths.

### 2. View 1 — Portfolio dashboard
Grid/list of the 6 projects as cards or rows. Each shows: lifecycle phase (badge on the 7-stage spine), checklist completion % (progress bar), overdue + blocked task counts (attention styling), PM, superintendent, next action, last activity. Filters (working JS): by phase, by owner (PM/super), and an "attention needed" toggle (overdue or blocked > 0). Clicking Cedar Grove navigates to View 2.

### 3. View 2 — Cedar Grove project command center
Horizontal lifecycle spine across the top: all 7 stages, completed/current/upcoming states visually distinct. Per-stage controls: **Advance**, **Pause**, **Manual override** (for when a real project needs out-of-band handling) — each visibly changes stage state and shows a status note. Below the spine: Cedar Grove summary (phase, owner, next action, blockers) plus embedded/linked views of its checklist and records.

### 4. View 3 — Grouped master checklist
Tasks grouped by lifecycle stage. Every task row: owner, due date, completion checkbox (toggleable), source document/form name, and a one-click link chip to the "existing work area" (mock folder/Excel target — `#` link with folder-path label, e.g. `Projects/Cedar Grove/03 Estimating/Bid Form.xlsx`). Must include at minimum these 10 tasks: create project folder, validate lead record, publish standardized RFP, confirm subcontractor responses, complete job startup checklist, submit daily report, review two-week look-ahead, log change order, issue billing package, finish completion list. Add a few more per stage for realism.

### 5. View 4 — Existing Project Records panel
Panel/grid of the retained record categories, framed as "your current system, still the source record": **Plans, Scopes, Estimating Schedule, Subcontractor Bids, Production Schedule, Daily Reports, Site Photos, Budget, Billing, Change Orders, Closeout** (all 11). Each card: category, sample file/folder names, last-updated, link chip. Site Photos card uses real CalAsia photos with fictional captions.

### 6. View 5 — Drawer/modal prototypes (6)
Lightweight drawers (slide-over or modal), each with realistic form fields pre-filled with sample data, open/close working, no submission backend (a "Saved to project record" toast/confirmation is fine):
1. **New Lead Intake** — client, contact, project type, source, est. value.
2. **Standard Bid Package** — package scope summary (human scope review preserved), subcontractor list with per-sub invite/opened/downloaded/bid-response status tracking, bid due date.
3. **Daily Field Report** — date, crew counts by trade, work performed, weather, issues.
4. **Photo Log** — photo picker mock + captioned real photos.
5. **Two-Week Look-Ahead** — dated activity rows with responsible party.
6. **Change Order** — description, cost/schedule impact, status, approval chain.
Trigger drawers from contextual buttons (e.g. Daily Field Report from Cedar Grove view) and/or a drawer index.

### 7. View 6 — Role-aware work queues
Four queues: **Estimator, Project Manager, Superintendent, Accounting**. Each lists that role's incomplete tasks across all 6 projects (project, task, due date, overdue flag) so incomplete handoffs are obvious. Include at least one visibly stalled cross-role handoff (e.g. estimating done, award turnover awaiting PM).

### 8. Rollout mini-view
Small section (can live on the portfolio view or its own tab): 3-step rollout — (1) lifecycle mapping + SOPs, (2) lead/contact records + master checklist, (3) highest-friction workflows. No platform named.

## Validation requirements (do all before PR)
1. Open `index.html` via `file://` — renders, zero console errors, no broken images.
2. Every tab reachable; all 6 required views + rollout section present.
3. Portfolio filters actually filter; spine advance/pause/override changes visible state; checklist toggles work; all 6 drawers open and close.
4. Content audit: 7 stages exact order; all 10 mandated checklist tasks; all 11 record categories; 6 projects incl. Cedar Grove + Harbor View; 4 roles; no IT/cyber content; no real client data.
5. Brand audit: real CalAsia logo, orange/charcoal palette, real project photos.
6. Screenshot each view (and one open drawer) for the PR description.

## Handoff requirements
- Branch + PR against `clearworks-ai/calasia-construction-command-center` (NOT grandamenium upstream, NOT the Kadre repo). PR body: view screenshots + validation checklist results.
- **Do NOT merge. Do NOT enable/modify GitHub Pages.** Josh approves after larry reviews; publish happens only after that approval.
- Report PR URL back on completion.
