---
name: podcast-content-pipeline
description: Orchestrate a podcast episode from prep and source intake through editing, three isolated brand-content lanes, approval, distribution, and performance learning. Use for Build Different episodes and their Build Different, Josh/Clearworks, and Bones/AllSafe derivatives.
---

# Podcast Content Pipeline

Run one resumable episode workflow while preserving three independent publishing lanes. The agent owns the default source-to-release execution: acquire originals, create and compile the editorial plan, edit and render masters/derivatives, QC, archive, distribute when authorized, and learn from results. Treat every stage as a contract: consume verified inputs, produce named outputs and a receipt, and stop when its exit gate is not met.

## Governing Sources

Before acting, read the local governing Build Different handoff and episode checklist. When producing lane-specific content, also read only that lane's authority file:

- Build Different: `context/build-different-prod-handoff/reference-kit/lane-1-build-different.md`
- Josh/Clearworks: `context/build-different-prod-handoff/reference-kit/lane-2-josh-clearworks.md`
- Bones/AllSafe: `context/build-different-prod-handoff/reference-kit/lane-3-bones-allsafe.md`

The governing handoff outranks this orchestration skill for brand facts and source-specific rules. New direct instructions from Josh or Mrin outrank both within their authorized scope.

## Operating Model

Create one episode run directory and an `episode-state.json` ledger using [references/state-contract.md](references/state-contract.md). Use stable episode and asset IDs. Never use filenames, chat history, or memory alone as workflow state.

Execute the stages in [references/pipeline.md](references/pipeline.md). For Riverside source intake, follow [references/riverside-source-acquisition.md](references/riverside-source-acquisition.md). A stage may run concurrently only when its declared inputs are already verified and it does not mutate another stage's assets. Record:

- inputs and source checksums;
- action taken and tool/version when material;
- outputs, checksums, and storage locations;
- QC evidence and reviewer;
- approval or publication receipt;
- failure, retry count, and exact resume point.

At the start of each run, identify the current user-visible critical path and record it in the episode state. Protect that path from optional research, tooling experiments, and non-blocking architecture work. Re-evaluate it only when the active stage completes, fails a gate, or becomes genuinely blocked; otherwise finish the expected deliverable before starting optimization work.

## Chained Skills

This skill is the controller. For every new episode, invoke the stage skills in order and require the named receipt before advancing:

1. `podcast-episode-strategy` → evidence-backed topic, audience promise, recurring segments, recording plan, and content hypotheses.
2. `podcast-prep-source-intake` → verified recording brief and immutable source receipt.
3. `podcast-editorial-director` → rhetorical map, protected context, ranked cold opens, block-removal bundles, source-playback receipt, and approved editorial-plan hash.
4. `riverside-dialogue-editor` → revision-bound implementation diff and approved native playback receipt. It may not expand the editorial plan.
5. `podcast-master-metadata` → approved video/audio masters plus complete metadata/QC package.
6. `podcast-short-form-editorial` → approved one-claim clip arcs and boundary-ledger hash.
7. `podcast-short-form-video` → rendered and playback-verified short-form package matching the approved ledger, with the exact completed export verified and stored as the canonical approved master in Google Drive before distribution.
8. Repurposing/copy → use Altari Content Repurposing Manager for the full content universe OR Blotato Repurpose for an explicitly requested fixed quick batch, never both. Use Altari Social Copywriter for clip captions and Blotato Post Writer for standalone written posts; apply Post Grader and Humanizer as copy gates. Store one exact approved payload per platform rather than treating a generic caption as universal: LinkedIn needs a strong truthful first-line hook and approved publishing page, Instagram needs reel-native copy/hashtags, and YouTube needs an approved title, visibility, and subscriber-notification setting.
9. `podcast-distribution` → terminal destination read-back receipts for every authorized release, using Blotato Post Scheduler as the canonical Build Different short-form transport. Riverside owns editing/export, Google Drive owns canonical approved masters/receipts, and Blotato owns the public social submission; do not make Riverside social connectivity a distribution prerequisite.
10. `podcast-performance-loop` → 24-hour, 7-day, and 30-day learning receipts feeding the next brief, with Altari Content Performance Analyst as its evidence engine when available.

