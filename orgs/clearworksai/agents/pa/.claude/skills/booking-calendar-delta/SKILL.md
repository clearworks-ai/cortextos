# Booking Calendar Delta Worker

<!-- EVENT LANE NOTE (FR-E3, Calendar activation):
     This worker is the PRIMARY reaction to a live Google Calendar change push.
     The provider event lane (calendar-watch) spawns it on every non-`sync`
     calendar notification. The frank2 pre-meeting-brief-page */15 poll remains
     as a missed-event safety-net sweep until FR-C1 retires it. The shared
     event-dedup ledger keyed on the calendar event id makes double-fire
     harmless — whichever trigger reconciles a given event first wins.
-->

You are a SHORT-LIVED WORKER SESSION. Your only job is to reconcile recent calendar changes and file pre-meeting prep. Complete it and stop.

DO NOT:
- Read IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, or any bootstrap files
- Update heartbeat
- Write to daily memory
- Send "OK" confirmations or progress narration to anyone
- Insert, move, or cancel any calendar event (this worker is read + prep only)

DO:
- Snapshot the current agenda, diff it against the prior snapshot (deterministic core)
- For genuinely new/moved meetings, file pre-meeting prep — once per event
- Output DONE when complete

---

## Step 1 — Task setup (Bash, run first)

```bash
cd "$CTX_AGENT_DIR"
TASK_ID=$(cortextos bus create-task "Calendar delta reconcile" --desc "Event-lane: reconcile calendar changes, file pre-meeting prep" --assignee "${CTX_PARENT_AGENT:-pa}" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
mkdir -p state
```

---

## Step 2 — Snapshot + deterministic delta (the core)

The diff is DETERMINISTIC and upstream of any judgment: `booking_coordinator.py calendar-delta`
compares the fresh agenda against the last snapshot and returns `{booked, moved, cancelled}` keyed
on the calendar event id. You only reason about the handful of deltas it emits — never the whole agenda.

```bash
cd "$CTX_AGENT_DIR"
SNAP=state/calendar-agenda-snapshot.json
# Fresh agenda snapshot (next 14 days). If the pull fails, emit an empty set so the
# worker degrades to a no-op rather than a spurious "everything cancelled" delta.
gws calendar +agenda --days 14 --format json > /tmp/cal-new.json 2>/dev/null || echo '{"events":[]}' > /tmp/cal-new.json
# Guard: a fetch that returned zero events is treated as "no signal", NOT as a mass
# cancellation — skip the diff so an API hiccup can never fabricate cancelled rows.
NEW_COUNT=$(python3 -c "import json;d=json.load(open('/tmp/cal-new.json'));print(len(d.get('events',d if isinstance(d,list) else [])))" 2>/dev/null || echo 0)
if [ "$NEW_COUNT" -eq 0 ] && [ -s "$SNAP" ]; then
  echo '{"booked":[],"moved":[],"cancelled":[]}' > /tmp/cal-delta.json
else
  python3 scripts/booking_coordinator.py calendar-delta --new /tmp/cal-new.json --prior "$SNAP" > /tmp/cal-delta.json 2>/dev/null || echo '{"booked":[],"moved":[],"cancelled":[]}' > /tmp/cal-delta.json
fi
cat /tmp/cal-delta.json
# Persist the fresh snapshot as the new prior (atomic), only when it has real signal.
if [ "$NEW_COUNT" -gt 0 ]; then
  python3 - "$SNAP" /tmp/cal-new.json <<'PY'
import json,sys,os,tempfile
snap,new=sys.argv[1],sys.argv[2]
d=json.load(open(new)); events=d.get("events",d if isinstance(d,list) else [])
fd,tmp=tempfile.mkstemp(dir="state",prefix=".cal-snap.",suffix=".tmp")
os.write(fd,json.dumps({"events":events}).encode()); os.close(fd); os.replace(tmp,snap)
print(f"snapshot_events={len(events)}")
PY
fi
```

---

## Step 3 — File prep for new / moved meetings (dedup-gated, once per event)

For each event in `booked` and `moved`, gate on the event id so a re-fire (or the poll
backstop) never double-files. Only file prep for meetings that actually need it — real
external meetings, not internal holds or all-day blocks.

```bash
python3 - <<'PY'
import json,subprocess,os
delta=json.load(open('/tmp/cal-delta.json'))
agent_dir=os.environ.get("CTX_AGENT_DIR",".")
def needs_prep(ev):
    # skip all-day blocks and obvious internal holds
    start=ev.get("start") or {}
    if isinstance(start,dict) and start.get("date") and not start.get("dateTime"):
        return False
    attendees=ev.get("attendees") or []
    external=[a for a in attendees if not str(a.get("email","")).endswith("@clearworks.ai")]
    return bool(external)
todo=[]
for ev in delta.get("booked",[]) + [m for m in delta.get("moved",[])]:
    eid=str(ev.get("id") or ev.get("eventId") or "")
    if not eid: continue
    # only booked rows carry full event bodies; moved rows are {id,from,to}
    if "summary" in ev and not needs_prep(ev): continue
    gate=subprocess.run(["cortextos","bus","event-dedup","--source",f"calendar:{eid}","--fire-once"],capture_output=True,text=True)
    if gate.returncode==0:
        todo.append(eid)
print(json.dumps({"prep_event_ids":todo}))
open('/tmp/cal-prep.json','w').write(json.dumps({"prep_event_ids":todo}))
PY
cat /tmp/cal-prep.json
```

If `prep_event_ids` is non-empty, spawn the pre-meeting-brief worker to build the briefs (it owns
the actual prep-page generation; this worker only decides WHICH events are new and need it):

```bash
NEED=$(python3 -c "import json;print(len(json.load(open('/tmp/cal-prep.json')).get('prep_event_ids',[])))" 2>/dev/null || echo 0)
if [ "$NEED" -gt 0 ]; then
  cortextos spawn-worker "pre-meeting-brief-$(date +%s)" --dir "$CTX_AGENT_DIR" --parent pa --prompt "Read .claude/skills/pre-meeting-brief-page-worker/SKILL.md and execute it for the meetings in /tmp/cal-prep.json (prep_event_ids). Build the pre-meeting brief page for each. Output DONE." 2>&1 || echo "prep spawn failed"
fi
```

Cancelled meetings need no action here — the pre-meeting-brief worker's own staleness check drops
briefs for events that no longer exist. Do NOT Telegram Josh about routine calendar churn.

---

## Step 4 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Calendar delta reconcile complete"
cortextos bus log-event action cron_completed info --meta '{"cron":"booking-calendar-delta","agent":"pa"}'
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
