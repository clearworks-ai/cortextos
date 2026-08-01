---
name: knowledge-base
description: "A company knowledge base is the single place your AI agents read from and write to. It is not software you buy · it is a set of plain-text files with a strict convention, living next to your work. Every other job on the SkillTree map gets dramatically better the day this exists, because an agent with context writes like a colleague and an agent without context writes like a stranger. Use when working on: Company Knowledge Base, Context Maintenance."
---

# Company Knowledge Base · Brain

**Category:** Foundation
**Version:** 1.0
**Part of:** SkillTree · altari.ai/skilltree

> Every AI department starts at the same node. This skill builds it.

## What This Is

A company knowledge base is the single place your AI agents read from and write to. It is not software you buy · it is a set of plain-text files with a strict convention, living next to your work. Every other job on the SkillTree map gets dramatically better the day this exists, because an agent with context writes like a colleague and an agent without context writes like a stranger.

This skill scaffolds the whole thing in one session: the file structure, the core files written by interviewing you, and the maintenance rules that keep it alive.

## Required API Keys

None. This runs on Claude's built-in capabilities. Your knowledge base is plain markdown · no database, no vendor, no lock-in.

## How to Run

Drop this file into your project (or `~/.claude/skills/` if you use Claude Code), then tell Claude:

- "Set up my knowledge base"
- "Run brain"
- "Build my company brain"

---

## Agent Instructions

> Everything below this line is what Claude follows when running this skill.

### Identity

You are setting up the foundational knowledge layer for the user's business. You are thorough but fast · this should take one session, not a week. You interview, you write, you confirm. The output is a set of files the user's future AI agents (and future sessions of you) will rely on as the source of truth.

### Step 1 · Scaffold

Create this structure in the project root (skip anything that already exists · never overwrite):

```
/knowledge
  company.md          # who the business is · the one-page truth
  offer.md            # what you sell, pricing logic, who it's for
  voice.md            # how the business writes and speaks
  /clients
    _template.md      # per-client context file template
  /meetings           # transcripts and call notes land here
  /playbooks          # how recurring work gets done
  stack.md            # the tools this business actually runs on
  STATE.md            # what's true right now · updated every session
```

### Step 2 · Interview

Ask the user these questions conversationally · in batches, not as a wall. Write each file as soon as you have enough. Do not invent facts; leave explicit `TODO:` markers for anything unknown.

**For `company.md`:**
1. What does the business do, in one sentence a customer would say?
2. Who runs it and what does each person own?
3. Current stage · revenue band, team size, what's working, what's the bottleneck?
4. What are the goals for the next 12 months, in numbers?

**For `offer.md`:**
5. What do you sell? Every product/service, with price or price range.
6. Who is the ideal buyer for each · and who do you say no to?
7. What's the typical deal flow from first contact to paid?

**For `voice.md`:**
8. Paste 2–3 pieces of writing that sound like you (emails, posts · anything).
9. What words or phrases do you never use? What tone do you refuse?

Derive the voice rules from their samples · sentence length, formality, openers, sign-offs · and write them as concrete rules ("never starts a message with 'I'"), not adjectives ("friendly but professional").

**For `offer.md` (operational facts · downstream skills depend on these):**
9b. What's your calendar/booking link? 9c. What's your website?
Write these into `offer.md` under `## Booking link` and `## Website` · the inbox and booking skills read them directly.

**For `stack.md`:**
10. What do you run on? CRM, email-sending tool, meeting notetaker, calendar, payment processor, support desk, social platforms · name them. Unknown or none is a fine answer.

Write `stack.md` as a simple category → tool table. This file is how every skill adapts to THIS business: a skill that says "push to your sending platform" reads stack.md to learn that means Instantly here and Smartlead somewhere else. Vendors named inside any skill file are defaults, not requirements.

**For `clients/_template.md`:**
Build a template with these sections: Contacts · Current state · What we're delivering · Financials · History (dated, newest first) · Open Items · a table with columns: Item · Owner · Deadline · Source · Status. Offer to fill it in for their top 3 active clients right now from whatever they paste · emails, notes, memory.

### Step 3 · Write STATE.md

The living file. Structure:

```
# STATE · updated YYYY-MM-DD

## Active work        (what's in flight, per client/project)
## Waiting on         (blocked items and who owes what)
## Decisions made     (dated · so context never re-litigates)
## Next priorities    (ranked, max 5)
```

Fill it from the interview. Tell the user: this file is the first thing any agent or session should read, and the last thing updated before any session ends.

### Step 4 · Install the Rules

Add a section to the project's CLAUDE.md (create it if missing) titled **Knowledge Base Rules**:

1. **Read before write.** Any session doing client or business work reads `knowledge/STATE.md` and the relevant `clients/*.md` first.
2. **Write after work.** Material changes (deal moved, decision made, deliverable shipped) get written back the same session · to the client file and STATE.md.
3. **One fact, one home.** Exact facts (prices, dates, statuses) live in exactly one file; everything else links to it.
4. **Dated history, newest first.** Never delete history · append above it.
5. **The stack file is law.** Skills use the tools `stack.md` names. When a tool changes, update one file and every skill follows.
6. **No orphan transcripts.** Every meeting transcript that lands in `/meetings` gets its outcomes extracted into the relevant client file within a day.

### Step 5 · Verify and Hand Off

Show the user the tree of what was created. Then prove it works: ask them for one real task they'd normally brief someone on (an email, a summary, a plan) and do it using only the knowledge base · no re-asking. The gap between what you produced and what they wanted is what's still missing from the files. Fix those gaps, then close with:

**"Your knowledge base is live. Every agent you deploy from here reads this first · that's what makes it yours and not generic. Keep STATE.md honest and the rest compounds."**

### Maintenance (tell the user)

- **Daily cost: ~zero.** The write-after-work rule does the maintenance as a side effect.
- **Weekly: 5 minutes.** Skim STATE.md, kill stale items.
- **The test:** if a smart stranger (human or AI) could read `/knowledge` and act for you tomorrow, it's working. If they'd have to ask you ten questions, the answers to those ten questions are your next edits.

---

*From SkillTree by Altari · the map of every AI job-to-be-done in a business. This file is brain: every department on the map builds on it.*
