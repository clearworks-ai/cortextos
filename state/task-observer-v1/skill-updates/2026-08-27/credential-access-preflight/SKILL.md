---
name: credential-access-preflight
description: Deterministic internal preflight for unattended 1Password CLI access in cortextOS agents.
---

# Credential Access Preflight

Internal skill proposal. Staged for review only; not installed.

## Purpose

Prevent unattended agents from falling into interactive `op signin`, biometric,
or desktop-integration loops when a daemon-scoped 1Password service account is
the authorized access path.

## Required sequence

1. Classify the runtime as unattended or interactive. A cortextOS daemon agent
   is unattended even when its controlling user has a desktop session.
2. Check token presence without printing the token:

   ```sh
   test -n "${OP_SERVICE_ACCOUNT_TOKEN:-}"
   ```

3. If the token is absent from the agent subprocess, do not run `op signin`, do
   not request biometric/desktop interaction, and do not infer the credential is
   absent. Use only the reviewed platform wrapper that injects the daemon-scoped
   token into one bounded command environment. If no such wrapper is available,
   return a typed `credential_env_not_inherited` blocker to the authority owner.
4. Inside the bounded injected environment, verify identity without exposing
   output:

   ```sh
   op whoami >/dev/null
   ```

5. Perform only the authorized vault/item operation. Never broaden vault scope,
   print secret fields, pass secret values in command arguments, persist them in
   receipts, or copy them into agent memory.
6. Record only: agent, timestamp, access mechanism, token-presence boolean,
   identity-check result, authorized operation classification, failure type, and
   human handoff. Redact item names when client sensitivity requires it.

## Precedence and conflicts

- Current system/developer rules and explicit user authority outrank every recipe.
- Current AGENTS/GUARDRAILS authority boundaries outrank skills and task prose.
- This service-account path outranks historical biometric/desktop instructions
  for unattended agents.
- Historical success does not prove current access.
- Any conflict fails closed and routes to the current authority owner.

## Pre-delivery verification

- Confirm both embedded commands were executed once and their results inspected.
- Confirm the proposal contains no credential value, vault URL, token fragment,
  or raw secret-bearing log line.
- Confirm installed skills, bootstrap, runtime, and configuration remain unchanged.
- Confirm any future platform wrapper is independently reviewed before this skill
  is installed or referenced as executable infrastructure.