Persist every handoff in `episode-state.json`. A downstream skill must refuse to run when its required upstream receipt is missing, superseded, or attached to a different asset/revision. Do not collapse the chain into narrative status.

Content Coach is a conditional beginner ideation front door, not part of the canonical weekly podcast chain or a podcast-format grader. Brand Brief is a machine-readable snapshot beneath current brand authority. Blotato Generate is conditional supporting-visual/B-roll production with its own paid-run approval, never a replacement for authentic podcast footage. Altari Video Editor, Altari Short Form, and Altari Publishing Manager are noncanonical for Build Different; the Build Different-specific skills above contain the stricter source, editorial, QC, and release rules.

Before any Build Different Transistor publish mutation, run `scripts/validate_transistor_release.py <episode-state.json> --chapters <chapters.json> --metadata <metadata.json>`. When a Spotify-specific manual chapter map is part of the package, also pass `--spotify-chapters <chapters.json>`. Treat any non-zero result as a hard stop; never bypass it with conversational shorthand.

Never call a Build Different episode live, launched, complete, or published everywhere from the Transistor audio receipt alone. The same release package must contain a terminal public YouTube receipt for the exact approved video, Transistor `youtube_url` read-back matching that video, and a fresh public-page visual check proving the playable video embed renders. If any of those three is absent, report the episode as partially published and keep the launch task open.

Transistor metadata defaults are part of the release package, not optional cleanup: leave the deprecated Episode Summary blank; provide episode-specific keywords; format the HTML description as readable paragraphs and sections; include the canonical business links; attach the transcript; assign people/credits; and populate Transistor's native Chapters data from the canonical chapter map. A timestamp list in the description does not substitute for native chapters.

## Non-Negotiable Boundaries

1. Preserve originals. Archive native camera video, isolated WAV audio, transcript/captions, and project metadata before destructive editing. Work from copies.
2. Enforce source quality. Do not label an upscale as native resolution. Publication masters require native-resolution video and isolated lossless audio unless Josh explicitly accepts a documented exception.
3. Enforce cut-boundary integrity. ASR/transcript timestamps are navigation evidence, not executable dialogue boundaries. Never compile spoken cuts directly into ffmpeg/Remotion ranges. For Build Different, use Riverside MCP to read the aligned transcript and current revision, resolve approved selections to revision-scoped word IDs, validate the exact synchronized edit plan without saving, apply only the validated revision-bound plan, and compare the before/after revisions. Riverside remains the editing system of record; export an approved dialogue master only after native playback review. Before handoff, review the rendered transition window around every cut for clipped speech, lost context, audio discontinuity, and broken visual continuity; an encode, probe, transcript match, successful MCP response, or clean revision diff alone is not editorial QC.
   A response entry such as “absolutely,” “yes,” “right,” “exactly,” or “I agree” is invalid unless the listener hears enough of the preceding question or proposition to understand what it answers. Completing the responder's sentence is not sufficient context. Preserve the antecedent, choose a self-contained entry later in the response, or remove the response word with a verified natural-sounding cut.
4. Enforce rendered graphic fit. Test the longest title, chapter heading, persistent chapter slug, caption, lower third, and CTA in every rendered state—not just representative short strings. Reject clipping, overflow, unsafe margins, speaker obstruction, and unreadable scaling. Keep a rendered contact sheet showing every large and persistent chapter state.
5. Compile chapters from one canonical map. Store semantic chapter names plus the exact start for every final media variant. If the audio removes video-only cards or other ranges, derive—not copy—its timebase. Generate platform outputs from the map: Spotify/RSS description timestamps, YouTube chapters, persistent on-screen labels, and any native chapter format. Validate a 00:00 first entry, ascending times, at least three entries, and plain-text titles without emoji. Validate platform variants independently: Spotify requires 30 seconds between chapter starts, while YouTube requires 10 seconds. If an approved early chapter violates Spotify spacing, merge it only in the Spotify map; do not silently move the canonical editorial boundary.
6. Keep lanes isolated. Shared source moments may feed all three lanes, but brand voice, accounts, calls to action, approvals, asset folders, and publishing receipts never bleed across lanes.
7. Separate creation from publication. Drafting, rendering, private storage, and internal review do not authorize a public post, RSS release, email send, or third-party account change.
   Transistor supports one authoritative media file per episode feed item; replacing audio with video replaces the enclosure rather than preserving separate audio and video masters. Never claim that one Transistor episode simultaneously stores an optimized podcast-audio master and a separate video master. When platform timelines differ, choose and record one of two architectures before upload: (a) keep the approved audio-only master in Transistor/RSS and upload the approved video directly to YouTube or another native video destination; or (b) use the approved video as Transistor's single media file only after its embedded audio independently passes the podcast-audio gates, including removal of visual-only dead air. Do not mutate the same episode through the API while a dashboard media replacement is uploading or processing. For a dashboard replacement, freeze API writes, wait for processing to reach 100%, re-add native chapters, and read back people, transcript, description, links, and every destination before release.
