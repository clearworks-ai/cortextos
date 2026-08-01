# jobtread-cindy-fix — Implementation Spec

Repo: `~/code/jobtread-automation`. ESM (`"type":"module"`), Node ≥20, tests via
`npm test` → `node --test test/**/*.test.js`, `node:assert/strict`. No new npm deps.
Implement in the order given. Do not touch `src/modal.js`, `src/verify.js`, `index.js`.

Verified fact: there is NO existing Slack roster/user-lookup helper in the repo. `src/slack.js`
exports only `slackApi` (JSON POST), `viewsOpen`, `postToResponseUrl`. You will add the
`users.info` helper in step 3 — do not invent a roster cache.

---

## Step 1 — NEW `src/internalOnly.js`

```js
const SLACK_ID_RE = /^[UW][A-Z0-9]{4,}$/;

/**
 * Parse INTERNAL_ONLY_USERS env var: comma-separated tokens, each either a
 * Slack user ID (U…/W…) or a member name (case-insensitive exact match).
 * Empty/unset env → empty denylist (no behavior change).
 */
export function getInternalOnlyDenylist(env = process.env) {
  const ids = new Set();
  const names = new Set();
  for (const token of (env.INTERNAL_ONLY_USERS || "").split(",")) {
    const t = token.trim();
    if (!t) continue;
    if (SLACK_ID_RE.test(t)) ids.add(t);
    else names.add(t.toLowerCase());
  }
  return { ids, names };
}

export function isInternalOnly({ name, slackId }, denylist) {
  if (slackId && denylist.ids.has(slackId)) return true;
  if (name && denylist.names.has(name.toLowerCase())) return true;
  return false;
}

/** Filter JobTread membership nodes ({id, user:{name}}) by denylisted names. */
export function filterInternalOnly(memberships, denylist) {
  if (denylist.names.size === 0) return memberships;
  return memberships.filter(
    (m) => !denylist.names.has((m?.user?.name || "").toLowerCase()),
  );
}
```

## Step 2 — `src/inlineTodo.js` (Bug 1 core)

Keep `MENTION_RE = /@(\S+)/` as-is. Add after `SLACK_CHANNEL_LINK_RE` (line 4):

```js
const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g;
const MENTION_SENTINEL = "__slack_mention__";

function normalizeSlackUserMentions(text) {
  const mentions = [];
  const normalizedText = text.replace(
    SLACK_USER_MENTION_RE,
    (_match, userId, label) => {
      const trimmedLabel =
        typeof label === "string" && label.trim() ? label.trim() : null;
      if (mentions.length === 0) {
        mentions.push({ id: userId, label: trimmedLabel });
        return `@${MENTION_SENTINEL}`;
      }
      // Later mentions are not the assignee — inline as readable text for the title.
      return `@${trimmedLabel || userId}`;
    },
  );
  return { normalizedText, mention: mentions[0] || null };
}
```

Modify `parseInlineTodoArgs(text)`:

1. First line becomes a two-stage normalize (channel links first, then user mentions):
   ```js
   const { normalizedText: channelNormalized, sawBareChannelLink } =
     normalizeSlackChannelLinks(text);
   const { normalizedText, mention } = normalizeSlackUserMentions(channelNormalized);
   ```
   All subsequent matching (`HASHTAG_RE`, `MENTION_RE`, `DATE_TOKEN_RE`) runs on the
   final `normalizedText` — unchanged code otherwise. The sentinel is `\S+` and starts
   with `@`, so `HASHTAG_RE`'s `(?=\s*@…)` lookahead and `MENTION_RE` behave exactly as
   they do today for plain mentions.
2. Assignee extraction (replaces the current `const assignee = mentionMatch[1].trim();`):
   ```js
   const rawAssignee = mentionMatch[1].trim();
   let assignee = rawAssignee;
   let assigneeSlackId;
   if (mention && rawAssignee === MENTION_SENTINEL) {
     assignee = mention.label; // may be null for bare <@U…> — resolved later in handler
     assigneeSlackId = mention.id;
   }
   ```
3. Title computation is unchanged, EXCEPT: after the existing
   `.replace(...).trim()` chain, back-substitute a leaked sentinel (case: a plain typed
   `@name` appeared BEFORE the wrapped mention, so `MENTION_RE` consumed the plain one and
   the sentinel stayed in the title):
   ```js
   if (mention && title.includes(`@${MENTION_SENTINEL}`)) {
     title = title
       .replace(`@${MENTION_SENTINEL}`, `@${mention.label || mention.id}`)
       .replace(/\s+/g, " ")
       .trim();
   }
   ```
   (Change `const title` to `let title`.)
