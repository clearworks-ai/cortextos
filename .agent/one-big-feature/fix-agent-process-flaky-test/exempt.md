# Exempt: fix-agent-process-flaky-test

One-line test-timing fix in tests/unit/daemon/agent-process.test.ts (mock
statSync mtimeMs hardcoded from a stale `now` capture races against the
live Date.now() cutoffMs read in prepareFreshRollover(), causing the
findFreshRecentHandoffDoc poll to miss and fall into a 10s sleep that
blows the vitest 10000ms test timeout). No production code touched.
Provable by rerunning the single test file.
