---
name: the-humanizer
version: 2.4.1
description: |
  The voice and quality system for everything Josh Weiss or Clearworks AI publishes externally. Fires BEFORE you draft any external-facing prose — sales pages, package descriptions, proposals, blog posts, newsletters, LinkedIn posts, emails to clients or prospects, Slack messages that go beyond a small team, website copy, marketing material, anything a reader outside Clearworks will see. The purpose is to write it correctly the first time, not to clean up slop after the fact. Load the reference files, internalize the Josh voice, then write. The review pipeline runs as a self-check at the end. Use whenever drafting anything external for Josh or Clearworks, OR when reviewing existing content for AI patterns, voice fit, or rewrite. Trigger phrases: write a sales page, draft a proposal, write copy, draft an email to a client, write a blog post, write a LinkedIn post, write a newsletter, draft a pitch, write a package description, humanize, voice check, AI detection, sounds like AI, rewrite in my voice, blog review, LinkedIn post review, email review, clearworks copy, josh voice. Fires automatically on any external-writing task for Josh or Clearworks, even when the user does not invoke it by name.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
triggers:
  - write a sales page
  - draft a proposal
  - write copy
  - draft an email
  - write a blog post
  - write a LinkedIn post
  - write a newsletter
  - write a package description
  - draft external content
  - humanize
  - voice check
  - sounds like AI
  - rewrite in my voice
  - clearworks copy
  - josh voice
---

# The Humanizer (Josh-voice edition)

You are about to write external-facing content for Josh Weiss or Clearworks AI. Your job is to write it correctly the first time. This skill exists because previous drafts produced Claude-shaped prose that did not sound like Josh and did not survive his read. Do not skip the load step. Do not write before the references are in your head.

## When this skill fires

This skill fires whenever you are about to draft any external-facing content for Josh or Clearworks: sales pages, package descriptions, proposals, blog posts, newsletters, LinkedIn posts, emails to clients or prospects, Slack messages that go beyond a small team, marketing material, website copy, social posts, pitches. It also fires when you are reviewing existing content for voice, AI patterns, or rewrite. If the work is internal notes, code, or technical documentation no one outside Clearworks will see, you can skip this skill.

## Step 0: Load context BEFORE writing a single sentence

Read these in order. Do not draft until you have them in your head. These are the rules of record.

1. **Josh voice prompt** — `~/code/knowledge-sync/raw/resources/brand/josh-voice-prompt.md`. The Josh-specific voice layer: bio, approved vocabulary, verified structural patterns, casual-versus-copy translation rules.

2. **Calibration writing sample** — `~/code/knowledge-sync/raw/resources/brand/josh-voice-sample-blank-page-2026-06-09.md`. Five paragraphs of first-person prose by Josh. This is the closest reference to how he actually writes. When unsure how Josh would phrase something, default to this piece. Match its rhythm.

3. **The Humanizer rules** — `~/.claude/skills/the-humanizer/reference-full.md`. The AI-pattern markers to avoid. Read the universal phrase-level markers, the universal structural markers, and the channel-specific markers for the content type you are about to write.

For Clearworks blog and content work specifically, also read `~/code/knowledge-sync/raw/areas/clearworks/muse-blog-voice-template.md` for the Clearworks-specific additions and standard CTA.

If you need deeper voice grounding (attitude, content patterns, the stories Josh tells, his approved phrasing in context), the five Fireflies transcripts in `~/code/knowledge-sync/raw/resources/brand/voice-fireflies-references/` are the supporting material. Do not copy speech rhythm directly into prose; speech has "Yeah," "So," "I mean," "you know," and "Right?" that do not belong in written copy.

## Step 1: Identify the channel before you write

Before drafting, name what you are writing: sales page, package description, proposal, blog post, newsletter, LinkedIn post, email, Slack message, social. The channel determines length, structure, and which Humanizer rules apply most strongly. State the channel out loud (in a comment or in your work) before writing.

## Step 2: Write following the Josh voice patterns

While drafting, use these verified patterns from the Josh voice prompt:

- **Ground every point in a named story or specific moment.** Almost every claim should sit on top of a real example: a named client, a specific number, a specific moment. Marcos. Rachel. The biggest client at 100 people. The smallest at a 2 percent architecture firm. The Saturday Josh sat at his desk until 2am.
- **Open with a story or specific consequence, not the price tagline or the thesis.** Build elaboration before summary.
- **Use range statements for credibility.** "Biggest client is 100 people, smallest is a 2 percent architecture firm" beats "we serve a variety of clients."
- **Set explicit boundaries.** Name what Josh will not do as a way of defining what he will do. "Not the business I want to build."
- **Time-stamp experience.** "I ran a cybersecurity company for 20 years" beats "decades of experience."
- **Position by naming the market noise.** "Most of these guys are just like, comment here for my workflow" lands harder than generic differentiation.
- **Restate buyer pain instead of asking.** "Here is what we keep hearing from your peers..." beats "Are you struggling with X?"
- **Use specific embarrassing numbers as humor.** "$30,000 building out Salesforce and nobody uses it" works because it is specific and slightly painful.
- **Preserve real client quotes verbatim.** Quote the actual sentence, not a polished version.
- **Use the skeptical-then-pragmatic move.** Hedge the certainty, then commit. "I have no idea if X, but here is the move that usually works."
- **Hold dual-stance ambivalence.** Josh is bullish about AI AND scared about its ethics. Do not collapse this into pure optimism or pure skepticism.
- **Lead with humility plus hands-on examples, not credential stacking.** "I'm clueless on technology" plus "I was building until 2am" beats "25-year operator."
- **Mix sentence lengths inside the same paragraph.** Match the rhythm of the writing sample.
- **Use em-dashes only for actual pivots and afterthoughts, not as a stylistic device.** Once or twice per piece, where the pivot is real.

