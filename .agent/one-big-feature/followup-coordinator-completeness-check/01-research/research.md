# Research — followup-coordinator recap email completeness

## Trigger
Josh spot-checked 3 P2 Wave-0 draft artifacts (task_1785607558365_21141751, client Alloi/Marcos).
Feedback: the drafted recap email (followup-2026-07-29.md) omitted "add Josh to the Slack test
channel" from the "What we need from you" section, even though it was correctly captured as a row
in the THEIR-COMMITMENTS tracker table in the same file.

## Root cause investigation
Read `orgs/clearworksai/skills/followup-coordinator/SKILL.md` Step 3 (draft rules, line ~110-127).
The only completeness rule present was: "No item appears in the email that isn't in the tracker."
This is a one-directional guard (prevents invented items) — nothing enforced the reverse direction
(every tracker item must survive into the email). The draft-writing instruction also told the
drafting step to "write the recap in the company voice" from the call generally, rather than
walking the OUR/THEIR-COMMITMENTS tables row by row — which invites a freeform narrative summary
that can silently drop a row.

## Fix scope
Two changes to the same skill file, same root cause chain:
1. Change the draft-construction instruction (Step 3, "What we're doing" / "What we need from you"
   bullets) to require building each section by walking the corresponding commitments table row by
   row, rather than summarizing from memory of the call. This addresses the generation-time cause.
2. Add an explicit bidirectional completeness check as a post-draft safety net: count tracker rows
   per side, count email bullets per section, confirm 1:1. Catches any remaining drop even if the
   row-by-row construction fails for some reason.

## Out of scope
- Task-table formatting ("loosey goosey" per Josh) — explicitly deferred, Josh: "leave the tasks for
  now ill work with them live" / "dont change yet."
- Re-running the extraction pipeline for other clients/meetings — this fix changes future runs only.
