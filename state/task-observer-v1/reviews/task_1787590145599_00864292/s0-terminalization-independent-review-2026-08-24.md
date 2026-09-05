# S0 Terminalization Independent Adversarial Review

- Date: 2026-08-24
- Authority: `1787589499735-ophir-codex-6dnsx`
- Task: `task_1787590145599_00864292`
- Scope: Meeting Intelligence S0 terminalization, Briefs consumer and cortextOS producer
- Review posture: independent, read-only candidate inspection; no stage, commit, push, or descendants
- Terminal status: **FAIL**

## Severity counts

| Severity | Count |
|---|---:|
| Critical | 1 |
| High | 1 |
| Medium | 0 |
| Low | 0 |

PASS is forbidden because Critical and High are nonzero.

## Findings

### Critical — success receipts predate the manifests whose hashes they bind

Both success receipts declare `created_at: 2026-08-24T16:40:28Z`. Both terminalization adoption manifests declare `created_at: 2026-08-24T16:48:38Z`. Nevertheless, each success receipt embeds the exact SHA-256 of its later-declared terminalization manifest:

- Briefs receipt binds `889f154ed5d423288a2d429876dc2a2491d6a01a3386df7890e874044da1ca67`.
- cortextOS receipt binds `81613fd08ed1504e965a0fb70b4464afa8cb9d629dafefc074a8ed7446f6016c`.

The declared chronology is impossible for an immutable receipt: a receipt cannot truthfully bind the final bytes of a manifest declared eight minutes later unless the receipt timestamp was backdated or the binding was added post hoc. This breaks the claimed authority/provenance chain and makes the terminal success claims non-replayable as timestamped.

### High — independent exact-base comparison produced one candidate-only failure

I ran the cortextOS candidate and exact untouched base serially in disposable mirrors at valid lowercase-hyphen paths, with both root and dashboard dependency trees available and both trees built before the suites. The exact base was `15defb1307df39f2df77522e70737c46dac52079` / tree `caa05027b74c786fd3747c074b942c0b54e5f48b`.

- Candidate: exit 1; 16 failed files, 245 passed, 3 skipped; 3 failed tests, 3478 passed, 74 skipped; 3555 total.
- Base: exit 1; 15 failed files, 245 passed, 3 skipped; 2 failed tests, 3477 passed, 74 skipped; 3553 total.
- The 15 receipt-listed baseline failures matched.
- Candidate-only failure: `tests/unit/pty/pty-host-dispose.test.ts > pty-host-entry RW-4 dispose/SIGTERM grandchild reaping (real node-pty) > CONTROL — the old semantics (bare SIGKILL on the host) orphans the grandchild`.

Therefore the independently observed failure sets are not equal and the candidate-only failure set is not empty. The receipt's recorded earlier run may have avoided this apparently timing-sensitive failure, but the requested exact independent equality/zero-candidate-only gate is not satisfied.

## Rehashed artifacts

| Artifact | SHA-256 | Mode | Bytes |
|---|---|---:|---:|
| Briefs terminalization manifest | `889f154ed5d423288a2d429876dc2a2491d6a01a3386df7890e874044da1ca67` | `0600` | 2153 |
| cortextOS terminalization manifest | `81613fd08ed1504e965a0fb70b4464afa8cb9d629dafefc074a8ed7446f6016c` | `0600` | 2166 |
| Briefs success receipt | `a770ff9fa5a94e79d3d91e0962de8b35d01e9f7c45b8f383bc8a25f2a05f780b` | `0400` | 7590 |
| cortextOS success receipt | `74da5642ecc28cb8c58b9b32049c3714fc02c112de9ef91dae8d1f454e9429bc` | `0400` | 11432 |

All four hashes match their cross-references where present.

## Independently verified state and gates

- Exact candidate bases/trees: Briefs `5b521f2e4f0ec8655643b16641f41202705d7d6b` / `87f9c9ea1e0d019992b6126fe4d509100a153ff1`; cortextOS `15defb1307df39f2df77522e70737c46dac52079` / `caa05027b74c786fd3747c074b942c0b54e5f48b`.
- Candidate inventories excluding receipts reproduced exactly: Briefs 76 files, 793871 bytes, ledger `63927fb0744b03612cb4727b99139fc25f2e185aa9efe9760d55eea80202c2b6`; cortextOS 66 files, 807094 bytes, ledger `dfa2e5674306cff041a5c3e456ae32659316e319abc5d12f01a724f141860ec6`.
- Pre-receipt porcelain hashes reproduced exactly: Briefs `35ceeb6863daac51eb13bb1232afcf8d6c9eb46dfab1b118b212a570c45a3f12`; cortextOS `8eef5d68eae31d92f1e2f8e0b76f59aaa3bc501d64e8d984599cf7b4e4c503a8`.
- Receipt-only terminalization mutation reproduced: each current inventory is its frozen inventory plus only its named success receipt. Modes are included in the reproduced canonical ledgers.
- Both indexes are staged-empty; both index locks are absent; `lsof` reported no index/index-lock holders.
- No active terminalizer execution was found. The only matching live process was an inert `turn-ended` notification helper for the completed cortextOS session; no Briefs terminalizer process was present.
- Governed Draft 2020-12 validators independently passed in both repositories: 23 schemas compiled, 25 goldens validated, 53/53 governed negatives rejected, N/N-1 contract true, promotion authority false.
- Direct governed semantic validator replay passed with 145/145 adversarial attacks and zero positive errors.
- Focused contract tests passed 2/2 in both repositories.
- Briefs build passed; Briefs full suite passed 74/74.
- cortextOS typecheck and build passed.
- Bidirectional equality passed independently: 61/61 contracts in both directions and 10/10 Briefs product artifacts, including governed SHA-256, byte count, and mode checks.
- Privacy/runtime-reachability scan returned zero runtime test-secret references.
- `git diff --check` passed in both candidates.
- Final candidate receipt hashes remained unchanged after all review activity; neither candidate was staged, committed, or pushed.

## Circularity and self-authorization inspection

The validator and equality commands are candidate-supplied executables, so their JSON `pass` fields alone are not independent proof. I inspected the command implementations and replayed them. The equality scripts hash bytes, sizes, and modes against the externally pinned compatibility-manifest digest, perform containment checks, and require `promotion_authority=false`; the two directions use separately vendored copies and agreed. The Draft wrapper invokes the governed semantic validator, and direct output confirmed all 53 negatives and 145 attacks. These checks mitigate executable self-reporting, but they do not cure the impossible receipt/manifest chronology or the independently observed candidate-only full-suite failure.

## Terminal decision

**FAIL — Critical=1, High=1. Meeting Intelligence S0 terminalization is not independently terminalized under this review.**
