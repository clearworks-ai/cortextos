# cortextOS fleet adapter

This adapter preserves the upstream Task Observer methodology and CC BY 4.0
attribution while making persistence safe for a concurrent multi-agent fleet.

## Canonical paths

- Skill bundle: `$CTX_ROOT/community/skills/task-observer/`
- Fleet state: `$CTX_ROOT/state/task-observer-v1/`
- Agent partition: `partitions/<org>/<agent>/observations.jsonl`
- Reviews: `reviews/`
- Staged skill proposals: `skill-updates/YYYY-MM-DD/<skill>/`

Never put client observations into a shared unpartitioned log. The org and agent
partition are mandatory. Records carry a `visibility` of `internal` or
`open_source`; open-source records must contain only a generalized principle.

## Activation

At every substantive session start, run:

```bash
python3 "$CTX_ROOT/community/skills/task-observer/scripts/cortextos_observe.py" init \
  --root "$CTX_ROOT" --org "$CTX_ORG" --agent "$CTX_AGENT_NAME"
```

At task completion, user correction, material blocker, or deliverable handoff,
append an observation using the same tool. The writer locks the target partition,
allocates a monotonic sequence, appends one fsynced JSON line, and verifies it.

Reviews read partitions but never merge their confidential content. Any proposed
skill change is staged as the complete bundle with a manifest and diff; reviews
do not edit installed skills.

## Pre-flight

Before claiming activation, verify: the symlink resolves to this bundle; `init`
returns `ok`; the partition exists with mode 0700/0600; two concurrent appends
produce distinct sequence numbers; and a fresh process can read both records.
