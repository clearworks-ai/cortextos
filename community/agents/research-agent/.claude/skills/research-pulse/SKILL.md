---
name: research-pulse
description: Stand up and maintain "research pulse" coverage for an industry vertical — discover podcast/YouTube/indicator sources, tag them with the 7-facet taxonomy, seed a NotebookLM notebook, generate an indicator-framework doc, and register the vertical for delta monitoring. Triggers on "add a research pulse for <industry>", "stand up <industry> coverage", "new vertical pulse".
---

# research-pulse

Run from:

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.claude/skills/research-pulse
```

## Step 0 — Preflight

```bash
set -a
source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.env
set +a
NOTEBOOKLM_BIN=${NOTEBOOKLM_BIN:-/tmp/whisper-venv/bin/notebooklm}
"$NOTEBOOKLM_BIN" status
```

If `status` fails, stop and report:
- reinstall: `pip install notebooklm-py` into a durable venv
- auth repair: `notebooklm login`

Before continuing, note whether these vars are set:
- `PODCASTINDEX_API_KEY`
- `PODCASTINDEX_API_SECRET`
- `YOUTUBE_API_KEY`

Proceed degraded if one or more are missing, and include that in the final report.

## Step 1 — Define (industry + framing)

Gather:
- display name
- 1-3 sentence framing: what decisions this pulse should inform, and who consumes it

Build the vertical slug from the skill dir:

```bash
SLUG=$(python3 -c "from scripts.pulse_registry import slugify; print(slugify('<name>'))")
```

If `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse/registry/$SLUG.json` already exists, switch to maintenance mode and add sources to the existing vertical instead of recreating it.

Write 2-4 search queries that combine the industry with practitioner language. Examples:
- `nonprofit operations`
- `nonprofit fundraising strategy`
- `nonprofit executive leadership`

## Step 2 — Discover

```bash
python3 scripts/discover.py --vertical "$SLUG" \
  --query "nonprofit operations" \
  --query "nonprofit fundraising strategy" \
  --podcasts 15 \
  --channels 10 \
  --out "/tmp/pulse-candidates-$SLUG.json"
```

Review `/tmp/pulse-candidates-$SLUG.json` before curation.

## Step 3 — Curate + document (tag taxonomy)

Target 10-20 sources:
- mix podcasts and YouTube channels
- include 3-5 indicator/data sites
- drop off-topic or low-signal candidates

Assign the controlled vocabulary from `scripts/pulse_registry.py`:
- `source_type`: `podcast | youtube | article | data_feed | report`
- `topic`: base vocab `indicators | strategy | operations | regulation | innovation`
- `signal`: `leading | coincident | lagging | sentiment | macro | micro`
- `authority`: `academic | industry_expert | practitioner | news | vendor`
- `cadence`: `daily | weekly | monthly | quarterly | ad_hoc`
- `quality`: `high | medium | emerging | archival`

Add vertical-specific topics through `topic_vocab_extra`.

Write the registry with this inline snippet:

```bash
python3 - <<'PY'
from scripts import pulse_registry

vertical = "<slug>"
display_name = "<Display Name>"
framing = """<1-3 sentence framing>"""
topic_vocab_extra = ["fundraising", "governance"]
curated_sources = [
    {
        "source_name": "Example Source",
        "url": "https://example.com",
        "feed_url": "https://example.com/feed.xml",
        "source_type": "podcast",
        "industry": [vertical],
        "tags": {
            "topic": ["operations"],
            "signal": ["leading"],
            "authority": "industry_expert",
            "cadence": "weekly",
            "quality": "high",
        },
    },
]

try:
    registry = pulse_registry.load_registry(vertical)
except FileNotFoundError:
    registry = pulse_registry.new_registry(vertical, display_name, framing)

registry["display_name"] = display_name
registry["framing"] = framing
registry["topic_vocab_extra"] = topic_vocab_extra

for entry in curated_sources:
    try:
        pulse_registry.add_source(
            registry,
            source_name=entry["source_name"],
            url=entry["url"],
            feed_url=entry.get("feed_url"),
            source_type=entry["source_type"],
            tags=entry["tags"],
            industry=entry.get("industry"),
        )
    except ValueError as exc:
        if "duplicate url" not in str(exc):
            raise

path = pulse_registry.save_registry(registry)
print(path)
PY
```

## Step 4 — Seed NotebookLM

Create a notebook when the vertical has none yet:

```bash
python3 scripts/seed_notebook.py --vertical "$SLUG" --create \
  --title "Research Pulse: <Display Name>"
```

If the vertical already has a notebook id, omit `--create`:

```bash
python3 scripts/seed_notebook.py --vertical "$SLUG"
```

Interpret exits as:
- `0`: all planned sources seeded or already present
- `1`: partial failure; list failed sources in the final report, but keep going
- `2`: preflight or cap refusal; stop and report the blocking issue

## Step 5 — Indicator-framework doc

Template:

```bash
cp /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.claude/skills/research-pulse/templates/indicator-framework-template.md \
  "$HOME/code/knowledge-sync/raw/areas/clearworks/research/$SLUG-indicator-framework-$(date +%F).md"
```

Use the seeded notebook to answer these four canonical questions:

```bash
"$NOTEBOOKLM_BIN" ask "What 8-12 recurring indicator topics show up across these sources? Group them under 2-4 category headings and explain why each matters." --notebook "<notebook_id>" --new
"$NOTEBOOKLM_BIN" ask "For each source, what is its primary focus and what tag taxonomy best describes it?" --notebook "<notebook_id>"
"$NOTEBOOKLM_BIN" ask "Which signals in this source set are leading, coincident, or lagging? Explain why and cite the source and cadence." --notebook "<notebook_id>"
"$NOTEBOOKLM_BIN" ask "What 3-5 cross-source synthesis domains emerge when these sources are analyzed together?" --notebook "<notebook_id>"
```

Also carry forward the curated indicator/data sites, including relevant FRED/BLS/Census series ids when they genuinely fit the vertical.

After writing the framework doc, store the absolute path in the registry:

```bash
python3 - <<'PY'
from scripts import pulse_registry

vertical = "<slug>"
framework_doc = "/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/research/<slug>-indicator-framework-<YYYY-MM-DD>.md"
registry = pulse_registry.load_registry(vertical)
registry["framework_doc"] = framework_doc
pulse_registry.save_registry(registry)
print(framework_doc)
PY
```

## Step 6 — Register + snapshot

```bash
python3 -c "from scripts.pulse_registry import load_registry, write_pulse_snapshot; write_pulse_snapshot(load_registry('$SLUG'))"
```

Any registry file under `state/research-pulse/registry/` is automatically eligible for the later delta cron. No per-vertical cron edit is needed.

## Step 7 — Report

Final report must include:
- vertical slug + display name
- source count by type
- notebook id + link: `https://notebooklm.google.com/notebook/<id>`
- framework doc path
- degraded providers
- failed seeds

Do not send Telegram from this skill. The caller decides how to surface the result.

