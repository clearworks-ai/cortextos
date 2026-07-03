#!/usr/bin/env python3
"""intel_extractor.py — Clearpath 26-category intelligence extraction, in-house.

Ports the Clearpath meeting-intelligence extraction pipeline as a standalone
CLI so transcripts/docs can be mined locally into kb-ingest-shaped records:

  * CATEGORY_REGISTRY — mirrored from clearpath/shared/intelligence-categories.ts
    INTELLIGENCE_TYPE_REGISTRY (27 registered keys; the plan's "26-category"
    label refers to this registry).
  * MODEL_TIERS / route_model() — mirrored from the tier sets in
    clearpath/server/services/intelligence.ts (~L195-215): Sonnet for the five
    deep-reasoning keys, Gemini Flash for the mid tier, Gemini Flash-Lite for
    the budget tier, Haiku fallback for everything else. Every model id is
    overridable via env (INTEL_MODEL_SONNET, INTEL_MODEL_FLASH,
    INTEL_MODEL_FLASH_LITE, INTEL_MODEL_HAIKU).
  * PROMPTS — per-key extraction prompts ported as data from
    clearpath/server/services/default-prompts.ts.

Usage:
    python3 intel_extractor.py extract <transcript-or-doc path...> \
        --categories all|key,key --out <dir> [--json]

Output: one JSON record per extraction, one .intel.jsonl per source file in
--out, plus a markdown rendering per source file (suppressed with --json).
Record shape: {category, content, person, source_file, extracted_at, model}.

Client creation goes through injectable factories (mirrors the
MMRAG_GEMINI_CLIENT_FACTORY idiom in mmrag.py): set INTEL_GEMINI_CLIENT_FACTORY
/ INTEL_ANTHROPIC_CLIENT_FACTORY to a dotted import path of a callable
returning a client-shaped object, so tests never touch the network. The
google-genai / anthropic packages are lazily imported only inside the default
factories, so this module imports cleanly without them.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Category registry — mirrored from clearpath/shared/intelligence-categories.ts
# (key, label, display_category, description, primary_field, person_field).
# ---------------------------------------------------------------------------
CATEGORY_REGISTRY = [
    # --- Client Insights ---
    {"key": "objections", "label": "Objections", "display_category": "client_insights",
     "description": "Sales objections and resistance signals",
     "primary_field": "objection", "person_field": "speaker"},
    {"key": "desires", "label": "Desires", "display_category": "client_insights",
     "description": "What clients want and aspire to",
     "primary_field": "desire", "person_field": "speaker"},
    {"key": "problems_pains", "label": "Problems & Pains", "display_category": "client_insights",
     "description": "Client pain points and challenges",
     "primary_field": "problem", "person_field": "speaker"},
    {"key": "voice_of_customer", "label": "Voice of Customer", "display_category": "client_insights",
     "description": "Direct customer quotes and testimonials by motivation",
     "primary_field": "quote", "person_field": "speaker"},
    {"key": "client_wins", "label": "Client Wins", "display_category": "client_insights",
     "description": "Achievements, transformations, and success stories",
     "primary_field": "win", "person_field": "speaker"},
    {"key": "question_bank", "label": "Question Bank", "display_category": "client_insights",
     "description": "Strategic questions asked during meetings",
     "primary_field": "question", "person_field": "askedBy"},
    {"key": "budget_signals", "label": "Budget Signals", "display_category": "client_insights",
     "description": "Budget, pricing, and financial discussion signals",
     "primary_field": "signal", "person_field": "speaker"},
    {"key": "competitive_mentions", "label": "Competitive Mentions", "display_category": "client_insights",
     "description": "Competitor references and comparisons",
     "primary_field": "competitor", "person_field": "mentionedBy"},
    {"key": "relationship_trajectory", "label": "Relationship Trajectory", "display_category": "client_insights",
     "description": "Relationship health and trajectory over time",
     "primary_field": "trajectory", "person_field": None},
    # --- Product Insights ---
    {"key": "product_praise", "label": "Product Praise", "display_category": "product_insights",
     "description": "Positive product feedback and endorsements",
     "primary_field": "praise", "person_field": "speaker"},
    {"key": "bug_reports", "label": "Bug Reports", "display_category": "product_insights",
     "description": "Reported bugs and issues from meetings",
     "primary_field": "bug", "person_field": "speaker"},
    {"key": "frictions", "label": "Frictions", "display_category": "product_insights",
     "description": "User experience friction points",
     "primary_field": "friction", "person_field": "speaker"},
    {"key": "feature_requests", "label": "Feature Requests", "display_category": "product_insights",
     "description": "Requested features and enhancements",
     "primary_field": "request", "person_field": "speaker"},
    # --- Signature Insights ---
    {"key": "story_bank", "label": "Story Bank", "display_category": "signature_insights",
     "description": "Compelling stories from meetings — content and keynote fuel",
     "primary_field": "story", "person_field": "speaker"},
    {"key": "ip_builder", "label": "IP & Frameworks", "display_category": "signature_insights",
     "description": "Your named concepts, mental models, and proprietary frameworks",
     "primary_field": "insight", "person_field": "speaker"},
    {"key": "opportunity_finder", "label": "Opportunity Finder", "display_category": "signature_insights",
     "description": "Business opportunities identified from conversations",
     "primary_field": "opportunity", "person_field": "speaker"},
    {"key": "language_patterns", "label": "Language Patterns", "display_category": "signature_insights",
     "description": "Customer phrases grouped by category — positioning fuel",
     "primary_field": "phrase", "person_field": "speaker"},
    # --- Post-Meeting (Operational) ---
    {"key": "meeting_outcomes", "label": "Meeting Outcomes", "display_category": "post_meeting",
     "description": "Key outcomes and results from meetings",
     "primary_field": "outcome", "person_field": "owner"},
    {"key": "action_items_extraction", "label": "Action Items", "display_category": "post_meeting",
     "description": "Extracted action items with owners and deadlines",
     "primary_field": "action", "person_field": "owner"},
    {"key": "follow_up_needed", "label": "Follow-Up Needed", "display_category": "post_meeting",
     "description": "Items requiring follow-up after meetings",
     "primary_field": "followUp", "person_field": "owner"},
    {"key": "decisions_made", "label": "Decisions Made", "display_category": "post_meeting",
     "description": "Decisions captured during meetings",
     "primary_field": "decision", "person_field": "decidedBy"},
    {"key": "financial_impact", "label": "Financial Impact", "display_category": "post_meeting",
     "description": "Projected financial impact, cost savings, and ROI from discussions",
     "primary_field": "impact", "person_field": "owner"},
    {"key": "cos_flags", "label": "Chief of Staff Flags", "display_category": "post_meeting",
     "description": "What a Chief of Staff would flag — relationship, risk, commitment, and strategic signals",
     "primary_field": "flag", "person_field": "person"},
    # --- Data Source Insights ---
    {"key": "calendar_patterns", "label": "Meeting Cadence & Patterns", "display_category": "data_source_insights",
     "description": "Meeting frequency, preferred times, recurring attendees from calendar",
     "primary_field": None, "person_field": None},
    {"key": "email_communication", "label": "Email Communication Style", "display_category": "data_source_insights",
     "description": "Communication patterns, top recipients, writing style from email",
     "primary_field": None, "person_field": None},
    {"key": "cloud_collaboration", "label": "Document Collaboration", "display_category": "data_source_insights",
     "description": "File types, collaboration frequency, project patterns from cloud storage",
     "primary_field": None, "person_field": None},
    # --- Assessment Insights ---
    {"key": "discovery_assessment", "label": "Discovery Assessment", "display_category": "assessment_insights",
     "description": "Self-assessment discovery results analyzed by AI",
     "primary_field": "insight", "person_field": None},
]

REGISTRY_KEYS = [entry["key"] for entry in CATEGORY_REGISTRY]
REGISTRY_BY_KEY = {entry["key"]: entry for entry in CATEGORY_REGISTRY}

# ---------------------------------------------------------------------------
# Model tiers — mirrored from clearpath/server/services/intelligence.ts
# (SONNET_PROMPT_KEYS / GEMINI_FLASH_KEYS / GEMINI_FLASH_LITE_KEYS + Haiku
# fallback). Model ids are the Clearpath defaults, each overridable via env.
# ---------------------------------------------------------------------------
DEFAULT_SONNET_MODEL = "claude-sonnet-4-5"
DEFAULT_FLASH_MODEL = "gemini-2.5-flash"
DEFAULT_FLASH_LITE_MODEL = "gemini-2.5-flash-lite"
DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001"

# High-value insights requiring deepest reasoning routed to Sonnet
SONNET_PROMPT_KEYS = frozenset({
    "story_bank", "ip_builder", "relationship_trajectory", "opportunity_finder", "cos_flags",
})

# Mid-tier insights routed to Gemini Flash (voice, sentiment, competitive signals)
GEMINI_FLASH_KEYS = frozenset({
    "voice_of_customer", "desires", "problems_pains", "objections",
    "language_patterns", "competitive_mentions", "client_wins", "product_praise",
})

# Budget-tier insights routed to Gemini Flash-Lite (structured/factual extractions)
GEMINI_FLASH_LITE_KEYS = frozenset({
    "question_bank", "budget_signals", "feature_requests", "frictions", "bug_reports",
})


def _model_tiers():
    """Provider+model per tier, resolving env overrides at call time."""
    return {
        "sonnet": {"provider": "anthropic",
                   "model": os.environ.get("INTEL_MODEL_SONNET", DEFAULT_SONNET_MODEL)},
        "flash": {"provider": "gemini",
                  "model": os.environ.get("INTEL_MODEL_FLASH", DEFAULT_FLASH_MODEL)},
        "flash_lite": {"provider": "gemini",
                       "model": os.environ.get("INTEL_MODEL_FLASH_LITE", DEFAULT_FLASH_LITE_MODEL)},
        "haiku": {"provider": "anthropic",
                  "model": os.environ.get("INTEL_MODEL_HAIKU", DEFAULT_HAIKU_MODEL)},
    }


# Static snapshot of key → tier assignment (defaults; route_model() re-reads env).
MODEL_TIERS = {
    key: dict(_model_tiers()[
        "sonnet" if key in SONNET_PROMPT_KEYS
        else "flash" if key in GEMINI_FLASH_KEYS
        else "flash_lite" if key in GEMINI_FLASH_LITE_KEYS
        else "haiku"
    ])
    for key in REGISTRY_KEYS
}


def route_model(key):
    """Return {"provider", "model"} for a registry key.

    Implements the Clearpath 3-tier routing: Sonnet for the deep-reasoning
    set, Gemini Flash for the mid tier, Gemini Flash-Lite for the budget
    tier, and Haiku as the fallback for everything else. Env overrides
    (INTEL_MODEL_*) are read at call time.
    """
    tiers = _model_tiers()
    if key in SONNET_PROMPT_KEYS:
        return dict(tiers["sonnet"])
    if key in GEMINI_FLASH_KEYS:
        return dict(tiers["flash"])
    if key in GEMINI_FLASH_LITE_KEYS:
        return dict(tiers["flash_lite"])
    return dict(tiers["haiku"])


# Ported as data from clearpath/server/services/default-prompts.ts (promptText per key).
# Three keys (calendar_patterns, email_communication, discovery_assessment) have no
# default extraction prompt in Clearpath (computed by data-sources/assessments modules);
# their prompts below are synthesized from the registry descriptions and marked as such.
PROMPTS = {
    'objections': {
        'display_name': 'Objections',
        'description': 'Extracts reasons for hesitation, doubt, or resistance. Stays close to what was actually said.',
        'prompt_text': 'Extract objections — reasons participants hesitate, doubt, or resist. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nTypes: concerns about themselves, about the offer or solution, timing, price, provider, past failures, the unknown.\n\nStay close to the speaker\'s actual words. A near-verbatim statement is always better than a paraphrase. If the objection emerged across several exchanges rather than a single quotable moment, summarize tightly without editorializing.\n\nFor each objection:\n- The objection statement (near-verbatim preferred)\n- Speaker name\n- Severity: Strong (clearly stated, blocking), Moderate (expressed but not absolute), Mild (hinted at)\n- How it was addressed in the conversation, if at all\n\nMax 5. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "objection": The first-person statement capturing hesitation\n- "speaker": Speaker name\n- "severity": How strong the objection is (Strong, Moderate, Mild)\n- "response": Suggested response or how it was addressed (if discussed)\n\nExample: [{"objection": "I\'m not sure I can justify the investment right now", "speaker": "Jane Smith", "severity": "Strong", "response": "Discussed ROI timeline and payment options"}]\n\nMax 5 items. Return [] if none found.',
    },
    'desires': {
        'display_name': 'Desires',
        'description': 'Surfaces what participants are moving toward — grounded in what was actually said, not invented. Infers underlying motivation only when clearly supported by the transcript.',
        'prompt_text': 'Surface what participants are moving toward. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above). Only extract from clients/prospects/participants.\n\nIMPORTANT CONTEXT: People rarely state desires directly. They describe problems, ask questions, express excitement, or mention what they wish existed. Your job is to surface the underlying motivation — but only when it is clearly supported by what was actually said. Do not invent desires. Do not project outcomes the speaker never implied.\n\nGROUNDING RULE: Every desire you surface must be traceable to something specific in the transcript — a quote, a question, a reaction, a statement of aspiration. If you cannot point to a specific moment that supports the desire, do not include it.\n\nWHAT TO LOOK FOR:\n- Explicit aspirations: things they said they want, wish for, or are trying to achieve\n- Implicit direction: what the pattern of their complaints points toward (e.g. repeated manual work complaints point toward wanting to reclaim time — but only if they said something like "I just want to not have to do this")\n- Questions that reveal want: "Is there a way to..." or "Could we ever..." often signal an underlying desire\n- Emotional reactions: excitement, relief, or recognition when a possibility is named\n\nWHAT TO AVOID:\n- Universal platitudes ("wants to be less stressed", "wants to feel confident") without a specific grounding moment\n- Desires that require you to imagine what they\'d want rather than observe it\n- Identity-level projections ("wants to become a leader") unless they actually said something like that\n\nFor each desire:\n- The desire in plain language (what they are moving toward)\n- The grounding quote or moment from the transcript that supports it (exact or near-exact)\n- Speaker name\n- Priority: Core (stated directly or implied strongly), Emerging (hinted at, less certain)\n- Theme: Time / Autonomy / Capability / Recognition / Security / Clarity / Growth / Other\n\nMax 8. Zero acceptable if the transcript does not support any grounded inference.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "desire": The first-person internal monologue statement\n- "speaker": Speaker name\n- "priority": Priority level (Core, Aspirational, Emerging)\n- "theme": Theme (e.g. Identity, Freedom, Mastery, Impact, Belonging)\n\nExample: [{"desire": "I want to be the person who has their business figured out", "speaker": "Jane Smith", "priority": "Core", "theme": "Identity"}]\n\nMax 8 items. Return [] if none found.',
    },
    'problems_pains': {
        'display_name': 'Problems & Pains',
        'description': "Extracts what's broken or not working, staying as close to the speaker's actual words as possible. Excludes consultant/host.",
        'prompt_text': 'Extract problems and pains from this transcript. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above). Only extract from clients/prospects/participants.\n\nPRIORITY: Stay as close to the speaker\'s actual words as possible. A near-verbatim quote is always better than a paraphrase. If they said it clearly, use their words. If you must summarize because the pain emerged across several sentences rather than one quotable moment, keep the summary tight and grounded — do not editorialize or add emotional color they didn\'t express.\n\nWhat counts as a pain: something broken, stuck, slow, manual, inconsistent, missing, or causing frustration — stated or clearly implied by the speaker.\n\nWhat does not count: vague dissatisfaction without specifics, abstract complaints about the industry, or anything requiring inference beyond what was actually said.\n\nFor each pain:\n- The pain statement (near-verbatim preferred; summary only if necessary)\n- Speaker name\n- Severity: High (blocking work or costing significant time/money), Medium (recurring friction), Low (minor annoyance)\n- Category: Workflow / Tool / Data / Communication / Security / Capacity / Cost / Adoption / Other\n\nMax 10. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "problem": The first-person visceral statement\n- "speaker": Speaker name\n- "severity": Severity level (High, Medium, Low)\n- "category": Category of the pain (e.g. Workflow, Identity, Revenue, Time, Confidence)\n\nExample: [{"problem": "I spend half my day just trying to find the right information", "speaker": "Jane Smith", "severity": "High", "category": "Workflow"}]\n\nMax 10 items. Return [] if none found.',
    },
    'voice_of_customer': {
        'display_name': 'Voice of Customer',
        'description': 'Extracts customer quotes categorized by purchase motivation, goals, struggles, experiences, and self-aware moments. Excludes consultant/host.',
        'prompt_text': 'Extract voice of customer quotes. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above). Only extract from clients/prospects.\n\nCategories: Why they bought, What they\'re trying to achieve, Struggles and realizations, Experience with the consultant or products, Self-aware moments.\n\nQuality rules: quotes must be self-contained, represent distinct insights, and contain no filler or noise. Prefer near-verbatim phrasing — stay as close to the speaker\'s actual words as possible. Max 5 quotes, zero acceptable if none found.\n\nFor each quote provide:\n- The exact or near-exact quote (speaker\'s words, not a paraphrase)\n- Speaker name\n- Category (Why they bought / Goals / Struggles / Experience / Self-aware)\n- Sentiment or emotional tone\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "quote": The exact or near-exact quote\n- "speaker": Speaker name\n- "sentiment": Sentiment or emotional tone\n- "theme": Which category it falls under (e.g. Why they bought, Goals, Struggles, Experience, Self-aware)\n\nExample: [{"quote": "I finally feel like I have a system", "speaker": "Jane Smith", "sentiment": "Positive", "theme": "Experience"}]\n\nMax 5 items. Return [] if none found.',
    },
    'client_wins': {
        'display_name': 'Client Wins',
        'description': 'Extracts specific achievements and transformations connected to work done together. Excludes consultant/host self-reporting.',
        'prompt_text': 'Scan this transcript for wins — moments where someone ELSE describes a result, achievement, or transformation EXPLICITLY connected to the consultant\'s work.\n\nTHE ATTRIBUTION TEST (strict — every item MUST pass):\nDoes the speaker EXPLICITLY connect this result to the consultant\'s work? Look for:\n- Naming the consultant directly ("what [Name] built", "your recommendation")\n- Referencing a specific deliverable ("that dashboard", "the automation you set up")\n- Using "you" or "your team" when addressing the consultant\n- Describing a before/after tied to the engagement ("since we started working with you...")\nIf the connection requires inference or assumption, skip it.\n\nQUANTIFIED IMPACT PRIORITY: Wins with numbers (revenue, hours saved, percentage improvements) are more valuable than qualitative ones. Capture the number exactly as stated.\n\nFor each win:\n- Quote: their words, natural voice, as close to verbatim as possible\n- Speaker name\n- Win label: short, conversational, specific (5-20 words)\n- Impact: the so-what in one sentence\n- Category: Results achieved / Problems solved / Things shipped / Habits stuck / Transformation\n- Quantified impact: specific numbers if stated, otherwise leave blank\n- Case study potential: high / medium / low\n\nMax 8. Zero acceptable if none found — most meetings have 0-3.\n\nCRITICAL: Return ONLY a raw JSON array. No markdown, no code fences, no preamble.\n\nEach element:\n- "quote": Their words, natural voice. This displays on the wall. Pick the best moment.\n- "speaker": Full speaker name as it appears in transcript\n- "win": Short label — conversational, specific, 5-20 words\n- "impact": Why it matters — the so-what in one sentence\n- "category": Results achieved | Problems solved | Things shipped | Habits stuck | Transformation\n- "quantified_impact": Specific numbers if stated (e.g. "2x conversion rate", "saved 10hrs/week") or null\n- "case_study_potential": "high", "medium", or "low"\n\nExample: [{"quote": "we set up that automated report and honestly I don\'t even think about it anymore, it just runs, saves us probably fifteen hours a month", "speaker": "Jane Smith", "win": "Automated monthly reporting — saves 15 hours", "impact": "Freed up almost two full days per month for the team", "category": "Results achieved", "quantified_impact": "15 hours/month saved", "case_study_potential": "high"}]\n\nMax 8 items. Return [] if genuinely none found — most meetings have 0-3.',
    },
    'question_bank': {
        'display_name': 'Question Bank',
        'description': 'Extracts all questions asked by non-host participants, grouped by theme.',
        'prompt_text': 'Extract all questions asked by non-host participants. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nCapture questions as close to verbatim as possible. Group by theme (Pricing / Process / Results / Timeline / Technical / Strategy / Other).\n\nFor each question:\n- The question (exact or near-exact)\n- Who asked it (speaker name)\n- Theme category\n- Brief context of what prompted it\n\nMax 15. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "question": The exact or near-exact question\n- "askedBy": Who asked it (speaker name)\n- "theme": Theme category (e.g. Pricing, Process, Results, Timeline, Technical, Strategy)\n- "context": Brief context of what prompted the question\n\nExample: [{"question": "How long does implementation take?", "askedBy": "Jane Smith", "theme": "Timeline", "context": "Asked during discussion of onboarding process"}]\n\nMax 15 items. Return [] if none found.',
    },
    'budget_signals': {
        'display_name': 'Budget Signals',
        'description': 'Detects mentions of budgets, pricing, spending, fiscal years, approval processes, and funding signals.',
        'prompt_text': 'Detect budget and financial signals from non-host participants. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nSignal types:\n- Budget: specific amounts, ranges, allocations\n- Pricing: reactions to pricing, comparisons, negotiations\n- Timeline: fiscal year references, budget cycles, approval timelines\n- Approval: decision-making process, who needs to approve, procurement steps\n\nFor each signal:\n- What was said or implied (near-verbatim preferred)\n- Speaker name\n- Signal type: Budget / Pricing / Timeline / Approval\n- Brief context\n\nMax 10. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "signal": The signal (what was said or implied)\n- "speaker": Speaker name\n- "signalType": Signal type (Budget, Pricing, Timeline, or Approval)\n- "context": Brief context\n\nExample: [{"signal": "We have $50k allocated for Q2", "speaker": "John Doe", "signalType": "Budget", "context": "Mentioned during pricing discussion"}]\n\nMax 10 items. Return [] if none found.',
    },
    'competitive_mentions': {
        'display_name': 'Competitive Mentions',
        'description': 'Extracts names of alternatives, competitors, or comparisons mentioned in conversations.',
        'prompt_text': 'Extract names of alternatives, competitors, or comparisons mentioned by non-host participants. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nLook for:\n- Direct competitor names\n- Alternative solutions or approaches mentioned\n- Comparisons ("we also looked at...", "compared to...", "unlike...")\n- Previous vendors or tools\n\nFor each mention:\n- Competitor or alternative name\n- Who mentioned it (speaker name)\n- Sentiment: Positive / Negative / Neutral\n- Brief context of the mention\n\nMax 10. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "competitor": Competitor or alternative name\n- "mentionedBy": Who mentioned it (speaker name)\n- "sentiment": Sentiment (Positive, Negative, or Neutral)\n- "context": Brief context of the mention\n\nExample: [{"competitor": "Acme Corp", "mentionedBy": "Jane Smith", "sentiment": "Negative", "context": "Compared unfavorably to current solution"}]\n\nMax 10 items. Return [] if none found.',
    },
    'relationship_trajectory': {
        'display_name': 'Relationship Trajectory',
        'description': 'Analyzes conversation signals to assess whether the relationship is deepening, maintaining, or cooling. Defaults to Maintaining unless there is clear evidence otherwise.',
        'prompt_text': 'Analyze the conversation to assess the current trajectory of this relationship.\n\nDEFAULT TO MAINTAINING. This is the correct answer for most meetings. Only assess DEEPENING or COOLING when there is clear, specific evidence — not ambient warmth or routine check-in energy.\n\nDEEPENING requires explicit signals: the client expanding scope, initiating new topics unprompted, expressing trust or gratitude about specific outcomes, referencing the relationship positively, or asking about next steps proactively.\n\nCOOLING requires explicit signals: shorter or less engaged responses than expected, declining to commit to follow-up, expressing doubt about fit, value, or timing, raising concerns they haven\'t raised before, or a notable shift in tone since the last interaction.\n\nDO NOT assess DEEPENING because:\n- The meeting went fine\n- People were friendly\n- There was laughter or casual conversation\n- The client showed up\n\nDO NOT assess COOLING because:\n- The client asked hard questions\n- There was disagreement on specifics\n- The meeting was operational rather than relational\n\nAssessment output:\n- Trajectory: Deepening / Maintaining / Cooling\n- Specific signals: 2-4 concrete moments from this conversation that support the assessment (quote or describe the actual moment — not generic observations)\n- Confidence: High / Medium / Low (how certain are you given the available signal?)\n- Suggested next action: one specific thing to do this week based on this assessment\n\nIf the transcript lacks enough signal to assess meaningfully, say so explicitly rather than forcing an assessment.\n\nIMPORTANT: Return ONLY a valid JSON array with exactly one element. No markdown, no explanation, no code fences. The element must have these fields:\n- "trajectory": Trajectory assessment (Deepening, Maintaining, or Cooling)\n- "signals": Comma-separated list of 3-5 specific signals from the conversation that support the assessment\n- "suggestedAction": A suggested next action to strengthen or course-correct the relationship\n\nExample: [{"trajectory": "Deepening", "signals": "Asked about expanding scope, shared personal goals, requested follow-up meeting", "suggestedAction": "Schedule strategy session to explore expanded engagement"}]\n\nBe specific — reference actual moments from the transcript, not generic observations. Return [] if the transcript lacks enough signal to assess.',
    },
    'product_praise': {
        'display_name': 'Product Praise',
        'description': "Extracts genuine praise from non-host participants explicitly connected to the consultant's work.",
        'prompt_text': 'Scan this transcript for praise — moments where someone ELSE says something genuinely positive about the consultant\'s work, product, service, or results. Never extract the host\'s own words.\n\nTHE ATTRIBUTION TEST (strict):\nThe speaker must explicitly reference the consultant, their work, or a specific deliverable. Generic positive comments ("that\'s great", "things are going well") do not count unless explicitly tied to the consultant.\n\nPRAISE SOURCE CLASSIFICATION:\n- External client or partner praise = high value\n- Internal colleague praise = low value unless it references specific impact and comes from leadership\n- Referral signals = highest value, always include\n\nFor each item:\n- Quote: their exact words, natural voice\n- Speaker name\n- Praise label: short, conversational (5-15 words)\n- Source type: external_client / external_partner / internal_leadership / referral\n- Feature or service being praised (if specific)\n- Impact: how it changed something for them\n- Sentiment strength: strong / moderate\n\nMax 8. Zero acceptable if none found — most meetings have 0-2.\n\nCRITICAL: Return ONLY a raw JSON array. No markdown, no code fences, no preamble.\n\nEach element:\n- "quote": Their words, natural voice. This is the hero display.\n- "speaker": Full speaker name as it appears in transcript\n- "praise": Short label (5-15 words) — conversational, not corporate\n- "praise_source": "external_client" | "external_partner" | "internal_leadership" | "referral"\n- "feature": Which product/feature/service they\'re praising (or null)\n- "impact": How it changed something for them\n- "transformation": Before vs after (or null)\n- "sentiment_strength": "strong" or "moderate"\n\nExample: [{"quote": "I honestly can\'t even imagine going back to the old way, like the dashboard just completely changed how I run my business", "speaker": "Jane Smith", "praise": "Dashboard transformed weekly reporting", "praise_source": "external_client", "feature": "Dashboard", "impact": "Saved 10 hours per week on reporting", "transformation": "From manual spreadsheet tracking to automated insights", "sentiment_strength": "strong"}]\n\nMax 8 items. Return [] if genuinely none found — most meetings have 0-2.',
    },
    'bug_reports': {
        'display_name': 'Bug Reports',
        'description': 'Extracts bugs — something broken, crashes, errors, behaves incorrectly.',
        'prompt_text': 'Extract bugs — something broken, crashing, erroring, or behaving incorrectly. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nA bug is not "hard to use" (that\'s friction) and not "doesn\'t exist" (that\'s a feature request). It is something that is supposed to work and doesn\'t.\n\nFor each bug:\n- Description of what broke (as described by the speaker)\n- Speaker name\n- Severity: Critical / High / Medium / Low\n- Steps to reproduce, if mentioned\n\nNo artificial limit. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "bug": Description of the bug\n- "speaker": Speaker name who reported it\n- "severity": Severity (Critical, High, Medium, Low)\n- "stepsToReproduce": Steps to reproduce if mentioned\n\nExample: [{"bug": "The export button does nothing when clicked", "speaker": "Jane Smith", "severity": "High", "stepsToReproduce": "Click Export on the dashboard page"}]\n\nReturn [] if none found.',
    },
    'frictions': {
        'display_name': 'Frictions & WTFs',
        'description': 'Captures moments of frustration or confusion with existing products, services, or processes. Not bugs, not feature requests.',
        'prompt_text': 'Extract frictions — moments of frustration, confusion, or unnecessary effort with existing products, services, or processes. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nFrictions are things that exist but work poorly, require extra steps, or cause confusion. They are not bugs (something crashing or broken) and not feature requests (something that doesn\'t exist).\n\nFor each friction:\n- Description of the friction moment (stay close to what they actually said)\n- Speaker name\n- Severity: High / Medium / Low\n- Product area or workflow affected\n\nDeduplicate ruthlessly — if the same friction is mentioned multiple times, capture it once with the best quote. No artificial limit on count.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "friction": Description of the friction moment\n- "speaker": Speaker name\n- "severity": Severity (High, Medium, Low)\n- "area": Product area or workflow affected\n\nExample: [{"friction": "Every time I want to find a past conversation I have to scroll through hundreds of messages", "speaker": "Jane Smith", "severity": "High", "area": "Search & Navigation"}]\n\nReturn [] if none found.',
    },
    'feature_requests': {
        'display_name': 'Feature Requests',
        'description': "Extracts specific, discrete capabilities that don't exist yet. Excludes consultant/host.",
        'prompt_text': 'Extract feature requests — specific, discrete capabilities that don\'t exist yet. CRITICAL: Exclude the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above).\n\nA feature request is something the speaker explicitly says they wish existed, want built, or asks whether it\'s possible. It is not a workaround complaint (that\'s friction) or something broken (that\'s a bug).\n\nFor each request:\n- The feature description (stay close to how they described it)\n- Speaker name\n- Priority: Critical / High / Medium / Low (inferred from how they described the need)\n- Current workaround, if mentioned\n\nNo artificial limit on count. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "request": The feature description\n- "speaker": Who requested it (speaker name)\n- "priority": Inferred priority (Critical, High, Medium, Low)\n- "currentWorkaround": How they currently work around the missing feature (if mentioned)\n\nExample: [{"request": "Ability to bulk-import contacts from CSV", "speaker": "Jane Smith", "priority": "High", "currentWorkaround": "Manually adding one by one"}]\n\nReturn [] if none found.',
    },
    'story_bank': {
        'display_name': 'Story Bank',
        'description': 'Extracts compelling stories told by the consultant/host only.',
        'prompt_text': 'Extract stories told by the consultant/host only (identified as HOST in the VERIFIED SPEAKER MAP above). Do NOT extract stories from clients or other participants.\n\nWhat makes a story worth capturing: a specific moment in time, stakes or tension, some form of change or resolution, human elements. Pure theory or abstract explanations are not stories.\n\nCapture: client transformation stories the host tells, failures and what they led to, behind-the-scenes decisions the host shares, "I used to think X, but then Y" moments.\n\nStay close to how the host actually told it. Write conversationally at an accessible reading level. Max 400 characters per story.\n\nFor each story:\n- The story in the host\'s voice (max 400 chars)\n- Speaker: must be the consultant/host name\n- Theme: Transformation / Failure-to-Breakthrough / Behind-the-Scenes / Mindset Shift\n- Where it could be used: keynote / case study / sales call / content / other\n\nExtract 3-5 strongest stories. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "story": The story in conversational voice (max 400 chars)\n- "speaker": Must be the consultant/host name\n- "theme": Theme (Transformation, Failure-to-Breakthrough, Behind-the-Scenes, Mindset Shift)\n- "usableAs": Where this story could be used (Keynote, Case Study, Sales Call, Social Post, Newsletter)\n\nExample: [{"story": "I was about to quit when a client said something that changed everything...", "speaker": "Josh Weiss", "theme": "Mindset Shift", "usableAs": "Keynote"}]\n\nMax 5 items. Return [] if none found.',
    },
    'ip_builder': {
        'display_name': 'IP Builder',
        'description': "Captures the consultant's ideas, frameworks, and non-obvious insights as expressed in the conversation. Host only.",
        'prompt_text': 'Capture intellectual property expressed by the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above). This is the opposite of most prompts — you are extracting THEIR thinking, not the client\'s.\n\nWHAT COUNTS:\n- A framework, model, or structured way of thinking the consultant articulated\n- A non-obvious insight or principle they expressed\n- A mental model they used to explain something\n- A recurring philosophy or belief they stated\n\nWHAT DOES NOT COUNT:\n- Common knowledge or generic advice\n- Things the consultant was summarizing from someone else\n- Ideas that came from the client (those go in other categories)\n\nNAMING RULE: Do not invent framework names. If the consultant named the concept themselves, use their name. If they didn\'t name it, describe what the idea is in plain language. Do not apply "The [X] [Y]" labels — that is AI-generated noise, not their IP.\n\nFor each idea:\n- The concept in plain language (what the idea actually is, in 1-3 sentences)\n- A direct quote or near-quote from the consultant that expresses it (required — if you can\'t find a grounding quote, skip it)\n- Category: Framework / Principle / Mental Model / Methodology / Belief\n- Where this could be useful: content / client work / keynote / other\n\nMost meetings yield 0-2 genuine ideas. Zero is acceptable and expected in operational meetings.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "insight": The named concept (chapter title style, 3-5 words)\n- "speaker": The consultant\'s name\n- "category": Type of IP (Framework, Mental Model, Philosophy, Methodology, Principle)\n- "applicability": Where this IP could be used (Keynote, Book, Course, Client Work, Content)\n\nExample: [{"insight": "The Momentum Flywheel", "speaker": "John Doe", "category": "Framework", "applicability": "Keynote"}]\n\nReturn [] if none found.',
    },
    'opportunity_finder': {
        'display_name': 'Opportunity Finder',
        'description': 'Extracts opportunities the consultant/host identifies — new offers, product ideas, content angles. Host-authored only.',
        'prompt_text': 'Extract opportunities identified by the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above). This captures their strategic thinking — the opportunities they spot during conversations. Do NOT extract opportunities described by clients.\n\nSignals: when the host says things like "we should build...", "there\'s an opportunity to...", "what if we offered...", "I\'m thinking about...", or identifies a gap in the market.\n\nFour types:\n1. Product Upgrades — improvements to existing products/services the host identifies\n2. New Products — entirely new offerings the host sees demand for\n3. New Offers — packaging, pricing, or positioning changes the host proposes\n4. Content — content ideas the host articulates (posts, talks, courses, frameworks to publish)\n\nFor each opportunity:\n- Clear description of what the opportunity is\n- Speaker: must be the consultant/host name\n- Type: Product Upgrade / New Product / New Offer / Content\n- Suggested next step\n\nMax 5. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "opportunity": Clear description of the opportunity\n- "speaker": Must be the consultant/host name\n- "type": Type (Product Upgrade, New Product, New Offer, Membership Content)\n- "nextStep": Suggested next step to pursue this opportunity\n\nExample: [{"opportunity": "Group coaching program for advanced users", "speaker": "Josh Weiss", "type": "New Product", "nextStep": "Survey top 20 clients about interest and pricing"}]\n\nMax 5 items. Return [] if none found.',
    },
    'language_patterns': {
        'display_name': 'Language Patterns',
        'description': "Captures the consultant/host's signature phrases and recurring language. Host only.",
        'prompt_text': 'Capture the consultant/host\'s signature language. CRITICAL: Extract ONLY from the consultant/host (identified as HOST in the VERIFIED SPEAKER MAP above). Client language goes in voice_of_customer.\n\nThis captures the consultant\'s voice — phrases, metaphors, and ways of explaining things that define how they communicate.\n\nVERBATIM RULE: Capture the phrase as close to how they actually said it as possible. Do not paraphrase or polish. The value is in their exact language.\n\nCategories:\n- Framework: a recurring model or structure they reference\n- Metaphor: a vivid analogy they use to explain something\n- Catchphrase: a signature phrase they repeat or that captures their thinking\n- Teaching: how they explain a complex concept simply\n\nFor each phrase:\n- The phrase (exact or near-exact — their words, not yours)\n- Speaker: must be the consultant/host name\n- Category: Framework / Metaphor / Catchphrase / Teaching\n- Where it could be used: keynote / course / book / content / sales\n\nMax 12. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "phrase": The exact or near-exact phrase (preserve their words)\n- "speaker": Must be the consultant/host name\n- "category": Category (Framework, Metaphor, Catchphrase, or Teaching)\n- "usableAs": Where this phrase could be used (Keynote, Course, Book, Social Post, Sales Call)\n\nExample: [{"phrase": "Nobody ever got fired for having too much data — they got fired for not knowing what to do with it", "speaker": "Josh Weiss", "category": "Catchphrase", "usableAs": "Keynote"}]\n\nMax 12 items. Return [] if none found.',
    },
    'meeting_outcomes': {
        'display_name': 'Meeting Outcomes',
        'description': 'Extracts key outcomes, results, and conclusions from the meeting.',
        'prompt_text': 'Extract key outcomes from this meeting transcript.\n\nIdentify the main results, conclusions, and accomplishments. Focus on substantive outcomes — not logistics. Capture both explicit outcomes (stated conclusions) and implicit ones (consensus reached through discussion).\n\nFor each outcome:\n- Clear statement of what was achieved or concluded\n- Type: Agreement / Resolution / Milestone / Update / Discovery\n- Owner: who contributed to or owns this outcome\n- Why it matters (one sentence)\n\nMax 8. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "outcome": Clear statement of what was achieved or concluded\n- "type": One of "Agreement", "Resolution", "Milestone", "Update", or "Discovery"\n- "owner": Who contributed to or owns this outcome (name or "Unassigned")\n- "impact": Brief note on why this outcome matters\n\nExample format:\n[{"outcome":"Agreed to launch beta by March","type":"Agreement","owner":"Sarah","impact":"Unblocks marketing campaign"}]\n\nMax 8 items. Return [] if none found.',
    },
    'action_items_extraction': {
        'display_name': 'Action Items Extraction',
        'description': 'Extracts structured action items with owners and deadlines.',
        'prompt_text': 'Extract action items from this meeting transcript.\n\nIdentify every task, commitment, follow-up, or to-do mentioned. Be specific — "send the proposal" is better than "follow up."\n\nFor each action item:\n- Clear, actionable description of what needs to be done\n- Owner: person responsible (or "Unassigned" if not specified)\n- Due date or timeframe if mentioned\n- Status: pending\n\nNo artificial limit on count. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "action": Clear, actionable description of what needs to be done\n- "owner": Person responsible (use their name, or "Unassigned" if not specified)\n- "dueDate": Due date or timeframe if mentioned, otherwise ""\n- "status": Always "pending" for newly extracted items\n\nExample format:\n[{"action":"Send proposal to client","owner":"John","dueDate":"2026-02-20","status":"pending"}]\n\nNo artificial limit on count. Return [] if none found.',
    },
    'follow_up_needed': {
        'display_name': 'Follow-Up Needed',
        'description': 'Identifies required follow-ups, next steps, and communications to send after the meeting.',
        'prompt_text': 'Identify follow-ups needed after this meeting.\n\nExtract all follow-up items, next steps, and post-meeting actions.\n\nFor each follow-up:\n- Clear description of what needs to happen\n- Category: Communication / Meeting to Schedule / Internal Action / External Deliverable\n- Owner: person responsible (or "Unassigned")\n- Due date or timeframe if mentioned\n- Status: pending\n\nNo artificial limit. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "followUp": Clear description of what needs to happen\n- "category": One of "Communication", "Meeting to Schedule", "Internal Action", or "External Deliverable"\n- "owner": Person responsible (use their name, or "Unassigned" if not specified)\n- "dueDate": Due date or timeframe if mentioned, otherwise ""\n- "status": Always "pending" for newly extracted items\n\nExample format:\n[{"followUp":"Send thank-you email to Sarah","category":"Communication","owner":"John","dueDate":"","status":"pending"}]\n\nNo artificial limit on count. Return [] if none found.',
    },
    'decisions_made': {
        'display_name': 'Decisions Made',
        'description': 'Highlights decisions made during the meeting with confidence levels.',
        'prompt_text': 'Extract decisions made during this meeting.\n\nIdentify decisions that were agreed upon or confirmed. Focus only on actual decisions — not action items or tasks. A decision is something that was settled, not something still being discussed.\n\nFor each decision:\n- Clear statement of what was decided\n- Confidence: HIGH (explicitly stated and agreed), MEDIUM (implied agreement, no objection), LOW (tentative or conditional)\n- Who was involved in making it\n- Brief context for why this decision was made\n\nMax 10. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "decision": Clear statement of what was decided\n- "confidence": "HIGH" (explicitly stated and agreed), "MEDIUM" (implied agreement, no objection), or "LOW" (tentative, conditional)\n- "decidedBy": Names of people involved in the decision\n- "context": Brief context for why this decision was made\n\nExample format:\n[{"decision":"Approved Q2 budget of $50K for marketing","confidence":"HIGH","decidedBy":"Sarah, Mike","context":"Discussed ROI from Q1 campaign"}]\n\nMax 10 decisions. Return [] if none found.',
    },
    'financial_impact': {
        'display_name': 'Financial Impact',
        'description': 'Identifies projected financial impact, cost savings, ROI estimates, and budget implications discussed.',
        'prompt_text': 'Analyze this meeting for financial impact signals.\n\nExtract mentions of:\n- Projected cost savings or reductions\n- Revenue opportunities or growth projections\n- Budget allocations or changes\n- ROI estimates or efficiency gains\n- Resource reallocation or operational overhead changes\n- Investment decisions\n\nFor each signal:\n- Clear description of the financial impact\n- Magnitude: specific numbers if stated, or "unquantified" if no number given\n- Timeframe: when the impact is expected\n- Confidence: HIGH (explicit numbers discussed), MEDIUM (estimates mentioned), LOW (implied)\n- Who raised this point\n\nMax 8. Zero acceptable if none found.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "impact": Clear description of the financial impact\n- "magnitude": Quantified amount if mentioned (e.g. "$50K savings", "22% reduction", "3x ROI"), or "unquantified" if no number given\n- "timeframe": When the impact is expected (e.g. "Q2 2026", "next 6 months", "ongoing")\n- "confidence": "HIGH" (explicit numbers discussed), "MEDIUM" (estimates mentioned), or "LOW" (implied, not quantified)\n- "owner": Person responsible or who raised this point\n\nExample format:\n[{"impact":"Projected 22% reduction in operational overhead","magnitude":"22% reduction","timeframe":"first 6 months","confidence":"HIGH","owner":"Elena Rossi"}]\n\nMax 8 items. Return [] if none found.',
    },
    'cos_flags': {
        'display_name': 'Chief of Staff Flags',
        'description': 'Flags what matters relationally, politically, and strategically. Judgment calls, not category extraction.',
        'prompt_text': 'You are an AI Chief of Staff reviewing this meeting on behalf of your principal. Your job is not to extract categories — it\'s to flag what MATTERS.\n\nThink relationally and politically. A great CoS notices:\n- Power dynamics shifting ("they deferred to the new VP twice")\n- Unspoken tensions or misalignment between what was said and what was meant\n- Things the principal committed to that need follow-through\n- Changes since last interaction that matter (new priorities, org changes, mood shifts)\n- Relationship maintenance signals (someone feeling neglected, a rising champion)\n- Strategic openings the principal might miss if busy\n- Risks: things that could go sideways if not addressed this week\n\nBe opinionated. A CoS doesn\'t hedge — they say "You need to call Sarah before Thursday" not "Consider reaching out."\n\nFor each flag:\n- What the CoS is flagging (direct, specific, actionable)\n- Why this matters right now (1 sentence, urgent framing)\n- Urgency: today / this_week / watch\n- Type: relationship / commitment / risk / opportunity / political\n- The person this relates to (name, not generic)\n\nMax 5 flags. Quality over quantity. Zero acceptable if this meeting had nothing worth flagging.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "flag": What the CoS is flagging (direct, specific, actionable)\n- "why": Why this matters RIGHT NOW (1 sentence, urgent framing)\n- "urgency": "today", "this_week", or "watch" — when does this need attention?\n- "type": "relationship", "commitment", "risk", "opportunity", or "political"\n- "person": The person this relates to (name, not generic)\n\nExample: [{"flag": "Sarah mentioned her board is reconsidering the vendor shortlist — you\'re still on it but she hinted at budget pressure", "why": "If you don\'t send the updated proposal by Wednesday, you\'ll miss the board packet deadline", "urgency": "this_week", "type": "risk", "person": "Sarah Chen"}]\n\nMax 5 flags. Quality over quantity. Return [] if this meeting had nothing a CoS would flag.',
    },
    'calendar_patterns': {
        'display_name': 'Meeting Cadence & Patterns',
        'description': 'Meeting frequency, preferred times, recurring attendees from calendar',
        'prompt_text': 'Analyze the source content for meeting cadence and scheduling patterns.\n\nExtract: meeting frequency, preferred times of day/week, recurring attendees,\nmeeting density, and gaps in the calendar.\n\nReturn each finding as a concise, self-contained observation.\n[Synthesized in-house from the Clearpath registry description — Clearpath computes\nthis type in the data-sources module, not via a default extraction prompt.]',
    },
    'email_communication': {
        'display_name': 'Email Communication Style',
        'description': 'Communication patterns, top recipients, writing style from email',
        'prompt_text': 'Analyze the source content for email communication patterns.\n\nExtract: communication volume and responsiveness, top recipients and key\nrelationships, tone and writing style, and notable async-communication habits.\n\nReturn each finding as a concise, self-contained observation.\n[Synthesized in-house from the Clearpath registry description — Clearpath computes\nthis type in the data-sources module, not via a default extraction prompt.]',
    },
    'cloud_collaboration': {
        'display_name': 'Document Collaboration',
        'description': 'Analyzes cloud file patterns to surface collaboration insights, project activity, and knowledge sharing signals.',
        'prompt_text': 'Analyze these cloud storage files for collaboration intelligence. Look for:\n\n- Active projects: clusters of recently modified files indicating ongoing work\n- Collaboration patterns: shared files, multiple editors, cross-team documents\n- Knowledge assets: presentations, proposals, templates that could be reused\n- Stale projects: files untouched in 30+ days that may need attention\n- Key collaborators: people who appear frequently as owners or editors\n\nFor each insight:\n- The collaboration pattern or finding (specific and actionable)\n- Type: active_project / collaboration / knowledge_asset / stale_project / key_collaborator\n- Files involved\n- People involved\n- Priority: high / medium / low\n\nMax 8 insights. Focus on actionable patterns, not obvious observations. Zero acceptable if the file list is too sparse.\n\nIMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Each element must have these fields:\n- "insight": The collaboration pattern or finding (specific, actionable)\n- "type": "active_project", "collaboration", "knowledge_asset", "stale_project", or "key_collaborator"\n- "files": Array of file names involved\n- "people": Array of people involved (names from file ownership/sharing)\n- "priority": "high", "medium", or "low"\n\nMax 8 insights. Focus on actionable patterns, not obvious observations. Return [] if the file list is too sparse for meaningful analysis.',
    },
    'discovery_assessment': {
        'display_name': 'Discovery Assessment',
        'description': 'Self-assessment discovery results analyzed by AI',
        'prompt_text': 'Analyze the source content as a self-assessment / discovery questionnaire.\n\nExtract: self-reported goals, challenges, priorities, and stated constraints.\nEach insight should be a concise, self-contained statement grounded in what the\nrespondent actually said.\n[Synthesized in-house from the Clearpath registry description — Clearpath computes\nthis type in the assessments module, not via a default extraction prompt.]',
    },
}


# ---------------------------------------------------------------------------
# Client factories (injectable — mirrors the MMRAG_GEMINI_CLIENT_FACTORY idiom
# in mmrag.py; tests point the env hooks at fakes so nothing hits the network).
# ---------------------------------------------------------------------------
def _load_factory(dotted_path, env_name):
    """Resolve a dotted import path to a callable.

    Accepts 'pkg.mod.attr' or 'pkg.mod:attr'. The colon form is unambiguous
    when the attribute name collides with a submodule name, so it is preferred.
    """
    if ":" in dotted_path:
        module_path, _, attr_path = dotted_path.partition(":")
    else:
        module_path, _, attr_path = dotted_path.rpartition(".")
    if not module_path or not attr_path:
        raise ValueError(
            f"{env_name} {dotted_path!r} must be 'module.attr' or 'module:attr'"
        )
    import importlib
    obj = importlib.import_module(module_path)
    for part in attr_path.split("."):
        obj = getattr(obj, part)
    if not callable(obj):
        raise TypeError(
            f"{env_name} {dotted_path!r} resolved to non-callable {type(obj).__name__}"
        )
    return obj


def get_gemini_client():
    """Construct a Gemini client.

    Default lazily imports google.genai and returns genai.Client() (reads
    GEMINI_API_KEY from env). To inject a fake, set INTEL_GEMINI_CLIENT_FACTORY
    to a dotted import path of a zero-arg callable returning an object with a
    .models.generate_content(model=..., contents=...) shape.
    """
    factory_path = os.environ.get("INTEL_GEMINI_CLIENT_FACTORY")
    if factory_path:
        return _load_factory(factory_path, "INTEL_GEMINI_CLIENT_FACTORY")()
    from google import genai  # lazy: module must import without this package
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set (required for Gemini-tier categories)")
    return genai.Client(api_key=api_key)


def get_anthropic_client():
    """Construct an Anthropic client.

    Default lazily imports anthropic and returns anthropic.Anthropic() (reads
    ANTHROPIC_API_KEY from env). To inject a fake, set
    INTEL_ANTHROPIC_CLIENT_FACTORY to a dotted import path of a zero-arg
    callable returning an object with a .messages.create(...) shape.
    """
    factory_path = os.environ.get("INTEL_ANTHROPIC_CLIENT_FACTORY")
    if factory_path:
        return _load_factory(factory_path, "INTEL_ANTHROPIC_CLIENT_FACTORY")()
    import anthropic  # lazy: module must import without this package
    return anthropic.Anthropic()


_CLIENT_FACTORIES = {
    "gemini": get_gemini_client,
    "anthropic": get_anthropic_client,
}


class _ClientPool:
    """Lazily construct one client per provider, honoring injected clients."""

    def __init__(self, clients=None):
        self._clients = dict(clients or {})

    def get(self, provider):
        if provider not in self._clients:
            self._clients[provider] = _CLIENT_FACTORIES[provider]()
        return self._clients[provider]


# ---------------------------------------------------------------------------
# Model calls + response parsing
# ---------------------------------------------------------------------------
INTEL_MAX_TOKENS = int(os.environ.get("INTEL_MAX_TOKENS", "4096"))


def _call_model(client, provider, model, prompt):
    """Dispatch a single extraction prompt and return the raw text response."""
    if provider == "gemini":
        response = client.models.generate_content(model=model, contents=prompt)
        return getattr(response, "text", "") or ""
    if provider == "anthropic":
        response = client.messages.create(
            model=model,
            max_tokens=INTEL_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        parts = getattr(response, "content", None) or []
        return "".join(getattr(part, "text", "") or "" for part in parts)
    raise ValueError(f"unknown provider: {provider}")


def build_prompt(key, source_name, text):
    """Compose the ported Clearpath prompt with the source content and a
    machine-readable output instruction."""
    entry = REGISTRY_BY_KEY[key]
    prompt_def = PROMPTS[key]
    primary = entry["primary_field"] or "content"
    fields = [f'"{primary}" (string, required)']
    if entry["person_field"]:
        fields.append(f'"{entry["person_field"]}" (string, optional)')
    return (
        f"{prompt_def['prompt_text']}\n\n"
        f"SOURCE: {source_name}\n"
        f"--- BEGIN SOURCE CONTENT ---\n{text}\n--- END SOURCE CONTENT ---\n\n"
        "OUTPUT FORMAT: Return ONLY a JSON array (no prose, no code fences). "
        f"Each element is an object with {', '.join(fields)}. "
        "Return [] if nothing qualifies."
    )


_FENCE_RE = re.compile(r"^```[a-zA-Z]*\n|\n?```$")


def parse_extraction_response(key, raw_text):
    """Parse a model response into a list of (content, person) tuples.

    Tolerates code fences and prose-wrapped JSON; falls back to treating the
    whole response as a single extraction if it is not parseable JSON.
    """
    entry = REGISTRY_BY_KEY[key]
    primary = entry["primary_field"] or "content"
    person_field = entry["person_field"]

    text = _FENCE_RE.sub("", (raw_text or "").strip()).strip()
    if not text:
        return []

    parsed = None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
            except (json.JSONDecodeError, ValueError):
                parsed = None

    if parsed is None:
        return [(text, None)]
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return [(str(parsed), None)]

    items = []
    for item in parsed:
        if isinstance(item, dict):
            content = item.get(primary) or item.get("content")
            if content is None:
                content = json.dumps(item, ensure_ascii=False)
            person = item.get(person_field) if person_field else None
            items.append((str(content), str(person) if person else None))
        elif item is not None and str(item).strip():
            items.append((str(item), None))
    return items


# ---------------------------------------------------------------------------
# Extraction pipeline
# ---------------------------------------------------------------------------
def resolve_categories(spec):
    """'all' or 'key,key' → validated list of registry keys."""
    if not spec or spec.strip().lower() == "all":
        return list(REGISTRY_KEYS)
    keys = [k.strip() for k in spec.split(",") if k.strip()]
    unknown = [k for k in keys if k not in REGISTRY_BY_KEY]
    if unknown:
        raise ValueError(
            f"unknown categories: {', '.join(unknown)} (valid: {', '.join(REGISTRY_KEYS)})"
        )
    return keys


def extract_file(path, categories, clients=None, now=None):
    """Run per-category extraction over one source file.

    Returns a list of records:
    {category, content, person, source_file, extracted_at, model}.
    Per-category failures are isolated with the `SKIP (error): ...` convention
    so one bad category (or provider outage) never sinks the rest.
    """
    pool = clients if isinstance(clients, _ClientPool) else _ClientPool(clients)
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    source_name = os.path.basename(path)
    extracted_at = now or datetime.now(timezone.utc).isoformat()

    records = []
    for key in categories:
        route = route_model(key)
        try:
            client = pool.get(route["provider"])
            raw = _call_model(client, route["provider"], route["model"],
                              build_prompt(key, source_name, text))
            for content, person in parse_extraction_response(key, raw):
                records.append({
                    "category": key,
                    "content": content,
                    "person": person,
                    "source_file": str(path),
                    "extracted_at": extracted_at,
                    "model": route["model"],
                })
        except Exception as exc:  # noqa: BLE001 — per-category isolation by design
            print(f"  SKIP (error): {key}: {exc}")
            continue
    return records


def extract_paths(paths, categories, clients=None):
    """Extract every category from every source path. Returns
    {source_path: [records]} preserving input order."""
    pool = _ClientPool(clients)
    results = {}
    for path in paths:
        try:
            results[str(path)] = extract_file(path, categories, clients=pool)
        except OSError as exc:
            print(f"  SKIP (error): {path}: {exc}")
            results[str(path)] = []
    return results


# ---------------------------------------------------------------------------
# Output rendering (kb-ingest-shaped)
# ---------------------------------------------------------------------------
def _stem(path):
    base = os.path.basename(str(path))
    return os.path.splitext(base)[0] or "source"


def write_jsonl(records, out_path):
    with open(out_path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def render_markdown(source_path, records):
    """Markdown rendering of one source file's extractions, grouped by
    display category then key — shaped for kb-ingest consumption."""
    lines = [f"# Intelligence — {os.path.basename(str(source_path))}", ""]
    by_key = {}
    for record in records:
        by_key.setdefault(record["category"], []).append(record)
    for entry in CATEGORY_REGISTRY:
        key = entry["key"]
        if key not in by_key:
            continue
        lines.append(f"## {entry['label']} ({key})")
        lines.append("")
        for record in by_key[key]:
            person = f" — {record['person']}" if record.get("person") else ""
            lines.append(f"- {record['content']}{person}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_arg_parser():
    parser = argparse.ArgumentParser(
        prog="intel_extractor.py",
        description="Clearpath 26-category intelligence extraction, in-house.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    extract = sub.add_parser("extract", help="Extract intelligence from transcripts/docs")
    extract.add_argument("paths", nargs="+", help="Transcript or document paths")
    extract.add_argument("--categories", default="all",
                         help="'all' or comma-separated registry keys (default: all)")
    extract.add_argument("--out", required=True, help="Output directory")
    extract.add_argument("--json", action="store_true",
                         help="JSONL only — skip the per-source markdown rendering")
    return parser


def cmd_extract(args):
    try:
        categories = resolve_categories(args.categories)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 2

    missing = [p for p in args.paths if not os.path.isfile(p)]
    if missing:
        print(f"ERROR: not a file: {', '.join(missing)}")
        return 2

    os.makedirs(args.out, exist_ok=True)
    total = 0
    for source_path, records in extract_paths(args.paths, categories).items():
        stem = _stem(source_path)
        jsonl_path = os.path.join(args.out, f"{stem}.intel.jsonl")
        write_jsonl(records, jsonl_path)
        wrote = jsonl_path
        if not args.json:
            md_path = os.path.join(args.out, f"{stem}.intel.md")
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(render_markdown(source_path, records))
            wrote += f" + {md_path}"
        print(f"{source_path}: {len(records)} extraction(s) -> {wrote}")
        total += len(records)
    print(f"DONE: {total} extraction(s) across {len(args.paths)} source file(s)")
    return 0


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    if args.command == "extract":
        return cmd_extract(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
