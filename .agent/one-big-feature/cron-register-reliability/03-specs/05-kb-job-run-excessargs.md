# Spec 05 — kb-job-run `.allowExcessArguments(true)` (Scope D)

## Problem
`bus kb-job-run` (`src/cli/bus.ts:2392`) wraps an arbitrary command after `--`. It has
`.allowUnknownOption(true)` (bus.ts:2404) but NOT `.allowExcessArguments(true)`, so commander
rejects extra positional tokens in the wrapped command tail (commander treats them as excess
arguments; unknown-OPTION tolerance does not cover excess POSITIONALS).

## Change
`src/cli/bus.ts:2404` — one line, chain immediately after the existing call:
```ts
  .allowUnknownOption(true)
  .allowExcessArguments(true)
```
No other changes. Do not touch the `-- <command>` extraction logic in the action body
(the `ERROR: kb-job-run requires \`-- <command> [args...]\`` guard at bus.ts:2424 stays).

## Edge cases
- Verify no OTHER wrapper-style commands in bus.ts share the same gap; if found, list them in
  the PR description but do NOT change them in this spec (scope is kb-job-run only).

## Test that proves it
Unit test: parse
`['kb-job-run','myjob','--expected-interval','4h','--org','x','--','node','script.js','arg1','arg2']`
through the command → action receives jobName `myjob` and the wrapped tail intact, no
`CommanderError: too many arguments`.
