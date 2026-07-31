# Clearpath Meeting Dump

One-time Clearpath backfill script. This does **not** enable a recurring sync.

## Install

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/scripts/clearpath-dump
npm install
```

## Run

Dry-run first, always:

```bash
cd /Users/joshweiss/code/clearpath
railway link
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/scripts/clearpath-dump
railway run -- node dump-meetings.mjs
```

If the count/sample output looks correct:

```bash
railway run -- node dump-meetings.mjs --commit
```

If Railway reports multiple org ids, rerun with `--org <id>`.

## Behavior

- Reads `fireflies_meetings` from the linked Clearpath production database.
- Dry-run writes rendered markdown into `out-dryrun/`.
- Commit mode writes into `orgs/clearworksai/knowledge/meetings/`.
- Dedups on the `fireflies:<transcriptId>` token already present in meeting notes.
- Filename collisions never overwrite an existing note; they suffix `-2`, `-3`, and so on.

## Rollback

Backfilled notes are marked with `clearpath-backfill:2026-07-30` in the `**Source:**` line. To remove them:

```bash
grep -rl "clearpath-backfill:2026-07-30" /Users/joshweiss/code/cortextos/orgs/clearworksai/knowledge/meetings
```

Delete that exact set in a revert commit or follow-up cleanup once reviewed.
