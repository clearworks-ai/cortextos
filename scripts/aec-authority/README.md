# Gemini grounded baseline runner

Runs each frozen AEC authority prompt as a separate Gemini GenerateContent API request with the official `google_search` tool. It writes one redacted raw receipt per prompt and an atomically updated manifest so partial runs remain auditable.

The implementation follows Google's official [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/generate-content/google-search) and [GenerateContent API](https://ai.google.dev/api/generate-content) documentation. The API key is read only from `GEMINI_API_KEY`, sent in the `x-goog-api-key` header, and never included in the request receipt.

```bash
python3 scripts/aec-authority/gemini_baseline.py \
  --prompt-file orgs/clearworksai/agents/knox-codex/outputs/growth/aec-authority-system-2026-09-25/prompt-baseline-v1.md \
  --output-dir orgs/clearworksai/agents/knox-codex/outputs/growth/aec-authority-system-2026-09-25/gemini-baseline \
  --run-id gemini-api-google-search-20260925-r1 \
  --seed 20260925
```

The default model is `gemini-2.5-flash`. The runner changes to `gemini-3.8-flash` only if the live API explicitly rejects the requested model and records the original HTTP status and exact API reason in `manifest.json`.

Run the standard-library-only tests with:

```bash
python3 -m unittest discover -s scripts/aec-authority/tests -v
```
