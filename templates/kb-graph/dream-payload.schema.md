# Dream payload contract (synthesis subagent → kb-dream-file)

The synthesis child returns JSON only. It NEVER writes FS or DB.
Orchestrator files via `cortextos bus kb-dream-file <jobKey> --payload <file>`.

```json
{
  "entities": [
    { "name": "Josh", "type": "people", "summary": "optional" }
  ],
  "edges": [
    { "from": "Josh", "to": "Clearworks", "type": "works_at", "context": "optional 240-char" }
  ],
  "pages": [
    {
      "slug_hint": "people/josh-weiss",
      "title": "Josh Weiss",
      "markdown": "# Josh Weiss\n\nBody..."
    }
  ]
}
```

Allowed edge types: `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `relates_to`.
Page slug dirs must be on-disk wiki top-level dirs (or `intelligence`).
