VERDICT: REJECT — new data-corruption bug found; needs a round-4 fix before merge.

## Critical bug (new, not previously documented): commitment description corruption

`sync_meetings_to_cxportal.py` lines 83-119. The diff replaced a single `if/elif/elif`
chain (mutually exclusive: attendees-section / commitment-section / continuation-line)
with two **separate, un-chained** `if` blocks:

```python
if current_section == "attendees":
    ...                                    # block 1

is_commitment_section = ...
if is_commitment_section:
    ...
elif current_commitments and line.strip():
    current_commitments[-1]["description"] += " " + line.strip()   # block 2
```

Because block 2 is no longer `elif`-chained to block 1 (or to any section check), any
line in **any non-commitment section that follows a commitment section** gets appended
onto the last captured commitment's description, as long as `current_commitments` is
still non-empty (it is only reset when a *new* commitment-type header is seen — never
on exit from one).

**This is not hypothetical — it corrupts the exact showcase file the task asks to
verify.** Independently ran `load_meeting_records()` against the real meetings dir and
inspected full commitment payloads (not just counts). `2026-06-24-alloi-it-services-discussion.md`
correctly shows 4 commitments, but commitment #4 ("Bones") has the entire subsequent
`## CRM updates applied` bullet list glued onto its description:

```
"Support Nathan in prep; participate in follow-up coordination - marcos-santa-ana,
bones-ijeoma, nathan-phinney · last_meaningful_contact = 2026-06-24 - nathan-phinney
contact created ... - Fireflies transcript deduped"
```

The instructed verification (dry-run counts: 5/5 attendees, 4 commitments on one file)
looks correct on the surface — the corruption is invisible in `--dry-run`'s summary
print (counts only, no description text) and untested by the new pytest, which only
asserts `len(commitments)` and owner-name substrings, never description content. This
would post garbage `description` fields to cxportal on a real (non-dry-run) push.

Also reproduced the same root cause synthetically with a `## Attendees` section placed
after `## Action items` — attendee names get appended onto the prior commitment's
description too, confirming this isn't file-specific.

Fix: restore mutual exclusivity — either reset `current_commitments = []` on every
section header (not just commitment-type ones) and/or re-chain the "attendees" /
"is_commitment_section" / "continuation" branches as one `if/elif/elif`.

## Known issue (confirmed still present, as documented)

`NEGATION_RE = re.compile(r"\b(non|not|no)\b")` at line 29 is applied via
`.search(current_section)` against the whole lower-cased header string, not a window
near the action-item/commitment keyword. Confirmed against real data:
`## Rachel action items (tracked, not in our queue)` is excluded via the unrelated
"not" in "not in our queue." In this specific file it's benign (Josh's own action-items
section captured 0 items anyway, since it uses numbered-list format that neither
`COMMITMENT_RE` nor `PROSE_COMMITMENT_RE` matches, so no data loss occurred here) — but
the scope bug is real and will misfire on unrelated headers in the future. Agreed this
is low-severity/acceptable as a documented known limitation, independent of the blocking
bug above.

## Test run output

`pytest tests/test_sync_meetings_to_cxportal.py -v` → 1 passed (does not catch the
corruption bug).
`--dry-run` against real meetings dir → 5/5 files show attendees; only the alloi file
shows commitments (4), matching the expected ground truth by count — but see corruption
above.

## Other notes

- `is_commitment_section` is recomputed on every body line (not just at the header) —
  harmless redundant work, not a bug (section doesn't change between headers).
- Attendee/commitment dedup (`not in meeting["attendees"]`) is correct and doesn't
  affect the bug above.
