# jobtread-cindy-fix — Research

Repo: ~/code/jobtread-automation (main, clean, HEAD ba8c757).

## Bug 1 — mention-unwrap

`src/inlineTodo.js:2`:
```
const MENTION_RE = /@(\S+)/;
```
Slack sends mentions as `<@U0123ABC|cindy>` (or bare `<@U0123ABC>` when no display name
cached). Current regex matches the raw markup `@U0123ABC|cindy` or `@U0123ABC>`, not the
human-readable name. Cindy Wu IS a valid JobTread member (`listMemberships` confirms) — this
is not a missing-roster problem, it's a parse bug: Slack's mention markup is never unwrapped
before matching.

Fix: unwrap `<@ID|name>` / `<@ID>` to bare name (or resolve ID→name via Slack API/roster
lookup) before running MENTION_RE, OR extend MENTION_RE to capture Slack's wrapped format
directly and resolve the captured ID against the JobTread/Slack roster.

## Bug 2 — internal-only-user filter

`src/jobtread.js:89-101` (`listMemberships`) — no filter distinguishing internal-only Slack
users (not real JobTread task assignees) from real members. Todo-creation logic downstream
needs to skip/reject mentions of internal-only users rather than silently mis-assigning or
erroring.

## Scope

Two isolated fixes, same repo, no schema/infra change, no new repo. framework=one-big-feature.

## Done-condition

1. `<@U0123ABC|cindy>` and `<@U0123ABC>` correctly resolve to real JobTread member "Cindy Wu"
   (or whichever member the Slack ID maps to) when creating a to-do.
2. Internal-only Slack users are filtered out of assignment candidates without crashing/
   mis-assigning.
3. Existing tests (if any) + a new regression test for the wrapped-mention case pass.