4. Success return becomes:
   ```js
   return assigneeSlackId
     ? { ok: true, job, title, date, assignee, assigneeSlackId }
     : { ok: true, job, title, date, assignee };
   ```
   Exact-shape rule: `assigneeSlackId` key MUST be absent (not `undefined`) for plain
   mentions — existing tests use `assert.deepEqual` on the full object and must pass
   unchanged.
5. `resolveJob`, `resolveAssignee`, `disambiguate`, date functions: unchanged.

## Step 3 — `src/slack.js`

Add (do NOT route through `slackApi` — `users.info` is a GET/form-style method, not a
JSON-POST method):

```js
export async function getUserDisplayName(userId) {
  const r = await fetch(
    `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
    { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
  );
  const data = await r.json();
  if (!data.ok) throw new Error(`slack users.info failed: ${data.error}`);
  const profile = data.user?.profile || {};
  return (
    profile.display_name?.trim() ||
    profile.real_name?.trim() ||
    data.user?.real_name?.trim() ||
    data.user?.name?.trim() ||
    null
  );
}
```

## Step 4 — `src/jobtread.js` (Bug 2 choke point)

```js
import { filterInternalOnly, getInternalOnlyDenylist } from "./internalOnly.js";
```

In `listMemberships()` (lines 89-101), keep the Pave query byte-identical (do NOT add any
new Pave field — org schema is quirky; `user.email` is already documented as absent).
Change only the return:

```js
const nodes = data.organization?.memberships?.nodes ?? [];
return filterInternalOnly(nodes, getInternalOnlyDenylist());
```

This filters both the modal dropdown (handlers modal path) and inline fuzzy matching
(`resolveAssignee`) at one point.

## Step 5 — `src/handlers.js` wiring

Imports:

```js
import { viewsOpen, postToResponseUrl as defaultPostToResponseUrl, getUserDisplayName as defaultGetUserDisplayName } from "./slack.js";
import { isInternalOnly, getInternalOnlyDenylist } from "./internalOnly.js";
```

In `handleSlashTodo`, add deps slots next to the existing ones:

```js
const getUserDisplayName = deps.getUserDisplayName || defaultGetUserDisplayName;
const internalOnlyDenylist = deps.internalOnlyDenylist || getInternalOnlyDenylist();
```

In the inline path's `queueMicrotask`, insert BETWEEN the `resolveJob` block and the
`resolveAssignee` call:

```js
let assigneeTerm = parsed.assignee;
if (!assigneeTerm && parsed.assigneeSlackId) {
  try {
    assigneeTerm = await getUserDisplayName(parsed.assigneeSlackId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("slack user lookup failed", reason);
    if (responseUrl) {
      await postToResponseUrl(
        responseUrl,
        "Couldn't look up that Slack user mention — try typing the assignee's name instead (e.g. @Cindy).",
      );
    }
    return;
  }
}
if (!assigneeTerm) {
  if (responseUrl) {
    await postToResponseUrl(
      responseUrl,
      "Couldn't determine the assignee from that mention — try typing the name instead (e.g. @Cindy).",
    );
  }
  return;
}
if (
  isInternalOnly(
    { name: assigneeTerm, slackId: parsed.assigneeSlackId },
    internalOnlyDenylist,
  )
) {
  if (responseUrl) {
    await postToResponseUrl(
      responseUrl,
      `@${assigneeTerm} is an internal-only user — JobTread to-dos can't be assigned to them.`,
    );
  }
  return;
}
const assigneeResult = await resolveAssignee(assigneeTerm, listMemberships);
```

(i.e. the existing `resolveAssignee(parsed.assignee, …)` call changes its first argument to
`assigneeTerm`; everything after it is unchanged.)

Modal path and `handleInteraction`: unchanged (filtering arrives via `listMemberships`).

## Step 6 — README.md

Add `INTERNAL_ONLY_USERS` to the env-var documentation: comma-separated Slack user IDs
and/or member names that must never be offered or accepted as JobTread to-do assignees;
empty/unset = no filtering.

---

## Tests to add

### `test/inlineTodo.test.js` (append; follow existing `assert.deepEqual` style)

1. **wrapped mention with label**
   `parseInlineTodoArgs("#2516ar Mendocino <@U0123ABC|cindy> 8/5 Call inspector")`
   → `{ ok: true, job: "2516ar Mendocino", assignee: "cindy", assigneeSlackId: "U0123ABC", date: "8/5", title: "Call inspector" }`
2. **bare wrapped mention (no label)**
   `parseInlineTodoArgs("#2516ar Mendocino <@U0123ABC> 8/5 Call inspector")`
   → `{ ok: true, job: "2516ar Mendocino", assignee: null, assigneeSlackId: "U0123ABC", date: "8/5", title: "Call inspector" }`
3. **label with spaces**
   `parseInlineTodoArgs("#Roof <@U0123ABC|Cindy Wu> 8/5 Order shingles")`
   → assignee `"Cindy Wu"`, assigneeSlackId `"U0123ABC"`, title `"Order shingles"`.
4. **multiple wrapped mentions — first wins, rest stay readable in title**
   `parseInlineTodoArgs("#Roof <@U1AAAAA|cindy> 8/5 ping <@U2BBBBB|bob> about tiles")`
   → assignee `"cindy"`, assigneeSlackId `"U1AAAAA"`, title `"ping @bob about tiles"`.
5. **plain mention before wrapped mention — sentinel never leaks**
   `parseInlineTodoArgs("#Roof @Marcos 8/5 sync with <@U1AAAAA|cindy> today")`
   → assignee `"Marcos"`, NO `assigneeSlackId` key, title `"sync with @cindy today"`.
6. **plain-mention regression (no wrapped markup)** — reassert test-1-style input
   `"#2516ar Mendocino @Marcos 8/5 Call inspector"` still returns the exact current shape
   (no `assigneeSlackId` key). All pre-existing tests must pass unmodified.
7. **W-prefixed ID** `"<@W9ZZZZZ|pat>"` variant of case 1 → assigneeSlackId `"W9ZZZZZ"`.

### `test/internalOnly.test.js` (NEW)

1. `getInternalOnlyDenylist({})` → empty sets.
2. `getInternalOnlyDenylist({ INTERNAL_ONLY_USERS: "U0123ABC, Frank Bot ,W9ZZZZZ" })`
   → ids `{U0123ABC, W9ZZZZZ}`, names `{"frank bot"}`.
3. `isInternalOnly({ slackId: "U0123ABC" }, dl)` true; `{ name: "FRANK BOT" }` true
   (case-insensitive); `{ name: "Cindy Wu" }` false; `{}` false.
4. `filterInternalOnly([{id:"m1",user:{name:"Cindy Wu"}},{id:"m2",user:{name:"Frank Bot"}}], dl)`
   → only m1. Empty denylist → same array back.

### `test/handlers.test.js` (append; use existing deps-injection + mock req/res pattern)

1. **bare-ID happy path**: inline text `"#Roof <@U0123ABC> 8/5 Order shingles"`, deps
   `getUserDisplayName: async () => "Cindy Wu"`, `listMemberships` returning
   `[{ id: "m1", user: { name: "Cindy Wu" } }]`, mock `resolveJob`/`createTodo`/
   `postToResponseUrl`. Assert `createTodo` called with `membershipId: "m1"` and success
   message posted. (Flush the microtask with `await new Promise((r) => setImmediate(r));`
   or the pattern existing handler tests already use.)
2. **users.info failure**: `getUserDisplayName: async () => { throw new Error("missing_scope"); }`
   → `postToResponseUrl` called with the "Couldn't look up that Slack user mention" message,
   `createTodo` NOT called.
3. **internal-only rejection**: deps `internalOnlyDenylist: { ids: new Set(["U0123ABC"]), names: new Set() }`,
   text `"#Roof <@U0123ABC|frank> 8/5 x"` → posted message contains
   `"internal-only user"`, `createTodo` NOT called.
4. **internal-only by resolved name**: denylist names `new Set(["frank bot"])`,
   `getUserDisplayName: async () => "Frank Bot"`, bare mention → same rejection.

### `test/jobtread.test.js`

Only if the existing file already mocks `fetch` for `listMemberships`: add one case with
`process.env.INTERNAL_ONLY_USERS = "Frank Bot"` (restore in `finally`) asserting the
returned nodes exclude Frank Bot. If the existing file has no fetch-mock pattern for
memberships, skip — `filterInternalOnly` is already covered by `internalOnly.test.js` and
the wiring is one line.

## Acceptance

- `npm test` fully green; zero modifications to pre-existing test assertions.
- `parseInlineTodoArgs` handles `<@U…|name>`, `<@U…>`, plain `@name` per the shapes above.
- Internal-only users never appear in modal options and are cleanly rejected inline.
- No new Pave fields queried; no new npm dependencies; `slackApi` untouched.
