# Master Plan — alloi-jobtread-400-logging

## Goal
Make `pave()` surface the real JobTread error body on non-2xx responses, so the next live
retry from Josh produces a readable error instead of a bare "400".

## Change
File: `/Users/joshweiss/code/jobtread-automation/src/jobtread.js`

Replace:
```js
if (!r.ok) throw new Error(`JobTread API ${r.status}`);
const data = await r.json();
if (data.errors?.length) {
  throw new Error(`JobTread: ${data.errors[0]?.message || "query error"}`);
}
// Some Pave errors Arrive as plain-text HTTP 400 (not JSON). When JSON but
// no data path, surface a readable error without leaking grantKey.
return data;
```

With:
```js
if (!r.ok) {
  const text = await r.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = parsed.errors?.[0]?.message || parsed.error || text;
  } catch {
    // plain-text body, use as-is
  }
  throw new Error(`JobTread API ${r.status}: ${detail}`);
}
const data = await r.json();
if (data.errors?.length) {
  throw new Error(`JobTread: ${data.errors[0]?.message || "query error"}`);
}
return data;
```

No leaking of `grantKey` — it's request-side only, never in the response body.

## Verify
1. `node -e` smoke check or existing test suite (check `package.json` for a test script) still
   passes / file has valid JS syntax.
2. Deploy to Railway (`git push` triggers auto-deploy, or `railway up` if not on a connected
   branch — check DEPLOY.md).
3. Have Josh retry the `/todo` submit in Slack once more.
4. Read the new detailed error (Railway logs or wherever `createTodo`'s caller surfaces the
   thrown Error to Slack) to find the actual JobTread validation rejection reason.
5. That real reason is a FOLLOW-UP fix, not part of this slug's scope — this slug only unblocks
   visibility into it.

## Risk
None — purely additive error-detail surfacing, no behavior change on the success path.
