# kb-query vs NotebookLM — when to use which

- **kb-query** (`cortextos bus kb-query`) = default for **factual lookup against existing
  knowledge**: "what did we agree with X", client state, past decisions, meeting/CRM recall. Live,
  indexed nightly, agent-invocable in-loop (and auto-fires via hook-retrieval-enforcer), returns
  source file paths to Read. If the answer should exist in `knowledge/` or the vault, kb-query first.
- **NotebookLM** = **on-demand synthesis ARTIFACTS from a bounded source set**: podcast/audio
  overviews, quizzes/flashcards, briefing reports, mind maps, deep web research imports.
  Minutes-long generation, rate-limited, produces a deliverable — never the in-loop recall path.
- **Rule of thumb:** retrieving a fact you already have → kb-query. Producing a new derived artifact
  (something Josh listens to/reads/shares) from a corpus → NotebookLM. Never stand up a NotebookLM
  notebook to answer a question kb-query answers in one call; never ship raw kb-query chunks as a
  deliverable.
