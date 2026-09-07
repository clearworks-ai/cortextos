# Codex Critique — Week 4 Templates and Settings Validation

Generated: 2026-08-24T15:11:00Z

## Fix 1: One versioned runtime validator

**Rating:** RISKY

**Objections:**

- A single reject/accept schema is insufficient because fields have different safe failure modes. Identity, runtime, enabled state, permission mode, and timing values must fail closed; optional narration fields may safely default.
- Validation must be applied after merges and on hot rereads, not only on initial file load.
- A schema version migration path is needed for existing configs, otherwise a stricter validator can halt the fleet at rollout.

**Alternative interpretation:** The root defect is not merely missing validation but inconsistent ownership of defaults across daemon, dashboard, templates, and docs.

**Risk if implemented as described:** A globally strict validator could turn harmless legacy drift into a fleet outage, while a permissive validator could retain the unsafe `{}` fallback.

## Fix 2: Transactional CLI and dashboard scaffolding

**Rating:** SOUND

**Objections:**

- CLI and dashboard must call the same library; two transactional implementations will drift again.
- The transaction boundary must include template selection, placeholder closure, file permissions, skill links, config validation, registry update, and start ordering.
- Rollback must not remove a pre-existing directory or registry entry when retrying after partial prior work.

**Alternative interpretation:** The dashboard's direct copy is a second scaffolder, so eliminating it in favor of the CLI/library path is simpler than repairing both.

**Risk if implemented as described:** An incomplete transaction boundary can still leave an enabled partial agent or delete recoverable evidence after a failed start.

## Fix 3: Canonical cron API plus revision-aware settings writes

**Rating:** SOUND

**Objections:**

- Canonical cron writes must preserve last-fire metadata, backup semantics, and daemon hot-reload behavior.
- Compare-and-swap requires a stable revision source; file mtime alone is too coarse and vulnerable to replacement races.
- Config and cron mutations should not share one coarse lock if that creates avoidable scheduler latency.

**Alternative interpretation:** The config cron editor should be removed entirely rather than synchronized with a retired representation.

**Risk if implemented as described:** Replaying config crons into `crons.json` can overwrite newer schedules or cause duplicate fires.

## Fix 4: Runtime-aware template manifests and drift accounting

**Rating:** SOUND

**Objections:**

- Manifests need explicit optional/generated files and runtime-specific capability declarations; exact byte parity is wrong for rendered files.
- Existing agents lack trustworthy template provenance, so migration must infer cautiously and report `unknown`, never silently default.
- A PASS must include checked, skipped, unknown, and errored counts so zero coverage cannot equal success.

**Alternative interpretation:** Drift should validate capabilities/invariants rather than mirroring every template byte.

**Risk if implemented as described:** Overly strict manifests create permanent noise; overly loose manifests preserve the current false-pass problem.

## Fix 5: Handoff parity and threshold unification

**Rating:** RISKY

**Objections:**

- Copying one template block does not establish behavior parity unless every runtime's restart command and resume mechanism are tested.
- Threshold defaults are operational policy, not just constants. Changing runtime behavior to match stale comments could reintroduce restart churn.
- Validation must run on the fully merged config and preserve an explicit disabled/observe-only representation.

**Alternative interpretation:** Runtime defaults are authoritative; types, UI, and templates should first be corrected to describe them, with any policy change separately approved.

**Risk if implemented as described:** A cosmetic unification can silently change live restart thresholds across the fleet.

## Fix 6: OpenCode least-privilege unattended policy

**Rating:** RISKY

**Objections:**

- OpenCode's permission model must be mapped to actual autonomous workflows before removing allow-all, or routine cron execution may deadlock.
- Both the framework flag and native OpenCode policy must be tested; changing only one is ineffective.
- Prompt-level approval rules are not a technical enforcement boundary, so negative tests need real denied operations.

**Alternative interpretation:** If OpenCode cannot express the required allowlist, the safer interim position is to disable external/destructive capabilities for that runtime rather than claim equivalent approval enforcement.

**Risk if implemented as described:** A partial restriction either leaves the bypass intact or stalls all unattended work.
