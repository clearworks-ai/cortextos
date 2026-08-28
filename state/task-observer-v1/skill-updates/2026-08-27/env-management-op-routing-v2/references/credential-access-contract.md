# Credential Access Contract

Internal staged contract; review-only until separately approved and published.

## Sanctioned implementation surface

Use the existing `src/utils/env.ts` resolver family. Short-lived CLI paths may
use `resolveOpRefs`; daemon/long-lived paths must use `resolveOpRefsAsync`.
Those functions constrain token exposure to `op inject` and `op read`, suppress
secret-bearing stderr, apply timeouts, cache success/failure, and retain literal
references on failure for typed degraded handling.

No generic child-command injection is allowed. If a new daemon/bus operation is
implemented, it must be a typed adapter over these restricted helpers and accept
no executable name, arbitrary argument list, shell text, or caller-provided env.

## Allowed operations

| Operation | Purpose | Inputs | Output rule |
|---|---|---|---|
| `identity_check` | Verify the injected service account | no target | structured fields parsed in memory; zero raw output in receipts |
| `resolve_refs` | Resolve a bounded map of authorized `op://` refs | key-to-ref map from protected env files | resolved values returned only to the authorized process |
| `read_ref` | Existing per-ref fallback | one authorized `op://` ref | secret returned only to the authorized process |

Anything else is `credential_operation_not_allowlisted` before an `op` process
starts.

## Identity contract

After token presence and wrapper availability succeed, run structured
`op whoami` through the same bounded `op`-only environment. Strictly parse the
known CLI schema; unknown or extra identity schema is provider failure. Require:

1. normalized identity type equals `SERVICE_ACCOUNT`; and
2. SHA-256 of the normalized stable non-secret identity identifier equals the
   opaque configured expected digest.

The configured receipt stores only the expected opaque digest/alias. Never log
the raw identity object, account URL, email, vault, item, field, or token.

## Closed outcome enum

- `credential_env_not_inherited`
- `credential_wrapper_unavailable`
- `credential_token_absent`
- `credential_token_rejected`
- `credential_identity_mismatch`
- `credential_access_denied`
- `credential_target_not_found`
- `credential_target_ambiguous`
- `credential_operation_not_allowlisted`
- `credential_timeout`
- `credential_provider_error`
- `credential_success`

Every non-success state proves: zero authorized-operation execution after the
failure point, zero secret output, zero raw provider error output, and no
interactive signin/biometric/desktop fallback.

## State transitions

1. Always perform a boolean token-presence check. Do not print token bytes.
2. If the agent subprocess lacks the token, determine whether the sanctioned
   restricted daemon/bus resolver is available. If not, return
   `credential_wrapper_unavailable`; if daemon presence is known but inheritance
   failed, return `credential_env_not_inherited`; if no authorized token source
   exists, return `credential_token_absent`.
3. Establish the bounded `op`-only environment. Token rejection returns
   `credential_token_rejected`.
4. Only now run structured identity verification. Mismatch returns
   `credential_identity_mismatch`. On steps 1–3 failures, tests must assert
   `whoami_attempted=false`.
5. Validate operation allowlist, target cardinality, and authority before the
   authorized operation. Denied, not-found, ambiguous, and non-allowlisted states
   execute zero authorized operations.
6. Apply a deterministic timeout. Provider text is discarded; receipts contain
   only `credential_timeout` or `credential_provider_error`.
7. Success requires the expected identity, exactly one authorized target where
   applicable, bounded operation completion, and zero secret/provider output in
   logs and receipts.

## Required tests

Tests must bind the real `env.ts` helpers with mocked `execFile`/`execFileSync`:

- local token, process token, and unresolved-token-ref precedence;
- daemon async path never uses sync subprocesses;
- arbitrary executable/arguments rejected before spawn;
- token absent vs not inherited vs wrapper unavailable;
- token rejected; identity type mismatch; opaque identifier mismatch;
- `whoami_attempted=false` for every pre-injection failure;
- denied, not-found, ambiguous, and non-allowlisted targets;
- timeout and provider error with provider/secret sentinel absent from logs;
- successful structured identity and authorized inject/read;
- zero authorized-operation calls for every failure state;
- zero secret bytes and zero raw `op` output in every receipt;
- cache/idempotence/recovery semantics preserved.

