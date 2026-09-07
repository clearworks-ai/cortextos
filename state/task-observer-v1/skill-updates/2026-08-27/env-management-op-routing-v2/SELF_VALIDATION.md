# Self-Validation Receipt

Status: **PASS**

- Failed v1 bundle remains unchanged at SHA-256 `d66935cb60101d28b3e67f29874716ecd0f540bde57eb79ab78af7d0a805d111`.
- Cold review is bound at SHA-256 `e26a2deaba9c8f03a00c76f0d40a63e453bf7a526a6d4d52677dcde9691f5341`.
- Live canonical template remains unchanged at SHA-256 `abe0ffd653c19f6ebe4518d55fcc458b114de34dd746c8f504ff3113b0752f62`.
- Existing restricted `src/utils/env.ts` resolver paths are explicitly designated; generic child injection is prohibited.
- Structured identity requires `SERVICE_ACCOUNT` plus opaque configured identifier digest match.
- Token presence is always checked; `whoami` is conditional and asserted unattempted on pre-injection failures.
- All 12 typed outcomes and required zero-operation/zero-output invariants are present.
- Exact 11-copy canonical `-codex` roster and explicit legacy Maven/Muse exclusions are present.
- Canonical source, version, baseline hashes, idempotence, atomic update points, rollback, and post-publish byte-match requirements are present.
- Receipts are opaque by default.
- `manifest.json`, `publishing-manifest.json`, and `SHA256SUMS.json` parse as valid JSON.
- No secret value, token assignment, concrete `op://` target, build artifact, installed-skill edit, runtime mutation, or configuration mutation was introduced.

Validation command: `tests/self-validate.sh` → `SELF_VALIDATION_PASS`.