8. Use one podcast RSS authority. Riverside may capture/edit; Google Drive preserves masters; Transistor is the default RSS/distribution authority once approved. Never create a second live RSS feed without an explicit architecture change.
9. Treat access links and media URLs as sensitive. Do not repeat or persist review tokens, share tokens, signed download URLs, or credentials in ordinary logs, copy, or public artifacts.
10. Stop on failed gates. Do not substitute a proxy, mixed audio, guessed transcript, missing approval, or narrative status for required evidence.
11. Build and QC platform-specific masters. Video, podcast audio, and social variants may share editorial substance but must not blindly share timing. Remove or replace visual-only title-card, chapter-card, end-card, and transition silence in audio-only outputs. Derive and verify each platform timeline independently.
12. Match voices perceptually, not only numerically. Process and audition each isolated speaker stem before mixing. Reject boominess, muddiness, harshness, room mismatch, noise, pumping, or a speaker-to-speaker tonal/level jump even when the integrated loudness and true-peak measurements pass.
13. Require a real-time perceptual release review. Technical probes, ASR, screenshots, and boundary ledgers support the review but cannot replace listening to the exact final video and exact final podcast-audio deliverables. No asset may be marked approved or published until the perceptual review receipt is complete.
14. Prove blind tests are blind at the file and destination layers. Neutral visible filenames are insufficient. Before delivery, strip and inspect embedded title, comment, encoder-specific, artwork, and custom metadata; use identical codecs, duration, loudness policy, excerpt, and delivery treatment unless the tested variable requires otherwise. Download each public review file through the exact reviewer link, confirm it is playable, checksum it against the intended asset, and verify that neither the Drive title/description nor the downloaded file reveals the tool, processing route, or source mapping. Do not call a set blind until this receipt exists.
15. Keep inactive microphones out of the program bed. Never uniformly amplify and continuously sum every isolated track. Verify speaker-aware muting/gating/crosstalk treatment through sustained passages, overlaps, breaths, laughter, and reactions; reject audible inactive-room noise beneath the active voice.
16. Prefer untouched isolated audio. Denoise, dereverb, AutoEQ, restoration, or dynamic leveling may replace a raw WAV only after a short isolated headphone A/B wins perceptually. Reject pumping, warble, watery modulation, or a moving noise floor regardless of LUFS or peak compliance.
17. Approval follows the exact uploaded artifact. Machine-ready playback, matching metadata, and prior approval of a local master do not authorize publication. The human perceptual decision must name the exact destination version/checksum being released.
18. Preserve the short-form handoff chain. A completed Riverside export is not yet a publishable handoff: verify the exact file, save it to the canonical Build Different Drive folder, record its Drive asset ID/location and checksum, then publish the approved platform payload through Blotato. Missing export or Drive evidence is a blocker; never replace it with a proxy, a prior render, direct Riverside social publishing, or an unapproved transport.

## Human Workflow

Work conversationally in `#build-different-prod` with Josh and Mrin. Give concise evidence-backed updates at meaningful state changes. Ask one focused question only when a missing choice would materially change the result.

### Slack formatting contract

Default every Build Different Slack update to properly formatted bullets, not prose blocks and not a “card” label. Put the actionable state first. Use short bold section headings only when the message needs more than one group, leave a blank line between groups, and keep one idea per bullet. Every bullet must occupy its own line and end with a newline; never place two bullet markers on the same rendered line. The default status shape is:

