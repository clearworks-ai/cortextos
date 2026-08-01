# jobtread-cindy-fix — Master Plan

Repo: `~/code/jobtread-automation` (main, clean, HEAD ba8c757). Framework: one-big-feature.
Research: `01-research.md` (same dir). Two isolated fixes, no schema/infra change.

## Repo facts (verified by reading source, not guessed)

- `src/inlineTodo.js` — pure/sync parser. `MENTION_RE = /@(\S+)/` (line 2). Already has a
  precedent for Slack-markup normalization: `normalizeSlackChannelLinks()` unwraps
  `<#C123|name>` → `#name` BEFORE the hashtag regex runs. User mentions get no such
  treatment, so `<@U0123ABC|cindy>` reaches `MENTION_RE` raw and matches garbage
  (`U0123ABC|cindy>` etc.).
- `src/slack.js` — has `slackApi(method, payload)` (JSON POST + `SLACK_BOT_TOKEN` Bearer).
  **No existing roster/user-lookup helper anywhere in `src/`** (searched: only `slackApi`,
  `viewsOpen`, `postToResponseUrl`). So bare-ID → name resolution must be added; it will be
  a new `users.info` helper in `src/slack.js` (GET + query string — `users.info` is a
  form/GET-style method, not a JSON-POST method, so it does NOT go through `slackApi`).
- `src/jobtread.js:89-101` — `listMemberships()` returns raw Pave membership nodes
  (`{id, user:{name}}`). No filtering. Comment notes `user.email` is NOT a Pave field on
  this org — schema was live-probed, so we must NOT invent new Pave fields (e.g. a
  hypothetical `type`/`isInternal` field) without a live probe. The internal-only filter
  therefore uses a config denylist, not a new Pave field.
- `src/handlers.js` — `handleSlashTodo` inline path: parse → `normalizeDate` → ack →
  `queueMicrotask(resolveJob → resolveAssignee → createTodo)`. All collaborators are
  dependency-injected via `deps` (test convention). Modal path builds assignee options from
  `listMemberships()` directly.
- Tests: `test/*.test.js`, `node --test` (`npm test`), Node ≥20, `assert/strict`,
  deps-injection mocks. Existing files: handlers, inlineTodo, jobtread, modal, verify.

## Fix 1 — mention-unwrap (`src/inlineTodo.js`, `src/slack.js`, `src/handlers.js`)

Approach mirrors the existing channel-link precedent:

1. New `normalizeSlackUserMentions(text)` in `inlineTodo.js`, run right after
   `normalizeSlackChannelLinks` inside `parseInlineTodoArgs`. It replaces the FIRST wrapped
   mention `<@U0123ABC|cindy>` / `<@U0123ABC>` with a space-free sentinel token
   (`@__slack_mention__`) and captures `{id, label}` out-of-band; subsequent wrapped
   mentions are inlined as plain `@label` (or `@ID` when bare) so they stay in the title.
   The sentinel keeps every downstream regex boundary intact — `HASHTAG_RE`'s `(?=\s*@…)`
   lookahead, `MENTION_RE`, and the title-stripping `.replace(mentionMatch[0], …)` all work
   unchanged. This also handles labels containing spaces (`<@U1|Cindy Wu>`), which a naive
   `@label` substitution would break (`/@(\S+)/` would only capture `Cindy`).
2. `parseInlineTodoArgs` return shape gains one optional field: when the assignee came from
   a wrapped mention, result includes `assigneeSlackId`; when the mention was bare (no
   label), `assignee` is `null` and resolution is deferred to the handler. Plain typed
   `@name` behavior is byte-for-byte unchanged (regression: all existing tests pass).
3. Bare-ID resolution happens in `handleSlashTodo` (async context, before
   `resolveAssignee`), via new `getUserDisplayName(userId)` in `src/slack.js` calling
   `users.info`; injectable through `deps` like every other collaborator.

## Fix 2 — internal-only-user filter (`src/internalOnly.js` new, `src/jobtread.js`, `src/handlers.js`)

- New tiny module `src/internalOnly.js`: parse env `INTERNAL_ONLY_USERS` (comma-separated;
  each entry is a Slack user ID `U…`/`W…` or a case-insensitive name) into
  `{ids:Set, names:Set}`; pure helpers `isInternalOnly({name, slackId}, denylist)` and
  `filterInternalOnly(memberships, denylist)`.
