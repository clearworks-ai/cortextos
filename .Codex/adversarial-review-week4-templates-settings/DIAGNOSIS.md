# Adversarial Diagnosis — Week 4 Templates and Settings Validation

Generated: 2026-08-24T15:06:00Z

## Summary

The template/settings surface has one critical fail-open configuration path and several high-confidence lifecycle, concurrency, and observability defects. The audit read all 229 files in the five primary agent template families plus 49 settings/scaffolding/runtime files and the prior weekly audit. No production or runtime state was changed.

## Problem Areas

### Runtime configuration validation

**Root Cause:** `src/daemon/agent-manager.ts:1780-1811` returns raw parsed JSON without runtime schema validation and converts missing, unreadable, or malformed configuration into `{}`. Downstream defaults treat `{}` as enabled, default the runtime to Claude, and skip permissions unless explicitly disabled (`src/daemon/agent-manager.ts:143`, `src/daemon/agent-process.ts:318`, `src/pty/agent-pty.ts:299`).

**Severity:** CRITICAL

**Confidence:** High

**Adversarial Counterargument:** Continuing with defaults preserves availability after a typo.

**What a Naive Fix Would Miss:** Validation must cover hand edits, imports, dashboard writes, CLI writes, and live rereads; rejecting the whole file without field-aware safe defaults could stop otherwise healthy agents.

### Canonical cron state drift

**Root Cause:** Dashboard cron PUT reads and writes `config.json` (`dashboard/src/app/api/agents/[name]/crons/route.ts:39,65,114`) although the daemon reads external `crons.json` (`src/daemon/cron-scheduler.ts:407`) and migration permanently skips after its marker (`src/daemon/cron-migration.ts:315`).

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** An agent notification may reconcile the edit later.

**What a Naive Fix Would Miss:** Re-running migration could overwrite newer cron state and fire metadata; the editor must use canonical locked cron APIs.

### Concurrent settings writes

**Root Cause:** Settings PATCH and cron PUT independently perform unlocked full-file read-modify-write operations (`dashboard/src/app/api/agents/[name]/config/route.ts:123`; `dashboard/src/app/api/agents/[name]/crons/route.ts:65,114`).

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** Human UI actions are usually serialized.

**What a Naive Fix Would Miss:** Atomic rename prevents torn JSON but not lost updates; revision checks or serialization are required.

### Dashboard scaffold transaction and secret handling

**Root Cause:** Dashboard creation byte-copies templates without rendering (`dashboard/src/app/api/agents/route.ts:120,199`), starts the agent before enabled-registry commit (`:144,161`), directly interpolates newline-capable secrets into `.env` (`:95,128`), and writes that file without mode `0600` (`:136`).

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** The dashboard is local and runtime identity comes from the directory.

**What a Naive Fix Would Miss:** Rendering only config does not resolve placeholders elsewhere; chmod alone does not stop newline injection; the entire scaffold must be validated and committed before start.

### CLI scaffold completeness

**Root Cause:** `copyTemplateFiles()` suppresses every per-entry failure (`src/cli/add-agent.ts:448-466`), while its caller reports success and proceeds to register/enable the agent (`:124-128` and later registration).

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** Filesystem copy failures are rare and onboarding checks core files.

**What a Naive Fix Would Miss:** Logging is insufficient; a partial agent must not be enabled. A manifest and transactional commit/rollback are needed.

### Drift detector blind spots

**Root Cause:** `doctor` requires `.claude/settings.json`, defaults missing template provenance to `agent`, skips missing/unparseable template/settings files, and reports PASS when its finding array is empty (`src/cli/doctor.ts:327-364`). None of the five primary template configs records `template`.

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** The check was intended only for Claude hook drift.

**What a Naive Fix Would Miss:** Provenance alone does not cover Codex/OpenCode surfaces, core docs, skills, skipped agents, or parse errors; explicit checked/skipped/error counts are required.

### Analyst context-handoff contract

**Root Cause:** `templates/analyst/AGENTS.md:44-74` teaches a hard restart on context exhaustion but omits the daemon-required handoff document, absolute path, five sections, and resume protocol. Parity tests cover agent, Codex, and OpenCode only (`tests/unit/cli/add-agent-template-parity.test.ts:61-74`).

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** The daemon injects detailed instructions when thresholds fire.

**What a Naive Fix Would Miss:** A heading is not enough; exact restart/handoff/resume semantics and parity tests must match.

### Context threshold contract drift

**Root Cause:** The public type documents 70/80 defaults (`src/types/index.ts:238`), runtime uses 30/60 (`src/daemon/fast-checker.ts:1175`), runtime supports `handoff <= 0` as opt-out (`:1349`), dashboard rejects values below 50 (`dashboard/src/app/api/agents/[name]/config/route.ts:95`), and ordering is validated only when both fields arrive in one request (`:104`).

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** Runtime behavior may have intentionally changed before docs/UI.

**What a Naive Fix Would Miss:** Shared constants alone do not validate the merged post-patch object or preserve the opt-out.

### OpenCode permission posture

**Root Cause:** `templates/agent-opencode/config.json:4-6` sets `dangerously_skip_permissions`, while `.opencode/opencode.json:3-17` independently grants `* = allow` globally and for build/plan.

**Severity:** HIGH

**Confidence:** High

**Adversarial Counterargument:** Unattended agents need noninteractive execution.

**What a Naive Fix Would Miss:** Flipping one flag leaves the other and may deadlock automation; policy must be runtime-specific and tested against destructive/external actions.

## Cross-Cutting Concerns

- The system has no single runtime schema or manifest spanning templates, dashboard creation, CLI creation, imports, daemon load, and live settings updates.
- Multiple paths prefer availability by swallowing errors, but then narrate success or PASS, turning degraded state into false assurance.
- The repository contains atomic-write and lock utilities, but settings/scaffold paths do not consistently use them.

## Proposed Fix Direction

1. Introduce one versioned runtime validator with field-aware fail-closed semantics and use it at every config ingress and live reread.
2. Make both CLI and dashboard scaffolding transactional: validated template allowlist, complete rendering, manifest verification, restrictive secret writes, atomic registry commit, then start.
3. Move dashboard cron editing to canonical locked `crons.json` APIs and add revision-aware settings writes.
4. Replace heuristic drift checks with runtime-aware manifests and explicit checked/skipped/error accounting.
5. Restore exact handoff-contract parity for analyst/orchestrator roles and unify threshold constants/merged-state validation.
6. Define and test an OpenCode least-privilege unattended policy rather than duplicated blanket allow-all settings.
