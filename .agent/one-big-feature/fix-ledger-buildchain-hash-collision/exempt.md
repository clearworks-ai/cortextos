# Exempt: fix-ledger-buildchain-hash-collision

buildChain() in src/pipeline/ledger.ts resolves the previous-row pointer
via a single global Map<artifact_sha256, LedgerRow> built over ALL rows
(all slugs), last-writer-wins on hash collision. Any two rows across the
whole ledger that share content bytes (same artifact hash) corrupt
predecessor resolution for every slug that hits that hash going forward,
since the ledger is append-only. Already hit twice in production
(meeting-intelligence-spec06b-cxportal-dual-write-clean). Root cause
diagnosed and fix scoped by task_1785191310954_50265872. No new design —
targeted candidate-filtering fix in one function, provable by existing
tests/unit/pipeline/ledger.test.ts plus new collision-repro test.