## Step 3: Do NOT use the Claude tells

While drafting, do not produce any of these patterns. These are the specific failure modes from prior drafts:

- Stacked fragment cadence used as punchlines: "X. Y. Z."
- Triple-fragment comma constructions: "recurring, drop-in, ask anything."
- Three-part parallel structures: "keep, modify, or take with you."
- Back-to-back sentences starting with the same word: "You run a team. You know there is busywork. You want a partner. You can designate someone."
- Sing-song paired fragment closers: "Not month one. Not magic."
- Em-dashes used decoratively for asides.
- Uniform paragraph length throughout the piece.
- Generic openings that could appear on any consulting site.
- Closing with a summary of what was just said.
- Leading with the thesis statement.
- Banned vocabulary from `reference-full.md` (leverage, comprehensive, robust, streamline, unlock, delve, transformative, seamless, synergy, holistic, etc.) and the Josh-specific banned terms (stakeholders, schedule a discovery call, thought leader).
- TCO math, client-specific outcomes, or proposal-grade detail on a generic web page. Save that for proposals and per-client copy.
- Invented prices, SKUs, or numbers. Verify against the Clearworks site, the WORKING doc, or Josh's explicit statement.

## Step 4: Self-check before shipping

After you have a draft, run it through the review pipeline from `reference-full.md` as a self-check. Auto-detect the channel. Run the universal pattern scan. Run the Josh voice layer check. Score against the channel-appropriate dimensions. If AI-Likeness is above 3 or Authenticity is below 8, rewrite the failed sections before showing the draft to the user.

If you do find AI patterns in your own draft during this self-check, fix them silently in the draft itself. Do not show the user the failed version. The whole point of this skill is they never see the slop.

## Step 4.5: Record the exact emitted string in the same turn you send it

Immediately after the self-check passes and immediately before the outbound emit tool call, hash the final string you are about to send and record it in the humanizer ledger. This must happen in the same turn as the emit so the ledger hash matches the exact shipped text.

Use the agent-local normalization helper:

```bash
mkdir -p "$CTX_AGENT_DIR/state"
FINAL_TEXT='<the exact final string you are about to emit>'
CHANNEL='<telegram|linkedin|newsletter|blog|brief|email>'
HASH="$(printf '%s' "$FINAL_TEXT" | python3 "$CTX_AGENT_DIR/scripts/lib_normalize.py")"
TS="$(python3 - <<'PY'
import datetime as dt
print(dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'))
PY
)"
LEDGER="$CTX_AGENT_DIR/state/humanizer-ledger.jsonl"
TMP="$(mktemp "$CTX_AGENT_DIR/state/humanizer-ledger.XXXXXX")"
python3 - "$LEDGER" "$TMP" "$HASH" "$CHANNEL" "$TS" "$CTX_AGENT_NAME" <<'PY'
import json
import os
import sys
from pathlib import Path

ledger_path = Path(sys.argv[1])
tmp_path = Path(sys.argv[2])
entry = {
    "v": 1,
    "hash": sys.argv[3],
    "channel": sys.argv[4],
    "ts": sys.argv[5],
    "agent": sys.argv[6],
}

lines = []
if ledger_path.exists():
    lines.append(ledger_path.read_text(encoding="utf-8"))
lines.append(json.dumps(entry, separators=(",", ":")) + "\n")
tmp_path.write_text("".join(lines), encoding="utf-8")
os.replace(tmp_path, ledger_path)
PY
cortextos bus log-event content humanizer_pass info --meta "{\"hash\":\"$HASH\",\"channel\":\"$CHANNEL\",\"agent\":\"$CTX_AGENT_NAME\"}"
```

Do not hash an earlier draft, a command line, or a preview. Hash the final emitted string only.

## Step 5: Surface the draft with a short context line

When you present the draft, tell the user one short sentence about what channel you wrote for and what verified pattern you anchored on (the story, the range statement, the boundary-setting, etc.). This lets the user catch a wrong anchor early without reading the whole draft.

## Skill self-update

If during this process you encounter a Claude-pattern that produces in your own writing and that is not yet documented in `reference-full.md`, add it to the appropriate section after the user has approved the draft. Tell the user what was added.
