# Canonical Publishing Contract

## Canonical source and version

- Canonical package source after approval:
  `templates/agent-codex/plugins/cortextos-agent-skills/skills/env-management/`
- Proposed version: `env-management-op-routing-v2`
- Review source: this complete staged directory.
- No publication occurs from a bare `SKILL.md`; the full directory is the unit.

## Exact target roster

Publish to exactly these 11 active canonical `-codex` agent copies:

1. `auditmaster-codex`
2. `builddifferentprod-codex`
3. `crm-codex`
4. `frank2-codex`
5. `knox-codex`
6. `larry-codex`
7. `maven-codex`
8. `pa-codex`
9. `sage-codex`
10. `scout-codex`
11. `ophir-codex`

Legacy `maven` and `muse`, Auditos identities, retired aliases, `opencode`, and
`codexer` are explicitly outside this replicated env-management target set.
This is not a claim that excluded identities are absent; it is the accepted
canonical active `-codex` publishing scope for these 11 copies.

## Deterministic publisher requirements

The reviewed publisher must take: staged directory, expected staged SHA ledger,
version, exact target manifest, expected current hash per target, and explicit
backup root. It must:

1. Dry-run by default and print names/paths/hashes only.
2. Refuse apply without fresh authority and exact expected source/version/hash.
3. Refuse roster additions, legacy aliases, symlinks escaping targets, or current
   target hashes that differ from the baseline manifest.
4. Copy the full bundle to sibling temporary directories with mode preservation,
   fsync files/directories, and verify staged hashes before any rename.
5. Atomically move each old directory to a versioned backup, then atomically move
   the verified temporary directory into place. Persist an append-only transaction
   ledger after every rename.
6. On any failure, restore every moved target from its recorded backup and prove
   byte equality to its baseline hash. Never continue partially.
7. After success, prove all 11 target directories and the canonical template are
   byte-for-byte equal to the approved staged ledger.
8. A second identical apply is a no-op with the same receipt (idempotence).
9. Rollback requires the transaction ID and restores all 11 baseline bundles,
   followed by byte-match verification.

## Baseline drift

Ten canonical copies and the template currently share SHA-256 `abe0ffd6…` for
`SKILL.md`. Build Different currently has a divergent `SKILL.md` at
`fffff654…`. Both exact full hashes are stored in `publishing-manifest.json`;
the publisher must preserve each as its rollback baseline and must not silently
overwrite newly changed bytes.

