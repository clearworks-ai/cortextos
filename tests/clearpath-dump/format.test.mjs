import assert from "node:assert/strict";
import test from "node:test";

import { renderMeetingNote } from "../../orgs/clearworksai/agents/larry/scripts/clearpath-dump/dump-meetings.mjs";

test("renderMeetingNote renders the shipped meeting-note schema with provenance", () => {
  const rendered = renderMeetingNote(
    {
      fireflies_transcript_id: "ff_123",
      title: "Scholarship Schools - Implementation Review",
      date: "2026-03-10T16:00:00Z",
      host_email: "josh@clearworks.ai",
      participants: ["josh@clearworks.ai", "ops@scholarshipschools.org"],
      summary_overview: "Reviewed implementation progress.",
      summary_bullets: ["Confirmed timeline."],
      action_items: [{ action: "Send recap deck", owner: "Josh", dueDate: "2026-03-12" }],
      decision_items: [{ decision: "Proceed with the next milestone" }],
    },
    { runDate: "2026-07-30" },
  );

  assert.equal(rendered.filename, "2026-03-10-scholarshipschools-implementation-review.md");
  assert.match(rendered.body, /\*\*Source:\*\* fireflies:ff_123 · clearpath-backfill:2026-07-30/);
  assert.match(rendered.body, /## Outcomes/);
  assert.match(rendered.body, /\| Send recap deck \| Josh \| 2026-03-12 \|/);
  assert.match(rendered.body, /## Decisions/);
  assert.match(rendered.body, /- Proceed with the next milestone/);
  assert.match(rendered.body, /## Deal-State Changes/);
});

test("renderMeetingNote falls back cleanly for sparse rows and escapes table cells", () => {
  const rendered = renderMeetingNote(
    {
      fireflies_transcript_id: "ff_sparse",
      title: "Ukon | Pipeline Check",
      date: null,
      host_name: "Josh",
      participants: ["josh@clearworks.ai", "ops@ukon.com"],
      summary_action_items: "Fix prod | staging mismatch",
      action_items: [],
      decision_items: [],
    },
    { runDate: "2026-07-30" },
  );

  assert.equal(rendered.filename, "1970-01-01-ukon-pipeline-check.md");
  assert.match(rendered.body, /- none/);
  assert.match(rendered.body, /\| Fix prod \/ staging mismatch \|  \|  \|/);
  assert.match(rendered.body, /\| \*\*Processed:\*\* yes/);
});
