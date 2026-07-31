This cron is not installed automatically. Josh installs it manually into his `crons.json` only after a clean manual round-trip: `cortextos bus multica-sync --dry-run`, then `cortextos bus multica-sync --direction out`, then `cortextos bus multica-sync --direction in`.

```json
{
  "name": "multica-sync",
  "prompt": "cortextos bus update-cron-fire multica-sync --interval 10m 2>/dev/null; SILENT-OK sync: run exactly this one bash command and nothing else, then respond OK (no Telegram, no other work): cortextos bus multica-sync --direction both",
  "schedule": "10m",
  "enabled": true,
  "description": "Two-way sync between cortextOS bus tasks and Multica issues (push open tasks, poll status/assignee changes back)"
}
```

- Secrets installed
- Dry-run inspected
- `--direction out` confirmed in Multica UI
- `--direction in` confirmed
- Cron installed at `10m` interval
- One day watched for loop-thrash via `agent_activity` events and `cron-execution.log`
