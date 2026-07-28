# Spec — pave() error body logging

## Repo / file
`/Users/joshweiss/code/jobtread-automation/src/jobtread.js`

## Exact change
In the `pave()` function, replace the `if (!r.ok) throw new Error(...)` block (currently line 55)
so it reads the response body before throwing, and includes the parsed/raw detail in the thrown
Error message. JSON body: use `.errors[0].message` or `.error`. Non-JSON body: use raw text.
Never include `grantKey` in the thrown message (it's request-only, not present in responses, so
this is automatically satisfied — no redaction logic needed).

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
```

Everything else in `pave()` (the `data.errors?.length` JSON-body-but-non-2xx-is-fine path,
the `return data`) stays unchanged.

## Acceptance
- File parses/lints clean (no syntax errors).
- Existing behavior on 2xx responses unchanged.
- On non-2xx, thrown Error message now contains the response body detail, not just the status
  code.
- No new dependencies, no other files touched.
