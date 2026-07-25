# Spec 02 — Doc-exempt lane unit tests in hook-gates.test.ts

**Target file:** `/Users/joshweiss/code/cortextos/tests/unit/pipeline/hook-gates.test.ts` (707 lines today)

All additions go INSIDE the existing `describePrHook('pr push gate hook', ...)` suite
(opens L261, closes L707). No changes to imports, `runHook` (L43-53), `runGit` (L76-84),
or the `beforeEach` (L436-471). **No stub seam is needed and none may be added:** the
harness already builds a real temp git repo (`git init` + `feature/hard-spec-gate` branch
+ empty init commit + fake origin, L465-470), so the hook's real `git diff` runs against
real branches/commits. The fake origin URL is never fetched, so `origin/main` never
resolves and the hook exercises its documented `main` fallback. Zero product-code change
beyond the hook itself.

## 1. Two new helpers

Insert after `emitTrueVerifyRow` (ends L434), before the `beforeEach` (L436), matching the
existing helper style:

```ts
  function emitExemptRow(nowSeconds: number, slug = 'hard-spec-gate'): void {
    const exemptArtifactPath = join(projectRoot, '.agent', 'one-big-feature', slug, '07-exempt-note.md');
    mkdirSync(dirname(exemptArtifactPath), { recursive: true });
    writeFileSync(exemptArtifactPath, 'doc-only change; nothing runnable to true-verify\n', 'utf-8');
    emitLedgerRow({
      slug,
      stage: 'exempt',
      artifactPath: exemptArtifactPath,
      reason: 'doc-only template port',
      ledgerPath,
      secretPath,
      nowSeconds,
    });
  }

  function commitFiles(files: Array<[string, string]>, message: string): void {
    for (const [rel, content] of files) {
      const abs = join(projectRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
      runGit(['add', rel], projectRoot);
    }
    runGit(['commit', '-m', message], projectRoot);
  }
```

Notes:
- `emitLedgerRow` (imported at L14) accepts `reason` and REQUIRES it for `stage: 'exempt'`
  (src/pipeline/ledger.ts L876-877). Exempt is a standalone genesis stage
  (`allowedPreviousStages('exempt') = []`, ledger.ts L348) — no prior chain rows needed.
- `mkdirSync`, `writeFileSync`, `dirname`, `join` are already imported.

## 2. Three new test cases

Append after the last existing `it` (`'--repo naming a prod repo enforces staging-first
from any checkout'`, ends L706), inside the describe block. Each test creates a `main`
branch at the init commit, then commits on `feature/hard-spec-gate` (the current branch
from `beforeEach`), so `git diff main...feature/hard-spec-gate` yields exactly the
committed files. Origin stays the `beforeEach` default `joshweiss/cortextos`
(`is_prod_repo=false` — staging gate not in play; the true-verify gate is).

### (a) exempt row + doc-only diff → ALLOWED

```ts
  it('allows a doc-only PR with a signed exempt row (doc-exempt lane)', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    runGit(['branch', 'main'], projectRoot);
    commitFiles([['docs/runbook.md', '# runbook\n']], 'doc-only change');
    emitExemptRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
```

The ledger contains ONLY the exempt row — the test proves the lane allows without any
research/plan/specs/review/true-verify rows.

### (b) exempt row + code file in diff → BLOCKED (exempt-misuse)

```ts
  it('blocks exempt-misuse when the PR diff touches code files', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    runGit(['branch', 'main'], projectRoot);
    commitFiles([
      ['docs/runbook.md', '# runbook\n'],
      ['src/patch.ts', 'export const patched = true;\n'],
    ], 'doc plus code change');
    emitExemptRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain('exempt-misuse');
    expect(result.stdout).toContain('src/patch.ts');
  });
```

### (c) no exempt row → true-verify path unchanged (still blocks)

```ts
  it('doc-only PR without an exempt row still requires the true-verify chain', () => {
    runGit(['branch', 'main'], projectRoot);
    commitFiles([['docs/runbook.md', '# runbook\n']], 'doc-only change');

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).not.toContain('exempt-misuse');
  });
```

No ledger rows exist, so the hook's unchanged true-verify walk blocks (the reason is the
raw `pipeline-stage-emit --verify` output, e.g. NO_ROWS / missing-ledger — assert only the
block decision and the absence of the misuse message, matching the tolerant-assertion
style of the existing client-repo cases at L638-643).

Fail-closed coverage note: case (c)'s repo state doubles as the "exempt lane never fires
without a row" proof; the exempt+unresolvable-diff fall-through is enforced by the hook's
`DIFF_OK`/`BASE_REF` guards specced in 01-gate-pr-push.md (all existing suite cases —
which have NO `main` branch — must remain green after the hook edit, which itself proves
the no-base fall-through does not regress the true-verify/staging paths).

## 3. Run

```bash
cd /Users/joshweiss/code/cortextos
npm run build
npx vitest run tests/unit/pipeline/hook-gates.test.ts
```

All 11 existing cases + 3 new cases green. No other test files change.
