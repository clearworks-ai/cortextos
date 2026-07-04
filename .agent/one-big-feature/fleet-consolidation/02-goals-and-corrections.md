# Josh's goals + authoritative corrections (obey these)

## The two co-equal end goals
1. **ONE reliable repo / one version of everything.** Kill the "two systems of record, one truth, no reconciliation → silent divergence" pattern.
2. **A reliable REMOTE manager** Josh drives from his phone: read documents, get/manage tasks, interact with the fleet — reliably. He is rarely at his computer. This is why he uses the briefs dashboard and wants the wiki online.

## Corrections from this session (authoritative — a prior analysis pass FAILED by violating these)
- **Transcripts outrank merged PRs.** Do NOT assume old one-big-feature folders / PRs (some ~3 weeks old, merged BEFORE he reported these issues) mean a lived issue is fixed. He had wrong tasks in briefs AGAIN this morning. Certainty problems are NOT solved.
- **Identity = ONE place, not a resolution/sync layer** between namespaces.
- **Decide WHICH knowledge-sync and WHICH RAG** to use — one each, not many.
- **CRM is one issue among many**, not the headline.
- **Clearpath: Josh already decided to move OFF it.** In the transcripts (Jun 27–28) he says it's old/stale and they moved to the current stack; his steer is *converge to upstream-native MMRAG + knowledge-sync unless there's a proven reason to diverge.* Do NOT recommend Clearpath as system-of-record.
- **Give RECOMMENDATIONS with RISKS, not a quiz of decisions.**

## New charter items Josh added for Fable to think through (this turn)
1. **The wiki / RAG / knowledge-sync as ONE reliable knowledge system:** reliable storage to an organized location, retrievable, indexed. Decide the single stack and how capture → store → index → retrieve works end to end so nothing is lost or unfindable.
2. **Scaffolding / context BLOAT.** The bloat that was hurting Larry has been *largely removed already* — build on that, don't re-add it. Specifically address the large memory file fed to EVERY agent (the ~391-line / ~62.8KB MEMORY.md) and heavy per-message injection. Memory must be durable but lean.
3. **Keep agents NIMBLE and ACCURATE** as the general principle: minimum viable scaffolding, verify-before-claim as a mechanism (not willpower), durable rules/memory that survive a restart, and handoffs that don't drop the live tail.
4. **Converge to upstream** (grandamenium/cortextos) unless there's a proven reason to diverge — bias toward less custom scaffolding.