- `listMemberships()` in `jobtread.js` applies `filterInternalOnly` to the Pave nodes
  before returning — this cleans BOTH the modal's assignee dropdown and the inline fuzzy
  match in `resolveAssignee` at the single choke point the research identified
  (jobtread.js:89-101).
- `handleSlashTodo` inline path additionally rejects early with a clean, specific message
  ("…is an internal-only user — JobTread to-dos can't be assigned to them") when the
  mentioned Slack ID or resolved name is denylisted — before any fuzzy `includes()` match
  can mis-assign.
- Default (env unset) = empty denylist = exact current behavior. Safe default; the actual
  denylist value is a Railway env var set at deploy time, not code.

## Files touched

| File | Change |
|---|---|
| `src/inlineTodo.js` | add `SLACK_USER_MENTION_RE` + `normalizeSlackUserMentions`; wire into `parseInlineTodoArgs`; sentinel back-substitution in title |
| `src/slack.js` | add `getUserDisplayName(userId)` (users.info, GET) |
| `src/internalOnly.js` | NEW — denylist parse + `isInternalOnly` + `filterInternalOnly` |
| `src/jobtread.js` | `listMemberships` applies `filterInternalOnly` |
| `src/handlers.js` | bare-ID resolution + internal-only rejection in inline path; new `deps` slots |
| `test/inlineTodo.test.js` | wrapped/bare/multi-mention/space-label parse tests |
| `test/internalOnly.test.js` | NEW — denylist parse/filter/match tests |
| `test/handlers.test.js` | bare-ID resolution flow, users.info failure, internal-only rejection |
| `README.md` | document `INTERNAL_ONLY_USERS` env var |

Not touched: `src/modal.js`, `src/verify.js`, `index.js`, `DEPLOY.md` deploy mechanics.

## Order of operations

1. `src/internalOnly.js` + `test/internalOnly.test.js` (pure, zero deps) — green.
2. `src/inlineTodo.js` mention normalization + parse tests — green, existing tests untouched.
3. `src/slack.js` `getUserDisplayName`.
4. `src/jobtread.js` `listMemberships` filter.
5. `src/handlers.js` wiring + handler tests.
6. Full `npm test` regression pass.

## Risks / edge cases (all covered in specs + tests)

- **Bare `<@U0123ABC>` with no label** — needs `users.info`; requires the bot token to have
  `users:read` scope. Failure (missing scope, deleted user, network) must produce a clean
  response_url error, never a crash or silent mis-assign. Deploy-time check: confirm scope
  on the Slack app before calling this shipped.
- **Label with spaces** (`<@U1|Cindy Wu>`) — sentinel design handles it; naive unwrap would
  truncate to `Cindy`.
- **Multiple mentions in one message** — first mention = assignee (matches current
  first-match behavior of `MENTION_RE`); later wrapped mentions are unwrapped into readable
  title text, never a second sentinel.
- **Plain `@name` typed before a wrapped mention** — `MENTION_RE` picks the plain one; the
  sentinel must be back-substituted in the title so `@__slack_mention__` never leaks to the
  user.
- **Mention of a non-member** — unchanged existing path: `resolveAssignee` returns
  "No team member found matching …" (regression-tested).
- **Internal-only user** — rejected with a specific message, not the confusing
  "No team member found", and never fuzzy-matched onto a real member.
- **Pave schema risk** — deliberately NOT adding any new Pave field to the memberships
  query (org schema is quirky per the live-probed `user.email` note). Env denylist instead.
- **Sentinel collision** (user literally types `@__slack_mention__`) — accepted negligible
  risk; documented, not defended.
- **`listMemberships` now filtered** — modal dropdown shrinks only when env var is set;
  with env unset it is identity (regression-safe).

## Test plan

- `npm test` (node --test) — all existing tests pass unchanged (the regression bar).
- New unit tests per file table above; exact cases enumerated in `03-specs.md`.
- Done-condition mapping (from 01-research.md):
  1. wrapped + bare Cindy mentions resolve to real member → inlineTodo parse tests +
     handlers bare-ID flow test.
  2. internal-only users skipped cleanly → internalOnly tests + handlers rejection test +
     listMemberships filter test.
  3. regression test for wrapped-mention case exists and passes → test/inlineTodo.test.js.
