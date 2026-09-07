# cortextOS fleet adapter

This adapter preserves the upstream Task Observer methodology and CC BY 4.0
attribution while making persistence safe for a concurrent multi-agent fleet.

## Canonical paths

Bundle discovery and state persistence are separate inputs. A runtime
`$CTX_ROOT` may contain only mutable state and must not be assumed to contain
the installed skill source.

- Skill bundle: `$TASK_OBSERVER_BUNDLE` (the verified directory containing
  this `SKILL.md` and `scripts/cortextos_observe.py`)
- State root: `${CTX_TASK_OBSERVER_STATE_ROOT:-$CTX_ROOT}`
- Fleet state: `<state-root>/state/task-observer-v1/`
- Agent partition: `partitions/<org>/<agent>/observations.jsonl`
- Reviews: `reviews/`
- Staged skill proposals: `skill-updates/YYYY-MM-DD/<skill>/`

Never put client observations into a shared unpartitioned log. The org and agent
partition are mandatory. Records carry a `visibility` of `internal` or
`open_source`; open-source records must contain only a generalized principle.

## Activation

At every substantive session start, run:

```bash
: "${TASK_OBSERVER_BUNDLE:?set TASK_OBSERVER_BUNDLE to the verified installed task-observer bundle}"
TASK_OBSERVER_STATE_ROOT="${CTX_TASK_OBSERVER_STATE_ROOT:-$CTX_ROOT}"
test -f "$TASK_OBSERVER_BUNDLE/scripts/cortextos_observe.py"
python3 "$TASK_OBSERVER_BUNDLE/scripts/cortextos_observe.py" init \
  --root "$TASK_OBSERVER_STATE_ROOT" --org "$CTX_ORG" --agent "$CTX_AGENT_NAME"
```

Fail closed when either path is missing or unverified. Do not silently search
arbitrary parent directories: the executable bundle controls code provenance,
while the state root controls confidentiality and durability.

At task completion, user correction, material blocker, or deliverable handoff,
append an observation using the same tool. The writer locks the target partition,
allocates a monotonic sequence, appends one fsynced JSON line, and verifies it.

Reviews read partitions but never merge their confidential content. Any proposed
skill change is staged as the complete bundle with a manifest and diff; reviews
do not edit installed skills.

## Pre-flight

Before claiming activation, verify: the bundle script exists beneath the exact
declared bundle root; the state root resolves to the intended persistence
namespace; any activation symlink resolves to this bundle; `init` returns `ok`;
the partition exists with mode 0700/0600; two concurrent appends produce
distinct sequence numbers; and a fresh process can read both records.