- `Status` — one bullet naming the current asset/version and state;
- `Done` — only material completed work;
- `Pending` — the exact remaining gate and owner;
- `Next` — the next action and timing;
- `Need from you` — include only when a real decision or action is required.

Keep routine updates to seven bullets or fewer. Do not repeat unchanged safeguards, hashes, IDs, or technical evidence in-channel; link the receipt or provide details only when requested. Never turn a simple status question into a workflow essay. Before sending, reject any message containing an unbroken paragraph longer than two sentences when bullets would carry the information more clearly.

For this agent, generate every Build Different Slack operational update as a structured message block and pass it through `scripts/send-slack-block.sh`; do not call `cortextos slack send` directly. The schema is `{ "title"?: string, "intro"?: string, "sections": [{ "heading"?: string, "bullets": string[] }], "closing"?: string }`. Every field contains semantic content only: no bullet markers, formatting newlines, or escaped newline text. The deterministic renderer owns bold headings, real line breaks, bullet markers, and spacing. Do not ask the language model to generate shell-ready Slack Markdown.

Example:

```bash
./scripts/send-slack-block.sh C0BSHQ1SZN0 <<'JSON'
{"title":"Status","sections":[{"bullets":["First update","Second update"]}]}
JSON
```

`scripts/send-slack-safe.sh` remains a compatibility backstop for legacy callers. Run the structured renderer and sender tests after changing format rules. Documentation lint is not render proof: do not call formatting fixed until the exact sent message has been visibly inspected in Slack or confirmed from a screenshot/read-back tied to that message.

Dialogue editing is a Riverside-native human-review workflow. An existing Google Doc/edit brief is editorial intent, not an executable timestamp list. When no brief exists, create a sentence-level proposal from the transcript and sources. The agent may execute approved removals through Riverside MCP, but only through the revision-safe sequence: read current aligned transcript and timeline, resolve transcript selections, dry-run validate the exact plan, show its ranges/runtime/warnings, obtain approval, apply against the same revision, compare revisions, and stop for Mrin/Josh playback review before export. Never translate ASR word times directly into speech cuts or bypass native review because the MCP accepted an operation.

Riverside MCP can also automate approved smart mutes, captions, brand/layout settings, chapters, text/overlays, export creation/status checks, and connected social-upload preparation. Treat each as a separate scoped operation with an expected revision and its own review gate. Do not enable Magic Audio or other proprietary cleanup merely because it is available. Riverside MCP does not replace immutable source archiving when it does not expose native participant downloads.

Use review gates proportional to impact:

- Mrin: editorial reviewer/approver who may apply or supervise the Riverside-native dialogue edit. Her review is required before the Riverside dialogue master is locked.
- Josh: brand direction, material claims, final release/publication authority unless explicitly delegated.
- Lane owner: final lane-specific brand and account approval when required.

## Completion

An episode is complete only when the state ledger shows:

- source archive verified;
- transcript and edit decisions versioned;
- approved masters and lane derivatives passed QC;
- isolated speaker stems passed perceptual tone/noise QC and the final mix passed speaker-to-speaker matching;
- every response-led edit entry preserves an audible antecedent or begins with a self-contained thought;
- video and audio-only masters have independently verified timing, with no visual-only dead air in the podcast master;
- the exact final video and audio-only files passed a documented real-time perceptual playback review;
- the dialogue edit was executed in Riverside's synchronized multitrack editor (or an explicitly approved professional NLE), with a receipt identifying the edit/version and human reviewer;
- inactive-mic treatment and any restoration chain passed a documented headphone review without pumping, warble, or room-noise buildup;
- the exact uploaded destination versions—not only local masters—received human perceptual approval;
- the recorded distribution architecture identifies which single approved media master Transistor contains and where the separate video master is hosted; the exact public YouTube URL is attached to Transistor, and the public Transistor page visibly renders its playable embed; the Transistor package also contains complete clickable chapter notes, final description, both business website links, people/credits, and transcript/captions;
- the Transistor episode has no deprecated summary, has episode-specific keywords, uses readable section/paragraph spacing, and exposes the canonical chapter map through native chapter metadata;
- authorized distribution receipts captured;
- canonical Drive folders contain originals, masters, captions, copy, and receipts;
- performance follow-up is scheduled or explicitly waived;
- reusable lessons were recorded without turning one-off failures into universal rules.
