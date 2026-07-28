# Research — alloi-jobtread-400-logging

## Problem
Josh is live-testing the Alloi Slack /todo bot. Modal submits successfully (Request URLs +
Options Load URL all working), but the JobTread `createTask` call fails with a bare HTTP 400.
The real JobTread validation error is never surfaced anywhere — not to Slack, not to Railway logs.

## Root cause (confirmed by reading source)
`/Users/joshweiss/code/jobtread-automation/src/jobtread.js`, `pave()` function, line 55:

```js
if (!r.ok) throw new Error(`JobTread API ${r.status}`);
```

This throws using only the HTTP status code, BEFORE reading `r.text()`/`r.json()`. JobTread's
actual rejection reason (e.g. malformed `assignedMembershipIds`, bad date format, invalid
`parentTaskId`) is in the response body and is discarded. Every caller (`createTodo`,
`listMemberships`, `searchJobs`, `listJobTasks`) inherits this blind spot.

## Scope
Single-file fix: read and surface the response body (JSON `.errors[0].message` or plain text)
in the thrown Error before the `!r.ok` early-return. No other files touch this path. No schema
change, no new repo, no migration — one function in one file.

## Repo
`/Users/joshweiss/code/jobtread-automation` (separate repo, `alloius/JobTread-Automation`, not
under cortextos). Branch `feat/slack-todo-jobtread`. Railway project `upbeat-expression`,
service `JobTread-Automation`, env `production`, live URL
`jobtread-automation-production.up.railway.app`.
