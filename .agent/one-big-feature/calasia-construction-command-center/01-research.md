# Research — Calasia Project Delivery Command Center

## Target repo verification
```
gh repo list clearworks-ai --limit 100 | grep calasia
clearworks-ai/calasia-construction-command-center  "CalAsia Construction visual coordination command center (Kadre-pattern prototype)"  public  2026-08-06T00:06:43Z
```
Empty, public, created by frank2 2026-08-05 specifically for this build. Confirmed NOT the same repo as `clearworks-ai/kadre-os-room-74328219` (that one returned a live Kadre Architects proposal page on inspection — wrong target, avoided).

## Kadre reference pattern (what "copy this format" means)
```
gh api repos/clearworks-ai/kadre-os-room-74328219/pages
{"status":"built","build_type":"legacy","source":{"branch":"main","path":"/"},"html_url":"https://clearworks-ai.github.io/kadre-os-room-74328219/"}

gh api repos/clearworks-ai/kadre-os-room-74328219/contents
index.html, assets/ (only 2 root entries)
```
`index.html` fetched raw: single file, inline `<style>` block (CSS variables, custom fonts via Google Fonts import), tab-based view switching via `.view` / `.view.on` classes toggled by inline JS, no `package.json`/build step visible at root. This is a hand-authored static single-page site, not a compiled React/Vite output.

**Implication for CalAsia:** build the same shape — one `index.html` (vanilla HTML/CSS/JS, no framework, no bundler) + `assets/` folder for the CalAsia logo and real project photos. GitHub Pages "legacy" mode just serves `main` branch root directly — no CI/build step needed, so none should be added.

## Brand asset verification
- Logo URL confirmed reachable pattern: `https://calasiaconstruction.com/wp-content/uploads/2023/10/logo-new.png` (per solutions-engineer brief doc, not independently re-fetched this pass — codexer should verify it loads before embedding, and pull real project photos from `calasiaconstruction.com/projects/` rather than using stock imagery).

## Brief doc (source of truth for feature scope)
`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/auditmaster-codex/outputs/solutions-engineer/2026-08-05-1619-callasia.md` — full build prompt, all 6 required views, sample data list, evidence boundary (Google Doc `1yoJAya_xsYYGA-1Ldlbkk1n8jWG-osfhvlOmmqZhkzI`, IT/cybersecurity excluded per Josh).

## Prior dispatch attempt (context, not a blocker)
An earlier session fork attempted this same dispatch and died mid-run when the CLI process restarted (known recurring issue tonight, unrelated to this build). It left only an empty `.agent/one-big-feature/calasia-construction-command-center/03-specs/` directory — no ledger entry, no codexer message, no real artifact. Confirmed via `grep -i calasia state/pipeline-ledger.jsonl` (no hits) and `bus list-tasks --assignee codexer` (no hits) before restarting this OBF run from scratch.
