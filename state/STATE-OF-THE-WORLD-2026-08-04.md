# STATE OF THE WORLD — 2026-08-04 (grounded, evidence-only)

Compiled by Fable, 2026-08-04 ~13:45 PDT. Every claim below is grounded in a PR number, commit, file path, or a live command run this session. Where a claim could not be grounded it is marked **UNVERIFIED**. The 2026-08-04 handoff doc and transcripts were used as pointers only, then verified — two of the handoff's claims are contradicted by disk (flagged below).

---

## 0 · Headline numbers (all live-checked this session)

| Metric | Value | Evidence |
|---|---|---|
| Commits merged to origin/main since 2026-08-02 | **105** | `git log --oneline --since=2026-08-02 origin/main \| wc -l` |
| PRs merged since 2026-08-02 | **~100** (#207–#314, minus gaps) | `gh pr list --state merged --search "merged:>=2026-08-02"` |
| Fork vs upstream divergence | **667 ahead / 4 behind** (merge-base `a15baad4`, 2026-07-20) | `git rev-list --count upstream/main..origin/main` after `git fetch upstream` |
| Bus tasks closed TODAY | **580** (557 completed + 23 cancelled); 462 of them created today; **87 were pre-08-03 backlog** | python over `~/.cortextos/cortextos1/orgs/clearworksai/tasks/task_*.json` |
| Bus task store totals | 3,017 files: 1,976 completed · 767 cancelled · **197 pending · 44 blocked · 4 in_progress · 17 someday · 9 waiting** (≈271 open) | same |
| Multica bridge links | **124** — sync-state.json last written **2026-07-31 00:37** (4+ days frozen) | `stat` + json parse of `state/multica-bridge/sync-state.json` |
| Tunnel | **LIVE** — cloudflared authed, tunnel `27754b3f…` exists, launchd running | `node dist/cli.js tunnel status --instance cortextos1` (this session) |
| Webhook-bridge | **LIVE** — launchd `com.cortextos.webhook-bridge` pid 32331, healthz ok | `webhook-bridge status` + `launchctl list` |
| Fireflies webhook deliveries received, ever | **0** | `grep -ci fireflies ~/.cortextos/logs/webhook-bridge-run.log` → 0 |
| Live daemon | started **Aug 4 12:04 PDT**; `dist/*.js` rebuilt **13:21 PDT** → **running daemon predates the current build** (post-12:04 merges NOT live) | `ps -o lstart` on daemon pid + `stat dist/daemon.js` |

---

## 1 · Upstream vs our fork — what we actually shipped (last ~2 days)

Remotes: `origin`/`fork` = clearworks-ai/cortextos, `upstream` = grandamenium/cortextos (`git remote -v`). Upstream added only a claude-to-codex-migration skill in this window (`dfedf9bd`, `22c16f21`); **everything below is fork-side work**. The only converge-from-upstream motion was deletions/rebaselines toward upstream (RW-8 #206 −598 lines, M1 #214 inject.ts byte-identical reset, RW-1 #202 reclassifier removal). Net divergence after "convergence week": still **667 commits ahead**.

Merged PRs since 08-02, grouped (every number verified merged via `gh pr list`):

| Theme | PRs |
|---|---|
| **Wave-2 daemon convergence (RW/M lanes)** | #203 #204 #205 #206 #207 #208 #209 #210 #211 #212 #213 #214 #215 (all 13 from WAVE2 report merged) + #200 (disabled-agent resurrection), #202 (RW-1 rate-limit reclassifier revert) |
| **Task-bus mgmt automation** | #217 #218 #219 #220 #222 #223 #224 #225 (due-date caps, nudge/escalate, substance gate, silent-assignee sweep, phase-sequencing gate) |
| **Webhook/tunnel event spine (P4.1)** | #227 (tunnel zero-date), #232 (HMAC Fireflies ingest), #234 (/relay/* ingress), #239 (camelCase normalize), #245 still OPEN (Zoom receiver) |
| **P-phase receipts + re-signs (WAVE B)** | #246 (kill --mark-phase-complete), #249 #253–#260 (post-clobber re-signs), #259 (P2), #260 (P3.0), #263 #271–#273 #276 #280 #282–#284 #289–#293 #295 #296 #298 #299 (receipt chores) |
| **P3/P4 builds** | #261 (agent assignee_type + meeting provenance, P3.2/P4.3), #262 (3-signal detector + sweep CLI, P4.4) |
| **P1 outputs-router/KB fixes** | #248 #250 #251 #252 #254 #264 (router bugs+tests), #240 #288 #301 (kb-reconcile 504/quarantine/PDF-timeout), #265 (memory-mirror exit code) |
| **P5/P6** | #266 (larry upstream-sync checks fork PRs), #267 (cron hygiene), #274 (P6 weekly-review deterministic core), #275 (LOOP6 .cron-active restore) |
| **Daemon reliability** | #237 (TTL dedup), #238 (planned-handoff ≠ crash), #242/#268 (clean exit ≠ crash), #243 (retrieval-enforcer bypass), #244 (handoff→daily memory), #247 (LOOP7 telegram inbound persist), #269 (single-flight restart), #281 (wedge-watchdog — merged **against** a hold call, flagged for removal), #285 (LOOP1 stage1 back-ping triad delete), #294 (worker parent-agent flag), #302 (ctx-% vs real model window), #303 (crash stderr capture) |
| **Altari Phase-1** | #277 #279 #286 #287 #300 #304 #305 #306 (see §5) |
| **Multica** | #241 (noise filter), #308 (assignee_type 400 fix), #309 (real-time task→issue mirror), #311 (project grouping), #314 (mirror dedup race) |
| **Misc org** | #221 (ff-extractor→pa move), #228 #229 #230 #231 #233 (cron/skill fixes), #297 (cxportal path bugs) |

Open PRs on the fork right now: #315 #313 #312 #307 #245 #201 + old backlog #70 #24 #18 #17 #8 (`gh pr list --state open`).

---

## 2 · P1–P6 — what's REALLY done

Source of intent: `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md` (v9). Status verified against code/PRs/live, not the plan's own header.

### P1 · Store consolidation

| Item | Status | Evidence |
|---|---|---|
| 1.0 outputs-router | **DONE** | `orgs/clearworksai/skills/outputs-router/` exists (SKILL.md, file_output.py, tests); fixes #248 #250 #251 #254 #264; receipt #258 |
| 1.1 kb-reconcile nightly | **DONE** (+hardened) | receipt #249; fixes #240 #288 #301; proactive maintenance loop #279 |
| 1.2 deliverables fold-in (812 files) | **PARTIAL** | mirror ran — `outputs-router/manifests/p1-2-mirror-manifest.jsonl` = 820 rows — but the manifest is **UNCOMMITTED** (`git status` → `??`); plan requires a committed manifest + 7 green days before the write-path flip; flip not done |
| 1.3 org-Brain fold-in | **DONE** | `orgs/clearworksai/knowledge` is a live symlink → `knowledge-sync/raw/areas/clearworks/org-brain` (ls -la, created Jul 31) |
| 1.4 cxportal → index | **DONE (build)** | pull_cxportal.py + path fixes #297, receipts #293 #296 |
| 1.5 agent-memory → index | **DONE** | receipt #256; review evidence `state/verify-evidence/p1-5-agent-memory-index-review.md` (uncommitted) |
| 1.6 claude-mem exporter | **DONE + LIVE** | `knowledge-sync/raw/areas/clearworks/session-memory/{observations,summaries}/` contains 2026-08-04 files — the exporter is producing; receipt #253 |
| 1.7 Fireflies transcripts store | **NOT PRODUCING** | `ls orgs/clearworksai/knowledge/transcripts/ \| wc -l` → **0** files, live. Push path gated on P4.1⑤; poll-path persist not landing files either |
| 1.7a scripts → pa | **DONE** | PR #221 (ff-extractor moved, comms-check-worker dropped from frank2) |
| 1.8 email capture inbox | **UNVERIFIED** | pa owns comms-check (cron in pa config.json) but no check of capture-inbox rows was possible this session |
| 1.9 Clearpath drain/retire | **NOT STARTED / BLOCKED-ON-HUMAN** | D5a gates + Josh's org pick (Internal 156/Holdco 83/both) — no export manifest exists |

### P2 · Job rollout (spot-run scope)
**DONE** for the declared scope: contract-lint.sh 18/18 PASS (plan header, re-verified 08-03), receipt #259, Josh's 3-file feedback fixes merged (#219 + 26e2d5f). **NOT the 25-job Wave1-3 buildout** — that is explicitly later-bench, not started.

### P3 · Multica rail
**Code DONE, pilot NOT LIVE.**
- 3.0a reverse-import + 3.0b dup-recovery: built + test-proven (`poll.ts:426`, `push.ts:226-253`; 26/26 tests per plan log); receipt #260. #185 merged. #261 adds agent assignee_type.
- **Live state: no `multica-sync` cron in ANY agent config** (`grep -l multica-sync orgs/.../agents/*/config.json` → 0). `sync-state.json` frozen at 2026-07-31. Pilot round-trip + cron install = explicit **[HUMAN GATE]** (first run pushes ~131 creates into Josh's live workspace).
- Today's real-time mirror (#309/#311/#314) changes the picture — see §6.

### P4 · Event layer
| Item | Status | Evidence |
|---|---|---|
| 4.1① tunnel | **DONE, LIVE** | `tunnel status`: authed, tunnel exists, launchd running, URL set — v8's "does not exist" is now fixed |
| 4.1② HMAC Fireflies route | **DONE** | PR #232 (+#239 camelCase fix) |
| 4.1③ route→relay (target pa) | **DONE** | merged with #232; /relay/* ingress #234 |
| 4.1④ launchd service | **DONE, LIVE** | `launchctl list` → `com.cortextos.webhook-bridge` pid 32331; healthz ok |
| 4.1⑤ register URL in Fireflies | **BLOCKED-ON-HUMAN (Josh's Fireflies login)** | bridge log has **zero** fireflies hits ever — registration definitively not done |
| 4.2 activity shim | **DONE** | per plan header (unverified beyond doc — no counter-evidence) |
| 4.3 approval⇄Multica | **DONE (code) / degraded (live)** | Spec A #199 + Spec B #216 merged; but round-trip rides the Multica sync, which hasn't successfully run since Jul 31 (§6) |
| 4.4 3-signal detector | **DONE (build+wiring)** | PR #262; frank2 config.json has `signal-sweep` cron. Whether the daemon has loaded it: **UNVERIFIED** (daemon predates latest config reload — restart is Josh-gated) |

### P5 · Cron rewire
- 5-A kills: **DONE** (receipt #276, hygiene #267; live registry re-baselined to 80 crons per plan/receipts).
- 5-B (11 cron→event conversions): **NOT DONE, correctly blocked** — frank2 config still runs `transcript-scanner`, `meeting-commitments`, `pre-meeting-brief(-page)`, crm still runs `fireflies-ingest` (grep of config.json this session). The gate is **P4.1⑤** (one human action) — exactly as believed.
- 5-C: **DONE** — orchestrator-off-Telegram #233, sage parity #230 (+confirmed pre-existing), larry upstream-sync fork-check #266, briefing crons live on pa (`morning-brief`/`evening-wrap` in pa config.json), session-mining lane kept on frank2 (`session-archaeology`, `daily-trending-repos` present).

### P6 · Weekly review
**BUILD DONE, CADENCE UNPROVEN.** Deterministic core + live proof merged #274, receipt #280. Done-condition = 4 consecutive weekly reports — structurally impossible to have met yet (first fire this week). Treat as "shipped, not yet earned."

---

## 3 · The Waves

| Wave | What it was | Status | Evidence |
|---|---|---|---|
| **WAVE 0** | 5 "safe" convergence PRs: retrieval-enforcer removal, .cron-active restore, tool-result-router guard, system-pings gate, conversation-buffer inbound wire | **Mostly landed** — .cron-active #275 ✓, retrieval-enforcer became a *bypass* (#243) not a removal, conversation-buffer/telegram wire folded into #247. tool-result-router guard + system-pings gate PR#s **UNVERIFIED** | memory `project_causal_chain_convergence_dispatch_hold_2026-08-03.md`; PRs #243 #247 #275 merged |
| **WAVE 1** | Context-handoff convergence (adopt upstream #685/#699, delete b8a2901 machinery + ~21 compensators) = **LOOP1** | **PARTIAL, Josh-gated** — see LOOP1 in §4 | same memory + #285 #302 |
| **WAVE 2** | 17-item fan-out RW-2..RW-10 + M1..M8 vs the v9 fleet-incident causal model | **ALL 13 PRs MERGED** (#203–#215), 4 NO_OPs as designed. Non-PR operator action (M4 runbook: re-home bridge under launchd, kill orphan pid 15124) — **DONE** (bridge now launchd-managed, verified live) | `state/v9-fleet-incident/WAVE2-CONVERGENCE-REPORT.md` + `gh pr view` on all 13 |
| **WAVE A** | Pipeline-gate integrity: completion earned only by true-verify | **DONE** — #246 removes `--mark-phase-complete` | PR #246 |
| **WAVE B** | Re-earning P1–P6 true-verify receipts after the shared-checkout ledger clobber | **DONE** — re-signs #249 #253–#258, then P2 #259, P3 #260, P4.4 #262/#263, P5 #276, P6 #280 | merged list |

---

## 4 · The Loops (Track 2, 7 loops — reconciled against merged PRs)

Handoff claim: "LOOP1 back-ping cut #285, LOOP2/6/7 done, LOOP3/4 keep-as-upstream." Verified:

| Loop | What | Real status | Evidence |
|---|---|---|---|
| **LOOP1** | Context-handoff convergence (biggest: upstream #685/#699, delete ~21 compensators). Sole irreversible gate: staging smoke → Josh live-promote | **PARTIAL + Josh-gated.** Stage 1 (back-ping triad delete) merged #285 — `src/daemon/handoff-backping.ts` confirmed deleted. #302 (ctx-% vs real model window) MERGED but **NOT deployed** — daemon started 12:04 PDT, current dist built 13:21 PDT; #310 restored larry threshold 70 contingent on #302 being live, which it isn't yet | ls, ps, stat this session |
| **LOOP2** | retrieval-enforcer REMOVE | **CONTRADICTED — not a removal.** `src/hooks/hook-retrieval-enforcer.ts` still exists on main (16KB, mtime Aug 3). What merged is #243, a SESSION-CONTINUATION *bypass*. Either the scope was quietly renegotiated to keep-with-bypass, or LOOP2 is unfinished. **Handoff's "done" is not grounded** | ls this session; PR #243 |
| **LOOP3** | Continuity consolidation (mission-anchor/handoff-doc machinery) | **KEEP-AS-UPSTREAM (no cut)** — consistent: `src/daemon/restart-context.ts` still present, unchanged since Jul 31 | ls |
| **LOOP4** | pty-host SPIKE (repro ptmx leak vs upstream destroy before cutting) | **KEEP (no cut)** — src/pty/ intact (13 files); its wounds were instead fixed in-place by WAVE 2 (#203 #204 #207 #211) | ls + WAVE2 report |
| **LOOP5** | Codex runtimes KEEP-freeze | **DONE (no build required by definition)** | observation log 08-04 |
| **LOOP6** | Restore `.cron-active` marker write | **DONE** — #275 merged; ledger row `loop6-cron-active-restore` in pipeline-ledger.jsonl:297 | PR #275 |
| **LOOP7** | Telegram cleanup (inbound persist slice) | **DONE** — #247 merged (inbound survives failed inject + restart) | PR #247 |

---

## 5 · Altari Phase-1

All 8 handoff-claimed PRs **verified MERGED** via `gh pr list` (mergedAt on 08-04): dashboard **#287** · KB-maintenance **#279** · meeting-decisions **#277** · scoping-gate **#286** · reliability/production-stack **#300** · EA-cluster **#304** · CRM-enrichment **#305** · delivery-status **#306**. The "8/8 merged" claim is TRUE.

**But "merged" ≠ "event-wired." Actual wiring state:**

| Skill/lane | Trigger today | Truly event-driven? |
|---|---|---|
| CRM enrichment + records-admin (#305) | Scripts in `orgs/.../agents/crm/crm/` emit events (`emit_stage_changed_event` sync-board.py:186, `emit_deal_created_event` reconcile-intake.py:81, `emit_contact_created_event` upsert-contact.py:234) via `cortextos bus send-message crm …` — i.e. **self-inbox messages, carried by the existing crm crons** (`deal-enrichment`, `records-admin-sweep` in crm config.json). Note: no function named `emit_crm_event` exists — that's the family above | Event-*shaped*, poll-carried. No external webhook |
| EA cluster (#304) | pa crons (`comms-check`, `morning-brief`, `evening-wrap`) + zcal booking link; **zcal webhook needs Pro tier + API key — open Josh decision** (frank2 msg 17:18Z); `gmail_push_listener.py` exists at `orgs/.../pa/scripts/` but is **written, not deployed** | Partially; inbox lane still cron |
| Meeting decisions (#277) | Rides the meeting chain: today that is the **2h poll** (P4.1⑤ unregistered ⇒ webhook path has never fired) | No — poll |
| Delivery-status (#306) | Weekly cron → approval queue, by design | By design cron |
| KB maintenance (#279) | Nightly/weekly on kb-reconcile (but #288 fixed it "crashing on every fire" — fixed 08-04) | By design cron |
| Dashboard (#287), scoping-gate (#286), production-stack (#300) | On-demand / gate / daily sre cron | n/a |
| Fireflies webhook receiver | `src/cli/webhook-bridge.ts` HMAC route CODED + bridge LIVE + tunnel LIVE — **0 deliveries ever** (log grep) | **Dormant until P4.1⑤** |

Known open defect from review: **EA booking slot-times use UTC not PT** (~8h skew; non-blocking, drafts-only) — handoff claim, **UNVERIFIED in code this session**.

---

## 6 · The tracking failure (why Josh is confused)

**Quantified, live:**
- **580 bus tasks closed today** (557 completed, 23 cancelled). 462 were created *today* — mostly `Cron: <name>` wrapper tasks (sage 273, larry 141, frank2 107 by assignee). **87 closed today were pre-08-03 backlog** — this is the "stale-no-close-on-ship" sweep (the handoff's "~73" is in the same ballpark; exact definition differs). Of those 87, 14 carry explicit shipped/stale/superseded language in `result` (e.g. "Shipped: phase-sequencing gate PR#220 merged 2026-08-02", "Pattern already built: src/bus/reliable-job.ts").
- **Multica ↔ bus disagreement:** the bridge ledger (`~/.cortextos/cortextos1/orgs/clearworksai/state/multica-bridge/sync-state.json`) holds **124 links** and was last written **2026-07-31 00:37** — no successful sync in 4+ days. The handoff reported 145 outbound pushes failing HTTP 400; #308 (merged today) fixed the diagnosed cause (id-less `agent` assignee_type), #309/#311/#314 added a real-time mirror-on-mutation + project grouping + dedup — **but there is still zero on-disk evidence of a successful push since Jul 31** (state file untouched), no sync cron exists, and the live daemon predates today's dist build. **"Multica is live again" is UNVERIFIED — do not claim it.** By the strict definition "issue open but bus task gone": 0 of the 124 links point at deleted task files — the orphaning is *staleness*, not dangling links. A dry-run this session (`bus multica-sync --dry-run --direction out`) returned `0 creates / 0 updates / 157 skipped / 0 errors` — the noise filter (#241) now excludes most of what previously 400'd.

**The concrete mechanism by which epics get lost (one paragraph):** Work ships through the *pipeline* (branch → PR → review + true-verify receipt in `state/pipeline-ledger.jsonl`), but the *bus task* that represents the epic is a separate object nobody's ship-path touches — there is no close-on-ship hook, so the task sits open (or worse, a cron re-notices it and escalates it as overdue) long after the PR merged; meanwhile Multica only ever reflected the bus via a sync that (a) was never wired to a cron, (b) 400'd when it was run by hand, and (c) has a ledger frozen since Jul 31, so the dashboard renders a 4-day-old snapshot; and the *plan* lives in untracked `.agent/one-big-feature/` dirs and `state/` handoff docs that shared-checkout `git clean`/branch-hops have deleted at least four times this week (memory: ledger-wipe incidents), so after a context reset the only surviving record of "what was this epic and is it done" is scattered across merged PRs (accurate), bus tasks (stale), Multica (frozen), and handoff docs (partly wrong — see LOOP2, Multica claims). Today's fixes attack real pieces of this (#309 mirror-on-mutation, #223 substance gate, #225 silent-assignee sweep, #246 no-skip gate), but the close-on-ship link between "PR merged" and "bus task/epic closed" still does not exist — the 87-task backlog sweep today was manual.

---

## 7 · What's actually left

### Blocked on Josh (human gates — each is minutes of his time, most unblock hours of built work)

| # | Gate | Unblocks | Smallest next step |
|---|---|---|---|
| H1 | **Register the tunnel URL in the Fireflies dashboard** (P4.1⑤) — the only step of the 5-step chain not done; ①–④ verified live | The entire push event layer: P5-B (4+ cron→event conversions), P1.7 transcripts, real-time meeting chain | Log into Fireflies → Settings → webhook URL (tunnel URL + /relay path) → one test meeting |
| H2 | **Daemon live-promote** (restart onto current dist) — running daemon predates today's build; frank2 has been pinging for the go-ahead since ~13:42Z | #294 (comms-check misroute), #302 (real-window ctx-% — the restart-churn root fix), #308–#314 daemon-side Multica bits, LOOP1 threshold restore #310 | Say "restart the daemon"; optionally staging smoke first per LOOP1 protocol |
| H3 | **Multica pilot go**: manual dry-run→out→in round-trip + install the ~10-min sync cron (first live run writes creates into Josh's workspace) | P3 actually live; dashboard status unfreezes; D1 "Multica = record" becomes real | One supervised `bus multica-sync` round-trip, then add the cron |
| H4 | **Rebuild-from-upstream decision** — nuke fork vs keep converging (fork still 667 ahead; the guide's §2–3 = preserve manifest) | Ends the compensator treadmill either way | Read `altari-skilltree/SYSTEM-GUIDE-AND-NEW-FEATURES.md` §4 and call it |
| H5 | **larry's 4 pending decisions** (frank2 msg 17:18Z): zcal API key/Pro-tier webhook, zoom-webhook, lifecycle-killer 403, +1 | EA booking event path (#304 lane-a, PR #315 open) | Answer the 4-item Telegram |
| H6 | **Clearpath drain org pick** (D5a: Internal 156 / Holdco 83 / both 239) | P1.9 | One-word pick |

### Buildable now (no human gate)

| # | Work | Why not done | Smallest next step |
|---|---|---|---|
| B1 | **Prove Multica sync actually works post-#308** — zero successful pushes evidenced since Jul 31 | Fix merged today but never exercised live; no cron | One real (non-dry) bounded `multica-sync --direction out` run; assert sync-state.json mtime advances + 0 HTTP 400s; then wire the cron (pending H3 for first creates) |
| B2 | **Close-on-ship**: link PR-merge → bus-task close | Never built; today's 87-task sweep was manual | Small hook in the pipeline gate (or a daily sweep) that closes the task named in the OBF slug when its PR merges |
| B3 | **Commit the stranded evidence**: p1-2 mirror manifest (820 rows), verify-evidence files, WAVE2 report, upstream-review synthesis — all `??` in git status of the shared checkout | Left untracked; this exact class has been wiped by git-clean 4× this week | `git add` + PR the state/ and manifests paths |
| B4 | **LOOP2 finish or formally re-scope** — enforcer source still on main + registered on 15 agents | Only the bypass (#243) merged | Either delete `src/hooks/hook-retrieval-enforcer.ts` + deregister, or write the keep decision down |
| B5 | **wedge-watchdog #281 removal** — merged against the hold call, flagged | Symptom-patch on main | Revert PR |
| B6 | **EA booking UTC→PT slot fix** | Reviewer-caught, queued | 1-file fix in the pa booking lane |
| B7 | **P1.7 transcript persist via poll path** — store is 0 files despite ff-extractor running | Persist wire not landing files (plan said extend ff-extractor to persist regardless of trigger) | Trace one poll cycle; assert a file lands in `knowledge/transcripts/` |
| B8 | **P5-B conversions** (transcript-scanner, meeting-commitments, ff-extractor/fireflies-ingest, comms-check → events) | Correctly gated on H1 | Pre-stage the event-mode configs so H1 flips them same-day |
| B9 | **Open-PR backlog triage** — #313/#312 (bypass-audit dedup), #307 (dead monitoring crons), #315 (EA lane-a), #245 (Zoom receiver), #201, + stale #70/#24/#18/#17/#8 | In flight / stale | Merge-or-close pass |
| B10 | **P6 first weekly report** fires this week | Cadence needs 4 weeks of receipts | Watch for report #1; done-condition tracks itself |

---

## Contradictions found (handoff vs disk — carry these)

1. **"LOOP2 done"** — enforcer source still exists on main; only a bypass merged (#243).
2. **"Multica sync is BROKEN (145× 400)"** was true at handoff time, then #308–#314 merged the same afternoon — but **no evidence any successful sync has run since Jul 31**; both "broken" and "fixed" are currently unproven live. Status: fix-merged, unverified.
3. **"P1–P6 all done"** — true for the *receipted scope*, but P1.2 flip, P1.7, P1.8, P1.9, P5-B, and P6's cadence are open; the plan's own live-status header (08-03) is more honest than the 08-04 handoff.
4. **#302 "REOPENED, pending go"** (handoff) vs merged 19:02Z — it merged *after* the handoff was written; deployment (not merge) is now the gate.
