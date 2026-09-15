"""GUARD_REGISTRY: one row per `# G-<ID>` / `// G-<ID>` marker on an OPERATIVE
line, rebuilt the FINAL time (2026-09-14, wave-2 fix wave) against every
writer's landed part, materialised via
`python3 scratchpad/g0-compile.py scratchpad/plan-assembled.md <dest>` and
swept with the SAME regex test_no_unregistered_guard below uses (a G-ID
token anywhere after a '#' on its line -- docstring/prose mentions of a
G-ID, which several modules still carry alongside their real marker, do NOT
count). 78 rows: LEDGER x8, RECEIPT x2, LOCK x9, LOCKREF x1, SWEEP x10, RES x2,
EXT x4, INV x2, BASE x2, SUPER x1, DIG x4, BUS x4 (TS), IDEMP x2, MERGE x3,
SIM x1, ESC x3, QUERY x1, FAIL x1, BUDGET x2, CRM x2, HIST x2, PARITY x2,
WRITER x2, OWNER x1, TASK x2, DEDUP x1, EFFECT x3, REV x1.

The G2a review-fix wave (2026-09-14) added G-DIG-3, G-EFFECT-2, G-BUS-3 and G-SWEEP-10; the G2 round-2 wave (2026-09-15) added G-ESC-3, G-LOCK-9, G-BUS-4, G-DIG-4, G-LEDGER-8 and G-EFFECT-3.

The last 8 rows (G-MERGE-2/3, G-EFFECT-1, G-BUDGET-2, G-REV-1, G-PARITY-2,
G-LOCK-7/8) were added by the post-cap adjudication wave (2026-09-15) that
landed rulings A/B/C/F/K; G-MERGE-3 and G-PARITY-2 also gained an OPERATIVE
marker in that wave so this sweep sees them.

Every row is (guard_id, module_path, mutation_description, test_node_id,
sed_expr). module_path is either a scripts/brain/*.py file (sed_expr is a
BSD `sed -E` expression) or src/bus/task.ts (the four G-BUS-* rows). A marker
appearing at MULTIPLE operative sites (G-ESC-1 x2, G-ESC-2 x3, G-ESC-3 x2, G-EXT-2 x2,
G-LEDGER-6 x4, G-LEDGER-7 x2, G-LOCK-6 x2, G-LOCKREF-1 x2, G-OWNER-1 x2,
G-PARITY-1 x2, G-SUPER-1 x2, G-SWEEP-6 x4, G-SWEEP-7 x2, G-SWEEP-10 x2, G-EFFECT-3 x3, G-WRITER-1 x3,
G-WRITER-2 x3) gets ONE row whose
sed_expr mutates the FIRST site (file/definition order); the description
names every other site so a reviewer can find them without re-deriving this
sweep.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
BRAIN_DIR = REPO_ROOT / "scripts" / "brain"

GUARD_REGISTRY: list[tuple[str, str, str, str, str]] = [
    ("G-LEDGER-1", "scripts/brain/observation_ledger.py",
     "Ledger.append reads-whole then rewrites-whole through atomic_write - never a bare open('a')",
     "scripts/brain/tests/test_observation_ledger.py::test_append_and_latest_round_trip",
     r's/atomic_write\(self\.path, data\)  # G-LEDGER-1: read-whole \+ rewrite-whole, never a bare open\("a"\)/pass  # G-LEDGER-1 (mutated)/'),
    ("G-LEDGER-2", "scripts/brain/observation_ledger.py",
     "is_terminal is true only when the LATEST row's digest matches AND every resolution outcome is 'filed'",
     "scripts/brain/tests/test_observation_ledger.py::test_is_terminal_true_only_when_latest_row_same_digest_all_filed",
     r's/return all\(r\.outcome == "filed" for r in row\.resolutions\)  # G-LEDGER-2/return False  # G-LEDGER-2 (mutated)/'),
    ("G-LEDGER-3", "scripts/brain/observation_ledger.py",
     "distinct_refs returns DISTINCT source_ref values, not one per row",
     "scripts/brain/tests/test_observation_ledger.py::test_distinct_refs_counts_refs_not_rows",
     r's/return \{r\.source_ref for r in self\._read_rows\(\)\}  # G-LEDGER-3: DISTINCT refs, not row count/return set()  # G-LEDGER-3 (mutated)/'),
    ("G-LEDGER-4", "scripts/brain/observation_ledger.py",
     "open_email_tasks parses only 'task:<id>|<title>' writes entries, ignoring everything else",
     "scripts/brain/tests/test_observation_ledger.py::test_open_email_tasks_parses_task_writes_entries",
     r's/if not entry\.startswith\("task:"\) or "\|" not in entry:/if True:/'),
    ("G-LEDGER-5", "scripts/brain/observation_ledger.py",
     "escalated_for is true when ANY real row for the exact (source_ref, digest) pair carries an escalated outcome - "
     "monotonic, so a later ignored/filed row cannot forget a delivered alert and send a second one (G2B-5)",
     "scripts/brain/tests/test_observation_ledger.py::test_escalated_for_is_monotonic_across_every_row_for_the_pair",
     r's/if any\(r\.outcome == "escalated" for r in row\.resolutions\):  # G-LEDGER-5/if False:  # G-LEDGER-5 (mutated)/'),
    ("G-RECEIPT-1", "scripts/brain/observation_ledger.py",
     "record_failure starts from the PREVIOUS receipt so last_success_at survives unless partial explicitly overrides it",
     "scripts/brain/tests/test_observation_ledger.py::test_record_failure_preserves_previous_last_success_at",
     r's/out = dict\(prev\)  # G-RECEIPT-1: start from the previous receipt so last_success_at survives unless partial explicitly overrides it/out = {}  # G-RECEIPT-1 (mutated)/'),
    ("G-RECEIPT-2", "scripts/brain/observation_ledger.py",
     "gap_line names the exact `--days N` repair, N = ceil(days since last_success_at)",
     "scripts/brain/tests/test_observation_ledger.py::test_gap_line_names_days_n_repair_when_stale",
     r's/n = math\.ceil\(delta_days\)  # G-RECEIPT-2: N = ceil\(days since last_success_at\)/n = 0  # G-RECEIPT-2 (mutated)/'),
    ("G-LOCK-1", "scripts/brain/single_flight.py",
     "lock_path reproduces meeting-brief.ts claimLockPath exactly: sha256(name) hex, first 32 chars, '<hash>.lock'",
     "scripts/brain/tests/test_single_flight.py::test_lock_path_reproduces_claimLockPath_filename",
     r'/# G-LOCK-1: must reproduce/,+2 s/\[:32\]/[:16]/'),
    ("G-LOCK-2", "scripts/brain/single_flight.py",
     "Lease.touch bumps the lock file's mtime (the TS side's claimAgeMs staleness check reads it)",
     "scripts/brain/tests/test_single_flight.py::test_lease_touch_advances_lock_mtime",
     r's/os\.utime\(path, None\)  # G-LOCK-2: heartbeat -- mtime bump, claimAgeMs treats mtime as authoritative/pass  # G-LOCK-2 (mutated)/'),
    ("G-LOCK-3", "scripts/brain/single_flight.py",
     "a PLAIN refusal (no 'stale-cleared' in stderr) returns None and never retries - acquire() must not pretend a real double-claim won",
     "scripts/brain/tests/test_single_flight.py::test_acquire_returns_none_on_nonzero_rc",
     r's/return None  # G-LOCK-3: plain refusal \(already-claimed, still live\) -- no retry/return Lease(claims_dir=Path(claims_dir), name=name, runner=runner)  # G-LOCK-3 (mutated)/'),
    ("G-LOCK-4", "scripts/brain/single_flight.py",
     "a 'stale-cleared' refusal retries acquire ONCE in-process and wins the now-empty slot (G4 item 5: stale => next acquire wins)",
     "scripts/brain/tests/test_single_flight.py::test_acquire_retries_once_on_stale_cleared_stderr_and_wins",
     r's/return Lease\(claims_dir=Path\(claims_dir\), name=name, runner=runner\)  # G-LOCK-4: retry-once wins/return None  # G-LOCK-4 (mutated)/'),
    ("G-LOCK-9", "scripts/brain/single_flight.py",
     "a non-zero meeting-brief-claim whose stderr names NEITHER claim verdict is an OPERATIONAL failure "
     "(LeaseAcquireError -> record_failure + exit 3), never the lock-held exit 2 that leaves the success receipt "
     "byte-identical (G2A-3); second site: _claim_once wrapping an OSError/timeout from the claim call itself",
     "scripts/brain/tests/test_single_flight.py::test_acquire_raises_on_an_operational_claim_failure",
     r's/if verdict is None:  # G-LOCK-9: no claim verdict named -> operational, never contention/if False:  # G-LOCK-9 (mutated)/'),
    ("G-LOCK-5", "scripts/brain/single_flight.py",
     "Lease.touch records `lost` when our own lock file has vanished (a concurrent stale-sweep) instead of silently "
     "pretending we still hold the lease - the caller stops before further effects (G0B2-13)",
     "scripts/brain/tests/test_single_flight.py::test_lease_touch_missing_lock_file_marks_the_lease_lost",
     r's/self\.lost = True  # G-LOCK-5/pass  # G-LOCK-5 (mutated)/'),
    ("G-SWEEP-1", "scripts/brain/gmail_source.py",
     "window_queries covers EVERY day in the window exactly once, no gaps no overlaps",
     "scripts/brain/tests/test_gmail_source.py::test_window_queries_covers_every_day_no_gaps_no_overlaps_3_days",
     r's/for offset in range\(days - 1, -1, -1\):  # G-SWEEP-1/for offset in range(days, -1, -1):  # G-SWEEP-1/'),
    ("G-SWEEP-2", "scripts/brain/gmail_source.py",
     "sweep() day-sweeps the FULL window only when the full query hits exactly the 50 cap",
     "scripts/brain/tests/test_gmail_source.py::test_sweep_at_cap_day_sweeps_every_day_unions_by_id_and_reports_full_days",
     r's/for offset in range\(days - 1, -1, -1\):  # G-SWEEP-2/for offset in range(days, -1, -1):  # G-SWEEP-2/'),
    ("G-SWEEP-3", "scripts/brain/gmail_source.py",
     "a day that ITSELF returns 50 is still reported AND its 50 rows are still included, never dropped",
     "scripts/brain/tests/test_gmail_source.py::test_sweep_at_cap_day_sweeps_every_day_unions_by_id_and_reports_full_days",
     r's/truncation\.append\(\{"day": label, "count": 50\}\)  # G-SWEEP-3/pass  # G-SWEEP-3 (mutated)/'),
    ("G-SWEEP-4", "scripts/brain/gmail_source.py",
     "counterparties() excludes OURS_DOMAINS addresses, dedupes, and lowercases",
     "scripts/brain/tests/test_gmail_source.py::test_counterparties_excludes_ours_domain_dedupes_and_lowercases",
     r's/continue  # G-SWEEP-4/pass  # G-SWEEP-4 (mutated)/'),
    ("G-SWEEP-5", "scripts/brain/gmail_source.py",
     "the quoted-reply tail is stripped once the 'On ... wrote:' marker line is found",
     "scripts/brain/tests/test_gmail_source.py::test_parse_message_flat_shape_strips_quoted_tail_and_lowercases_addresses",
     r's/break  # G-SWEEP-5/pass  # G-SWEEP-5 (mutated)/'),
    ("G-SWEEP-6", "scripts/brain/gmail_source.py",
     "list_messages/read_message raise GmailSourceError on a nonzero gws rc (never silently swallow it) - "
     "4 sites: list_messages' two raises (+triage failed / invalid JSON) and read_message's two (+read failed / invalid JSON)",
     "scripts/brain/tests/test_gmail_source.py::test_list_messages_nonzero_rc_raises_gmail_source_error",
     r's/proc\.returncode != 0/proc.returncode == -999/g'),
    ("G-SWEEP-7", "scripts/brain/gmail_source.py",
     "EXCLUSION_QUERY is the comms-check-worker clause VERBATIM (SKILL.md:26) - marked at its docstring AND its assignment",
     "scripts/brain/tests/test_gmail_source.py::test_exclusion_query_matches_comms_check_worker_verbatim",
     r's/-subject:"auto-reply"/-subject:"MUTATED-auto-reply"/'),
    ("G-SWEEP-8", "scripts/brain/gmail_source.py",
     'list_messages parses BOTH the {"messages":[...]} shape and the live gws-dwd {"emails":[...]} shape',
     "scripts/brain/tests/test_gmail_source.py::test_list_messages_parses_dict_with_emails_key",
     r's/obj\.get\("messages"\) or obj\.get\("emails"\) or \[\]/obj.get("messages") or []/'),
    ("G-SWEEP-9", "scripts/brain/gmail_source.py",
     "C5: sweep's --query path composes <extra_query> <date ops> <EXCLUSION_QUERY> - the manual backfill query "
     "never bypasses the exclusion filter or date bounds",
     "scripts/brain/tests/test_gmail_source.py::test_sweep_extra_query_present_in_full_and_every_day_query",
     r's/parts = \[p for p in \(extra_query, date_ops, EXCLUSION_QUERY\) if p\]/parts = [p for p in (extra_query, date_ops) if p]/'),
    ("G-RES-1", "scripts/brain/resolve_email.py",
     "domain resolution keys on the FULL domain only - never a bare/registrable_label collapse",
     "scripts/brain/tests/test_resolve_email.py::test_full_domain_never_bare_label_collision",
     r's/self\.closed\.get\("domain_to_slug", \{\}\)\.get\(dom\)  # G-RES-1/self.closed.get("domain_to_slug", {}).get(dom.split(".")[0])  # G-RES-1/'),
    ("G-RES-2", "scripts/brain/resolve_email.py",
     "a falsy/duplicate-suppressed CRM company name never reaches _norm_title or binds to a '' key",
     "scripts/brain/tests/test_resolve_email.py::test_norm_title_never_called_on_none_or_blank_company",
     r's/if company:  # G-RES-2/if True:  # G-RES-2 (mutated)/'),
    ("G-EXT-1", "scripts/brain/extract_email.py",
     "commitments[].matches_open_item is range-checked against 1..n_context, out-of-range raises",
     "scripts/brain/tests/test_extract_email.py::test_validate_email_extraction_rejects_out_of_range_matches_open_item",
     r's/if moi is not None and not \(1 <= moi <= n_context\):  # G-EXT-1/if False:  # G-EXT-1 (mutated)/'),
    ("G-EXT-2", "scripts/brain/extract_email.py",
     "CLAUDE_ARGV is the exact extract_meeting.py:358-371 shape - --max-turns 1, marked at its declaration AND its call site",
     "scripts/brain/tests/test_extract_email.py::test_extract_argv_pinned",
     r'/CLAUDE_ARGV: list\[str\] = \[/,+12 s/"1",/"2",/'),
    ("G-EXT-3", "scripts/brain/extract_email.py",
     "cached_or_extract reuses the cached extraction on an identity match - no new LLM call",
     "scripts/brain/tests/test_extract_email.py::test_cached_or_extract_same_identity_no_call",
     r's/if cached is not None:  # G-EXT-3/if False:  # G-EXT-3 (mutated)/'),
    ("G-INV-1", "scripts/brain/client_state_digest.py",
     "compute_invariants keys domain_multi on the FULL domain - never a registrable_label collapse (example.com/example.org must not collide)",
     "scripts/brain/tests/test_client_state_digest.py::test_compute_invariants_does_not_confuse_different_tlds",
     r'/# G-INV-1: FULL domain only, never registrable_label/,+3 s/domain_pages\.setdefault\(dom, \[\]\)/domain_pages.setdefault(dom.split(".")[0], [])/'),
    ("G-INV-2", "scripts/brain/client_state_digest.py",
     "only post-epoch 'gmail:' History refs are checked against the ledger for the missing_gmail_refs invariant",
     "scripts/brain/tests/test_client_state_digest.py::test_compute_invariants_missing_gmail_ref_post_epoch_only",
     r's/if ref not in known_refs:/if False:/'),
    ("G-BASE-1", "scripts/brain/client_state_digest.py",
     "C10: NO auto-baseline - a missing baseline is an ERROR line the digest reports, never silently written here",
     "scripts/brain/tests/test_client_state_digest.py::test_gmail_section_reports_missing_baseline_and_never_writes_one",
     r'/# G-BASE-1 \(G0B-14\)/,+4 s/if baseline is None:/if False:/'),
    ("G-SUPER-1", "scripts/brain/client_state_digest.py",
     "the superseded-task lookup reads FULL ledger history (since-epoch), never just the last 24h, since the row a revision "
     "supersedes can be arbitrarily older than the digest window - marked at _superseded_task_ids AND at its call site",
     "scripts/brain/tests/test_client_state_digest.py::test_gmail_section_renders_each_change_line_type",
     r'/# G-SUPER-1 \(G0B-15\)/,+5 s/ledger\.rows_since\(_EPOCH_SENTINEL\)/ledger.rows_since(row.observed_at)/'),
    ("G-DIG-1", "scripts/brain/client_state_digest.py",
     "gmail_section only collapses to the single-line OK sentence when there is truly nothing to report (a missing baseline never collapses)",
     "scripts/brain/tests/test_client_state_digest.py::test_gmail_section_renders_each_change_line_type",
     r'/# G-DIG-1: a silent watcher/,+6 s/if not change_lines and gap is None and invariant_lines == \["- invariants: OK"\]:/if True:/'),
    ("G-DIG-2", "scripts/brain/meeting_loop_watch.py",
     "gmail_section_lines() catches every Exception so a Gmail-side failure never silences the Fireflies section (FR-009 independence)",
     "scripts/brain/tests/test_meeting_loop_watch_sections.py::test_main_dry_run_gmail_error_does_not_block_fireflies",
     r's/except Exception as exc:  # noqa: BLE001 — G-DIG-2 sections fail independently/raise/'),
    ("G-DIG-3", "scripts/brain/client_state_digest.py",
     "the one-line 'poller last success X' OK sentence is unreachable unless the receipt PROVES a success no later "
     "failure invalidated - a missing/corrupt/never-stamped receipt or an error newer than last_success_at emits an "
     "explicit '- poller: ...' warning line instead (G2a finding 1, FR-009)",
     "scripts/brain/tests/test_client_state_digest.py::test_gmail_section_warns_when_receipt_missing",
     r's/change_lines\.extend\(_poller_health_lines\(receipt\)\)  # G-DIG-3/pass  # G-DIG-3 (mutated)/'),
    ("G-DIG-4", "scripts/brain/meeting_loop_watch.py",
     "the Fireflies secrets file is read INSIDE fireflies_section's own guard, so a missing/unreadable "
     "orgs/clearworksai/secrets.env fails only that section and the Gmail digest still renders (G2A-6)",
     "scripts/brain/tests/test_meeting_loop_watch_sections.py::test_main_dry_run_unreadable_secrets_file_still_renders_the_gmail_section",
     r's/secrets = envparse\.parse_env_file\(brain_paths\.secrets_path\(REPO\)\)/secrets = __import__("meeting_loop_watch_missing_module").x/'),
    ("G-IDEMP-1", "scripts/brain/client_state_gmail.py",
     "run() skips re-processing (no new extraction/claude call) when ledger.is_terminal(source_ref, digest)",
     "scripts/brain/tests/test_client_state_gmail.py::test_second_identical_live_run_skips_the_terminal_message",
     r's/if ledger\.is_terminal\(source_ref, digest\):  # G-IDEMP-1/if False:  # G-IDEMP-1 (mutated)/'),
    ("G-IDEMP-2", "scripts/brain/client_state_gmail.py",
     "a same-digest re-check whose resolution SIGNATURE is unchanged from the prior row appends NOTHING "
     "(the pinning test asserts the ledger row COUNT and bytes, not just the absence of a claude call - G0B-3)",
     "scripts/brain/tests/test_client_state_gmail.py::test_second_identical_dry_run_zero_new_claude_calls",
     r's/if _resolution_signature\(resolutions\) == _resolution_signature\(merge_prior\.resolutions\):  # G-IDEMP-2/if False:  # G-IDEMP-2 (mutated)/'),
    ("G-MERGE-1", "scripts/brain/client_state_gmail.py",
     "a resolution already 'filed' on the prior same-digest row is carried forward VERBATIM (outcome + reason), never re-evaluated - pinned directly on _merge_resolutions, since at integration level G-MERGE-2's effect carry-forward alone already stops the replay",
     "scripts/brain/tests/test_client_state_gmail.py::test_a_filed_prior_resolution_is_carried_verbatim_not_re_evaluated",
     r's/if old is not None and old\.outcome == "filed":  # G-MERGE-1/if False:  # G-MERGE-1 (mutated)/'),
    ("G-ESC-1", "scripts/brain/client_state_gmail.py",
     "escalation fires at most once per (source_ref, content_digest) via ledger.escalated_for - marked at both the "
     "no-pending and the has-pending escalation branches",
     "scripts/brain/tests/test_client_state_gmail.py::test_ambiguous_message_escalates_once_then_stays_silent",
     r's/if escalated and not ledger\.escalated_for\(source_ref, digest\):  # G-ESC-1/if False:  # G-ESC-1 (mutated)/g'),
    ("G-QUERY-1", "scripts/brain/client_state_gmail.py",
     "run() passes cfg.query through to gmail_source.sweep as extra_query - the manual backfill query never bypasses the "
     "exclusion filter or date bounds",
     "scripts/brain/tests/test_client_state_gmail.py::test_backfill_query_composes_exclusion_and_day_sweep",
     r's/gmail_source\.sweep\(runner, cfg\.days, cfg\.today, extra_query=cfg\.query\)  # G-QUERY-1/gmail_source.sweep(runner, cfg.days, cfg.today)  # G-QUERY-1 (mutated)/'),
    ("G-FAIL-1", "scripts/brain/client_state_gmail.py",
     "GmailSourceError/ExtractionError/WriterError/TaskEnumerationError/EscalationError/LeaseLost all "
     "record_failure (with this run's partial progress) + exit 3",
     "scripts/brain/tests/test_client_state_gmail.py::test_task_enumeration_error_exit_3",
     r's/^        record_failure\(cfg\.state_dir, str\(exc\), .*\)  # G-FAIL-1$/        pass  # G-FAIL-1 (mutated)/'),
    ("G-BUDGET-1", "scripts/brain/client_state_gmail.py",
     "BudgetExceeded's already-paid extraction cost is added to state.cost before persisting the failure receipt - never discarded",
     "scripts/brain/tests/test_client_state_gmail.py::test_budget_exceeded_persists_partial_cost_and_exits_12",
     r's/state\.cost \+= float\(exc\.extraction\.get\("cost_usd", 0\.0\)\)  # G-BUDGET-1/pass  # G-BUDGET-1 (mutated)/'),
    ("G-CRM-1", "scripts/brain/client_state_gmail.py",
     "contact auto-create fires ONLY for the message SENDER, never a recipient",
     "scripts/brain/tests/test_client_state_gmail.py::test_recipient_without_contact_never_auto_created",
     r's/if contact_id is None and is_sender:  # G-CRM-1/if False:  # G-CRM-1 (mutated)/'),
    ("G-CRM-2", "scripts/brain/client_state_gmail.py",
     "an add-interaction CRM row is written only when a contact_id is actually resolved (known or just auto-created)",
     "scripts/brain/tests/test_client_state_gmail.py::test_two_known_contacts_same_page_one_history_two_crm_rows",
     r's/if contact_id is not None:  # G-CRM-2/if False:  # G-CRM-2 (mutated)/'),
    ("G-HIST-1", "scripts/brain/writeback_email.py",
     "render_history_entry appends a '(revision of <digest8>)' suffix on the first line when e.revision_of is set",
     "scripts/brain/tests/test_writeback_email.py::test_render_history_entry_revision_marker",
     r's/if e\.revision_of:  # G-HIST-1/if False:  # G-HIST-1 (mutated)/'),
    ("G-HIST-2", "scripts/brain/client_state_gmail.py",
     "the page read + apply_history render + atomic write for a bound page all happen under the SAME advisory "
     "client_file_lock the meeting pipeline uses, so a concurrent meeting-writeback filing can never interleave",
     "scripts/brain/tests/test_client_state_gmail.py::test_history_write_happens_under_the_meeting_pipeline_file_lock",
     r's/with client_file_lock\(page\):  # G-HIST-2/with __import__("contextlib").nullcontext():  # G-HIST-2 (mutated)/'),
    ("G-PARITY-1", "scripts/brain/client_state_writes.py",
     "write_interaction's argv is built by plan_add_interaction_argv (client_state_projections), never re-derived locally - "
     "second site: client_state_gmail.py's plan_history_entry call for the History write",
     "scripts/brain/tests/test_client_state_writes.py::test_write_interaction_argv_pinned",
     r's/argv = plan_add_interaction_argv\(crm_dir, contact_id, msg, extraction\)  # G-PARITY-1/argv = ["mutated"]  # G-PARITY-1 (mutated)/'),
    ("G-WRITER-1", "scripts/brain/client_state_writes.py",
     "ensure_contact/write_interaction/create_task all raise WriterError on a nonzero subprocess rc, never silently proceed - "
     "3 sites: ensure_contact (mutated here), write_interaction, create_task",
     "scripts/brain/tests/test_client_state_writes.py::test_ensure_contact_raises_writer_error_on_nonzero_rc",
     r'/def ensure_contact/,/^def /{s/if result\.returncode != 0:  # G-WRITER-1/if False:  # G-WRITER-1 (mutated)/;}'),
    ("G-TASK-1", "scripts/brain/client_state_projections.py",
     "plan_task_create_argv's argv always carries --type human for an email-sourced commitment task",
     "scripts/brain/tests/test_client_state_projections.py::test_plan_task_create_argv",
     r's/"--type", "human",  # G-TASK-1/"--type", "agent",  # G-TASK-1 (mutated)/'),
    ("G-TASK-2", "scripts/brain/client_state_writes.py",
     "list_open_tasks raises TaskEnumerationError on a nonzero rc from EITHER class query - never silently returns an "
     "'authoritative' empty list",
     "scripts/brain/tests/test_client_state_writes.py::test_list_open_tasks_raises_on_nonzero_rc",
     r's/if result\.returncode != 0:  # G-TASK-2/if False:  # G-TASK-2 (mutated)/'),
    ("G-DEDUP-1", "scripts/brain/client_state_writes.py",
     "tier1_duplicate's SequenceMatcher ratio must be STRICTLY > 0.75 - exactly 0.75 is NOT a duplicate",
     "scripts/brain/tests/test_client_state_writes.py::test_tier1_duplicate_boundary_ratio_exactly_0_75_is_false",
     r's/return ratio > 0\.75  # G-DEDUP-1/return ratio >= 0.75  # G-DEDUP-1 (mutated)/'),
    ("G-LEDGER-8", "scripts/brain/observation_ledger.py",
     "cached_extraction finds the newest stamped extraction for an identity ANYWHERE in history, so a later "
     "extraction-less row (an ignored/escalated re-evaluation) cannot hide a claude call already paid for (G2B-2)",
     "scripts/brain/tests/test_observation_ledger.py::test_cached_extraction_finds_the_newest_match_across_full_history",
     r's/if cached and cached\.get\("identity"\) == identity:  # G-LEDGER-8/if False:  # G-LEDGER-8 (mutated)/'),
    ("G-LEDGER-6", "scripts/brain/observation_ledger.py",
     "a SIMULATED (--dry-run) row is never terminal and never gates the FR-003 escalation - marked at is_terminal, "
     "escalated_for, and both ObservationRow constructions in client_state_gmail._file_message",
     "scripts/brain/tests/test_client_state_gmail.py::test_dry_run_then_live_run_still_performs_every_write",
     r's/if row\.simulated:  # G-LEDGER-6: a simulated \(dry-run\) row is never terminal/if False:  # G-LEDGER-6 (mutated)/'),
    ("G-LEDGER-7", "scripts/brain/client_state_gmail.py",
     "a recovery row's `partial` flag is DERIVED from its resolutions, never a blanket True - a failure after every "
     "effect landed and every resolution was filed leaves nothing to finish, and flagging it partial made the message "
     "non-terminal forever (G2B-1); second site: is_terminal's prose in observation_ledger.py",
     "scripts/brain/tests/test_client_state_gmail.py::test_recovery_row_after_every_effect_landed_is_terminal",
     r's/partial=any\(r\.outcome != "filed" for r in resolutions\),/partial=True,  # G-LEDGER-7 (mutated)/'),
    ("G-LOCKREF-1", "scripts/brain/client_state_gmail.py",
     "a lock-held refusal writes last-lock-refusal.json and leaves run-receipt.json BYTE-IDENTICAL (binding goal G4 "
     "item 5, amended 2026-09-14) - second site: observation_ledger.record_lock_refusal's own path",
     "scripts/brain/tests/test_client_state_gmail.py::test_lock_held_exit_2_leaves_receipt_byte_identical_and_writes_refusal_file",
     r's/record_lock_refusal\(cfg\.state_dir, holder_pid=os\.getpid\(\), detail=str\(claims_dir\)\)  # G-LOCKREF-1/record_failure(cfg.state_dir, "lock-held")  # G-LOCKREF-1 (mutated)/'),
    ("G-LOCK-6", "scripts/brain/single_flight.py",
     "a lease whose lock file disappeared is never released (the lock under our name may now belong to the run that "
     "reclaimed it) - second site: client_state_gmail.run's finally-block release",
     "scripts/brain/tests/test_client_state_gmail.py::test_lost_lease_mid_run_stops_and_never_releases_the_replacement",
     r'/# G-LOCK-6: never release a lease/,+3 s/^            return$/            pass/'),
    ("G-SIM-1", "scripts/brain/client_state_gmail.py",
     "a LIVE run never carries forward 'filed' outcomes from a SIMULATED row - nothing was actually written, so the "
     "live run must do all of it",
     "scripts/brain/tests/test_client_state_gmail.py::test_dry_run_then_live_run_still_performs_every_write",
     r's/merge_prior = None  # G-SIM-1/pass  # G-SIM-1 (mutated)/'),
    ("G-ESC-2", "scripts/brain/client_state_gmail.py",
     "a failed send-telegram raises EscalationError so no 'escalated' row is persisted (escalated_for would otherwise "
     "gate the retry forever) - 2 further sites: both _send_escalation call sites",
     "scripts/brain/tests/test_client_state_gmail.py::test_escalation_send_failure_exits_3_and_never_records_escalated",
     r's/if proc\.returncode != 0:  # G-ESC-2/if False:  # G-ESC-2 (mutated)/'),
    ("G-ESC-3", "scripts/brain/client_state_gmail.py",
     "an 'escalated' outcome is persisted ONLY after send-telegram returned rc 0; an undelivered one is demoted to "
     "'pending' before any row is written, so the non-terminal row makes the next run re-send (G2A-1/G2B-5) - "
     "other sites: the _persist_partial call and the no-pending branch's failed-send row",
     "scripts/brain/tests/test_client_state_gmail.py::test_escalation_send_failure_exits_3_and_never_records_escalated",
     r's/r\.outcome = "pending"  # G-ESC-3/pass  # G-ESC-3 (mutated)/'),
    ("G-EXT-4", "scripts/brain/extract_email.py",
     "a CACHED extraction's matches_open_item indices are re-resolved against THIS invocation's context through the "
     "mapping stored with the cache - never applied blindly to a rebuilt list",
     "scripts/brain/tests/test_extract_email.py::test_cached_matches_are_rebound_against_the_current_context",
     r's/entry\["matches_open_item"\] = new_id  # G-EXT-4/entry["matches_open_item"] = idx  # G-EXT-4 (mutated)/'),
    ("G-WRITER-2", "scripts/brain/client_state_writes.py",
     "ensure_contact/write_interaction/create_task validate the SHAPE of a rc=0 stdout (slug id / interaction record "
     "carrying contact_id+source_ref / task_<epoch>_<digits>) - parseable output is not evidence the write landed - "
     "3 sites: ensure_contact (mutated here), write_interaction, create_task",
     "scripts/brain/tests/test_client_state_writes.py::test_ensure_contact_rejects_non_slug_stdout_as_an_id",
     r's/if lines and _CONTACT_ID_RE\.fullmatch\(lines\[-1\]\):  # G-WRITER-2/if lines:  # G-WRITER-2 (mutated)/'),
    ("G-BASE-2", "scripts/brain/client_state_digest.py",
     "a missing-ref violation's canonical identity is (ref, page) - comparing by ref alone grandfathers the same ref "
     "later going missing from a DIFFERENT page",
     "scripts/brain/tests/test_client_state_digest.py::test_new_violations_flags_the_same_ref_missing_from_a_different_page",
     r's/if \(item\["ref"\], item\.get\("page"\)\) not in base_refs  # G-BASE-2/if item["ref"] not in {r[0] for r in base_refs}  # G-BASE-2 (mutated)/'),
    ("G-OWNER-1", "scripts/brain/client_state_writes.py",
     "normalize_owner folds the bus's own assignee identities (human/user) onto 'josh', so a task THIS release created "
     "with --assignee human dedups the identical commitment next run",
     "scripts/brain/tests/test_client_state_writes.py::test_tier1_dedups_against_the_human_assigned_task_this_release_creates",
     r's/"human": "josh",  # G-OWNER-1/"human": "not-josh",  # G-OWNER-1 (mutated)/'),
    ("G-BUS-1", "src/bus/task.ts",
     "createTask persists options.type on the Task object ('human' stays 'human', never silently coerced to 'agent')",
     'tests/unit/bus/task-human-type.test.ts::persists type "human" on disk when options.type is "human"',
     r"s/type: taskType, \/\/ G-BUS-1/type: 'agent', \/\/ G-BUS-1 (mutated)/"),
    ("G-BUS-2", "src/bus/task.ts",
     "claimTask refuses a human-exempt task (isHumanExemptTask) unless opts.force is passed or the claimant is the "
     "human itself - evaluated BEFORE every successful return path, including the same-owner claim-file branch (G2B-7)",
     "tests/unit/bus/task-human-type.test.ts::throws the exact human-exempt message and leaves the task pending with no claim file",
     r"s/if \(isHumanExemptTask\(task\) && !opts\?\.force && !HUMAN_CLAIMANTS\.has\(agent\)\) \{/if (false) {/"),
    ("G-BUS-4", "src/bus/task.ts",
     "createTask's PROVISIONAL classifyTask (the one that picks the default due date) is given `type`, so a direct "
     "createTask(..., {type:'human'}) whose assignee/project/title imply nothing gets the human-class 2-day cap "
     "instead of the 7-day build default it would later contradict (G2A-5)",
     "tests/unit/bus/task-human-type.test.ts::caps the default due date at the human-class bound, not the build default",
     r"s/type: taskType, \/\/ G-BUS-4.*$/\/\/ G-BUS-4 (mutated)/"),
    ("G-SWEEP-10", "scripts/brain/gmail_source.py",
     "parse_message normalises EVERY Date form (RFC 2822 Date header, ISO-8601, epoch s/ms) into ISO-8601 UTC at the "
     "SOURCE, so a downstream date_iso[:10] is a real calendar date and never 'Sun, 14 Se' (G2a finding 4); second "
     "site: the flat gws +read shape in _parse_message_flat_shape",
     "scripts/brain/tests/test_gmail_source.py::test_parse_message_normalises_rfc2822_date_header",
     r's/date_iso=normalise_date_iso\(headers\.get\("date", ""\)\),  # G-SWEEP-10/date_iso=str(headers.get("date", "")),  # G-SWEEP-10 (mutated)/'),
    ("G-BUS-3", "src/bus/task.ts",
     "classifyTask treats type:'human' as class human, so a `--type human` task gets the human due-date cap, shows up "
     "in `list-tasks --class human` and never hits a build-only check (G2a finding 3); the CLI half - `--type human` "
     "with no --assignee defaulting the owner to 'human' - lives in src/cli/bus.ts, outside this registry's module set",
     'tests/unit/bus/task-human-type.test.ts::classifies a type:"human" task as human even when assigned to an agent',
     r"s/\|\| task\.type === 'human' \/\/ G-BUS-3.*$/|| false \/\/ G-BUS-3 (mutated)/"),
    # --- post-cap adjudication wave (2026-09-15, rulings A/B/C/F/K + the
    # G-PARITY-2 / G-MERGE-3 operative markers the same wave landed). 8 rows.
    ("G-MERGE-2", "scripts/brain/client_state_gmail.py",
     "a NOT-yet-filed prior resolution for the same digest hands its LANDED effect keys to the fresh one, so the retry completes only what is still missing and never replays a landed effect (ruling A / G0B3-1)",
     "scripts/brain/tests/test_client_state_gmail.py::test_failure_after_the_first_page_write_completes_the_second_page_next_run",
     r's/r\.effects = list\(old\.effects\)  # G-MERGE-2: landed effects survive the retry/r.effects = []  # G-MERGE-2 (mutated)/'),
    ("G-MERGE-3", "scripts/brain/client_state_gmail.py",
     "a counterparty the resolver no longer produces but which was ALREADY filed stays on the merged row -- dropping it would lose the record of a real write (ruling A / G0B-3); the prose form of this marker sits three lines above the operative one",
     "scripts/brain/tests/test_client_state_gmail.py::test_a_prior_filed_resolution_the_resolver_no_longer_produces_is_carried",
     r's/if key not in seen and old\.outcome == "filed":  # G-MERGE-3/if False:  # G-MERGE-3 (mutated)/'),
    ("G-EFFECT-1", "scripts/brain/client_state_gmail.py",
     "`filed` is set ONLY when every required effect key (CRM + History page + each task) landed for that resolution; anything short is persisted as `partial` (ruling A / G0B3-1)",
     "scripts/brain/tests/test_client_state_gmail.py::test_failure_after_the_first_task_completes_the_second_task_next_run",
     r's/if all\(key in resolution\.effects for key in required\):  # G-EFFECT-1/if False:  # G-EFFECT-1 (mutated)/'),
    ("G-EFFECT-2", "scripts/brain/client_state_gmail.py",
     "ANY exception escaping the write path persists the landed effects as a partial row - not just WriterError/"
     "EscalationError - so an OSError from page I/O or a runner timeout cannot make the retry replay a landed CRM "
     "write or append a duplicate History entry (G2a finding 2)",
     "scripts/brain/tests/test_client_state_gmail.py::test_oserror_on_the_history_write_persists_the_landed_crm_effect",
     r's/except Exception as exc:  # noqa: BLE001 -- G-EFFECT-2: ANY escape persists landed effects/except (client_state_writes.WriterError, EscalationError) as exc:  # G-EFFECT-2 (mutated)/'),
    ("G-EFFECT-3", "scripts/brain/client_state_gmail.py",
     "an effect that ALREADY landed for the message is credited to every current resolution that requires it before "
     "the skip, since the completeness check is per-resolution - a shared CRM contact or a late resolution onto an "
     "already-written page stayed `partial` forever and re-appended a row on every unchanged re-check (G2B-3); "
     "other sites: the History-page skip and the per-message task skip",
     "scripts/brain/tests/test_client_state_gmail.py::test_a_shared_crm_contact_credits_both_resolutions",
     r's/                mark\(key, \[resolution\]\)/                pass  # G-EFFECT-3 (mutated)/'),
    ("G-BUDGET-2", "scripts/brain/client_state_gmail.py",
     "a BudgetExceeded exit persists the extraction it ALREADY paid for as a non-terminal partial row before exit 12, so the retry is a cache hit and makes zero further claude calls (ruling B / G0B3-2, FR-001)",
     "scripts/brain/tests/test_client_state_gmail.py::test_budget_exit_persists_the_paid_extraction_so_the_retry_pays_nothing",
     r's/ledger\.append\(ObservationRow\(  # G-BUDGET-2/_ = (ObservationRow(  # G-BUDGET-2 (mutated)/'),
    ("G-REV-1", "scripts/brain/client_state_gmail.py",
     "a simulated or partial same-digest prior hands its `revision_of` forward, so the later live run still writes the supersede marker and the live row keeps the link (ruling C / G0B3-3, D-02)",
     "scripts/brain/tests/test_client_state_gmail.py::test_dry_run_revision_then_live_revision_keeps_the_supersede_marker",
     r's/revision_of = revision_of or same_digest_prior\.revision_of  # G-REV-1/revision_of = revision_of  # G-REV-1 (mutated)/'),
    ("G-PARITY-2", "scripts/brain/client_state_gmail.py",
     "the dry-run's page diff is rendered from the SAME plan_history_entry -> apply_history output the live run persists -- the dry/live branch is only whether to write it (second site: the plan_history_entry docstring in client_state_projections.py)",
     "scripts/brain/tests/test_client_state_parity.py::test_history_entry_parity_preview_diff_equals_live_page_write",
     r's/page_diffs\.append\(_diff_preview\(page, old_text, new_text\)\)  # G-PARITY-2/page_diffs.append(_diff_preview(page, old_text, old_text))  # G-PARITY-2 (mutated)/'),
    ("G-LOCK-7", "scripts/brain/single_flight.py",
     "a non-zero `meeting-brief-release` rc (or a timeout) raises LeaseReleaseError instead of passing silently (ruling K / G0B3-11); other sites: client_state_gmail.py's finally-block record_lease_release_failure call and observation_ledger.py's last-lease-release-failure.json path",
     "scripts/brain/tests/test_single_flight.py::test_lease_release_nonzero_rc_raises_lease_release_error",
     r's/if proc\.returncode != 0:  # G-LOCK-7/if False:  # G-LOCK-7 (mutated)/'),
    ("G-LOCK-8", "scripts/brain/single_flight.py",
     "Heartbeat.tick touches the lease at most every HEARTBEAT_INTERVAL_S but at EVERY runner call boundary, so a long sweep or a long extraction cannot let a held lease go stale (ruling F / G0B3-6, A2); other sites: HeartbeatRunner.run's two ticks and client_state_gmail.py's HeartbeatRunner wrap",
     "scripts/brain/tests/test_client_state_gmail.py::test_heartbeat_touches_through_a_long_sweep_and_a_long_extraction",
     r's/self\.lease\.touch\(\)          # G-LOCK-8/pass                        # G-LOCK-8 (mutated)/'),
]

_REGISTERED_IDS = {row[0] for row in GUARD_REGISTRY}
_GUARD_COMMENT_RE = re.compile(r"[#/]{1,2}.*?\b(G-[A-Z]+-\d+)\b")


def test_guard_registry_ids_are_unique():
    ids = [row[0] for row in GUARD_REGISTRY]
    assert len(ids) == len(set(ids)), f"duplicate guard ids: {ids}"


def test_guard_registry_has_78_rows():
    # Pinned count (rebuilt 2026-09-14 from the FINAL parts, G0 round-3
    # integration) so a future guard silently dropping out is itself caught.
    assert len(GUARD_REGISTRY) == 78, f"expected 78 rows, got {len(GUARD_REGISTRY)}"


def test_guard_registry_rows_have_five_fields():
    for row in GUARD_REGISTRY:
        assert len(row) == 5, f"row is not a 5-tuple: {row}"
        guard_id, module_path, description, test_node_id, sed_expr = row
        assert guard_id.startswith("G-")
        assert module_path.startswith("scripts/brain/") or module_path == "src/bus/task.ts"
        assert description
        assert "::" in test_node_id
        assert sed_expr


def test_no_unregistered_guard():
    """Every 'G-<ID>' token on a line that also carries a '#' (Python) is a
    registered GUARD_REGISTRY id (G-OPS-3 - no unregistered guard). The regex
    matches a G-ID ANYWHERE after a '#' on the same line (not only
    immediately following it) - real markers include forms like
    '# noqa: BLE001 -- G-DIG-2 sections fail independently', not only a bare
    '# G-<ID>' prefix. TS guards (G-BUS-*) live in src/bus/task.ts, outside
    this sweep's scope by design - reviewed by the vitest mutation rows in
    mutation-check.sh instead."""
    found: set[str] = set()
    offenders: list[str] = []
    for py_file in sorted(BRAIN_DIR.glob("*.py")):
        text = py_file.read_text(encoding="utf-8")
        for line in text.splitlines():
            if "#" not in line:
                continue
            hash_pos = line.index("#")
            for match in re.finditer(r"\b(G-[A-Z]+-\d+)\b", line[hash_pos:]):
                gid = match.group(1)
                found.add(gid)
                if gid not in _REGISTERED_IDS:
                    offenders.append(f"{py_file.name}: unregistered guard comment {gid!r}")
    assert not offenders, "\n".join(offenders)
    # every registered .py-module id must actually appear as a comment
    # somewhere in that tree once Tasks 1-20 are complete (TS rows excluded -
    # they're never found by this sweep by construction).
    py_registered = {row[0] for row in GUARD_REGISTRY if row[1].startswith("scripts/brain/")}
    missing = sorted(py_registered - found)
    if BRAIN_DIR.exists() and any(BRAIN_DIR.glob("*.py")):
        assert not missing, f"registered guard ids with no '#'-marked comment found: {missing}"
