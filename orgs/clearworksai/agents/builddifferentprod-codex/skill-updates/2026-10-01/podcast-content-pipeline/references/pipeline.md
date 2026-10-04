# Episode Pipeline

## Stage Map

| Stage | Required input | Primary output | Exit gate |
|---|---|---|---|
| 0. Episode strategy | prior performance, audience needs, topic candidates | topic thesis, promise, recurring segments, content hypotheses | strategy receipt and owners recorded |
| 1. Friday prep | current research and source hierarchy | host brief for Monday 2 PM recording | Friday 3:30 PM delivery; freshness checks queued |
| 2. Capture | Riverside project/recording | recording receipt | participants/tracks/project identity confirmed |
| 3. Source intake | authorized project access | immutable original archive | native video, isolated WAV, transcript and checksums verified |
| 4. Transcript intelligence | verified transcript/audio | corrected transcript, chapters, claims, selects | speaker/timestamp/source review passed |
| 5. Editorial direction | transcript intelligence, real source playback, and strategy | rhetorical map, protected keep zones, ranked cold opens, block-removal bundles, approved plan hash | source-playback and producer approval passed; no ASR timestamps authorized as cuts |
| 6. Riverside-native dialogue edit | native synchronized participant tracks and approved proposal | approved Riverside dialogue master, clean audio master, transcript | Riverside timeline review plus technical and human playback QC passed |
| 7. Master/metadata | approved Riverside edit | exact video/audio masters, transcript, chapters, metadata | exact-master and perceptual gates passed |
| 8. Short-form editorial | approved master and final transcript | one-claim arcs, exact endpoints, approved boundary-ledger hash | surrounding playback and producer endpoint approval passed |
| 9. Short-form production and lane derivation | approved boundary ledger and masters | rendered clips plus isolated lane packages | each output matches its ledger and passes its own brand/playback gate |
| 10. Repurposing/copy | approved master and content hypotheses | platform-native content bank and approved copy | one repurposing route selected; copy gates passed |
| 11. Distribution | approved assets and authority | RSS/video/social/email receipts | visible destination read-back matches approved version |
| 12. Learning loop | platform analytics, feedback, and production corrections | performance note and updated hypotheses | findings attached to episode and next prep |

## Stage 1: Friday Prep

Adapt the canonical Office Hours mechanism for Build Different. Default cadence for a Monday 2:00 PM Pacific recording:

- Friday by 3:30 PM: deliver the source-backed prep package.
- Monday 11:00 AM: refresh time-sensitive facts and links.
- Monday 1:45 PM: host check for last-minute changes.

Prep is internal until Josh authorizes any external contact or schedule mutation.

## Standard Monday-to-Wednesday Cadence

Use this as the recurring Build Different operating schedule unless the episode brief records an exception. The default content package is video-first; do not create routine text-only posts.

### Friday before recording

- 3:30 PM Pacific: deliver the research and host prep brief.
- Producer reviews topic, angle, source links, and claims that need checking.

### Monday — recording and first assembly

- 11:00 AM: refresh time-sensitive research.
- 1:45 PM: final host check.
- 2:00 PM: record in Riverside.
- By 3:30 PM: verify recording identity, participant tracks, transcript, and separate assets.
- By 5:00 PM: finish source playback, rhetorical map, protected keep zones, ranked cold opens, and block-level dialogue bundles.
- By 6:00 PM: producer approves the exact editorial-plan hash. Short-form endpoints are not locked until the full master exists.

### Tuesday — edit, masters, and review

- 8:00 AM: resolve approved cuts to Riverside word IDs and validate the exact revision-bound plan.
- 9:00 AM: producer approves that exact plan.
- 9:15 AM: apply it in Riverside and produce the revision-diff receipt.
- 10:00 AM: producer reviews dialogue joins and timeline continuity.
- By noon: apply approved smart mutes, intro/outro, captions, layout, brand, and chapters.
- By 2:00 PM: create the full video master and podcast-audio master.
- By 3:00 PM: finish transcript, show notes, keywords, people, chapters, thumbnail, and destination copy.
- By 3:30 PM: complete short-form editorial review, including five seconds around each proposed endpoint, one-claim arcs, excluded tails, and producer-approved boundary-ledger hash.
- By 4:00 PM: render the strongest launch clip and remaining approved vertical clips exactly from that ledger.
- 4:00–5:00 PM: complete headphone, visual, and full-master review.
- By 6:00 PM: make bounded corrections and upload final private versions for processing.

### Wednesday — release

- 7:00 AM: verify processing, captions, chapters, descriptions, links, people, transcript, and exact uploaded files.
- 8:00 AM: obtain exact-destination approval.
- 9:00 AM: publish the full episode to Transistor/RSS and YouTube.
- 9:15 AM: publish the strongest approved vertical clip on Build Different channels.
- 10:00 AM: complete destination read-back and release receipts.

If the exact final master is not approved Tuesday, do not rush a broken Wednesday release. Approve an explicitly reduced scope or move the release; never skip QA to preserve the calendar.

## Stage 3: Source Intake

Inventory every participant and asset class before downloading. Prefer native participant tracks over editor-preview media. For each source record provider ID, participant, asset type, native properties, byte size, checksum, retrieval time, and protected source reference.

For Riverside, use the deterministic procedure in [riverside-source-acquisition.md](riverside-source-acquisition.md). A menu click or browser transfer entry is not a completed asset. The exit gate requires a finished local file and a successful media probe.

Recommended Drive structure:

```text
Episode NNN/
  01 Source/Riverside Originals/
  02 Transcript and Editorial/
  03 Masters/
  04 Build Different/
  05 Clearworks Josh/
  06 AllSafe Bones/
  07 Distribution Receipts/
  08 Analytics/
```

## Stage 4–6: Editorial and Master

The `podcast-editorial-director` owns what the conversation should become. The `riverside-dialogue-editor` owns only safe implementation of the approved plan. A skill must not propose an editorial decision and certify its own execution.

- Correct transcript errors without rewriting the speaker's meaning.
- Keep source timecodes for every selected quote.
- Resolve claims that need evidence before copy or publication.
- Treat a Google Doc or producer brief as source editorial intent. Normalize it into sentence-level keep/remove proposals with speaker, complete quoted text, contextual rationale, and output target. Do not emit executable speech timestamps from ASR.
- Before any cut list, create a rhetorical map and protected keep zones. Prefer block-level removal of a complete argument, repeated setup, digression, transition, or abandoned example over automatic filler/pause deletion.
- For every proposed removal, record the exact retained sentence before and after the seam plus dependencies such as pronouns, acknowledgments, questions, propositions, and visual references. Use `risk_if_cut`, not an ambiguous generic risk label.
- Rank cold opens only after grammatical completeness, antecedent integrity, authentic tension/payoff, and source-playback editability pass. Hook strength and duration come later. Prefer one contiguous passage; multiple internal joins require explicit approval and seam-by-seam playback. `No cold open` is valid.
- When no brief exists, generate the editorial proposal from the verified transcript and native sources, applying the governing show/brand rules. The proposal is applied in Riverside's synchronized multitrack editor and reviewed there before export.
- Use Riverside MCP as the default execution path for approved dialogue edits: read the current aligned transcript and timeline revision; resolve every approved phrase selection to revision-scoped word IDs; dry-run validate the exact ordered plan; report ranges, projected runtime, warnings, and plan hash; obtain approval of that exact plan; apply against the unchanged revision; compare before/after revisions; then stop for human playback review.
- If the revision changes after validation, discard the plan hash, re-read the edit, resolve the selections again, and revalidate. Never apply a stale plan or substitute approximate times.
- Use Riverside-native smart mutes to suppress inactive microphones only when approved, and verify the resulting revision. Do not silently add Magic Audio, filler removal, pause removal, layout changes, or other AI features to the same operation.
- After the dialogue timeline is approved, Riverside MCP may apply the approved caption preset, brand/layout settings, chapters, text/overlays, and create exports. Read export status to completion and inspect the actual output before advancing state.
- For Build Different short-form posts, Riverside ends at the completed edit/export. Acquire and verify the exact approved export, save it to the canonical Google Drive publishing folder, and record the Drive asset ID/location, checksum, and approved version. Blotato then publishes that exact Drive-bound asset with the approved destination-specific copy, account, visibility, and timing. Riverside social-account connectivity is irrelevant to this handoff, and direct Riverside social publishing is noncanonical. A successful Blotato submission is not proof that the post is live; require terminal destination status and read-back.
- Treat timestamps in a creative brief or transcript as navigation regions only. The Riverside/native editor owns waveform-safe boundaries, handles, crossfades, and synchronized participant tracks. Never enter or exit mid-word, mid-sentence, dangling conjunction, or response antecedent.
- Validate the Riverside edit against the intended complete source phrases. Resolve overlaps, impossible cuts, speaker discontinuities, missing question/answer context, dangling conjunctions, and name errors before export.
- Treat transcript editing as rough assembly. Refine dialogue in/out points on the Riverside waveform/timeline, preserving clean handles and listening back after every removal. Never infer a clean cut from transcript text alone.
- Treat any prior episode reduction percentage as calibration, never a target. Preserve laughter, pauses, and short reactions when they carry chemistry or turn-taking.
- Apply an editorial entry test to every cold open, chapter entry, and splice-in: the first audible phrase must be grammatical, context-complete, and rhetorically strong. Remove redundant lead-ins such as “I think,” “I mean,” “so,” or “you know” when they do not carry meaning, while preserving breaths and hesitations that support natural delivery.
- Apply an antecedent test to every response-led entry. If the first words agree, disagree, answer, or react (“absolutely,” “yes,” “right,” “exactly,” “I agree,” laughter, or similar), the rendered listener must hear the question/proposition being answered. A complete sentence after the reaction does not cure a missing antecedent. Preserve the setup, enter on a later self-contained clause, or reject the select.
- Use short equal-power audio crossfades at hard dialogue joins (normally 50–120 ms, adjusted to the material). Use J/L cuts or reaction-shot cover when a simultaneous audio/video cut makes the conversation feel abrupt; on speaker changes, let the visual anticipate the next voice when appropriate.
- Build both the conversational and tight Riverside assemblies when the editorial brief calls for comparison; use review feedback to lock the canonical Riverside edit.
- Export the approved Riverside dialogue master and reusable clean selects before downstream lane decoration where practical.
- Render directly from native participant video and isolated WAV, choosing two-shot, active speaker, reaction shot, punch-in, chapter card, or restrained supporting visual according to the editorial/continuity rule. Keep captions/title layers editable.
- Preserve untouched isolated WAV by default. If processing is proposed, create a short isolated A/B first. For every speaker, audition representative opening, middle, and ending passages and record tonal balance, low-frequency buildup/boom, intelligibility, noise/room tone, dynamics, pumping/warble, and peak/loudness evidence. Match voices for perceived weight and clarity; shared LUFS targets alone do not prove a matched mix. Never uniformly amplify and continuously sum inactive microphones.
- Compile separate platform timelines from the canonical EDL. The video master may contain visual title/chapter/end cards, but the podcast-audio master must replace those ranges with spoken identity, music, or a deliberate short transition. Never pass silent visual-card duration through to an audio-only file. Recalculate chapters and duration from the audio timeline.
- QC with probes plus human playback: resolution, frame rate, sample rate, loudness, clipping, echo/phase, sync, crop, captions, spelling, safe areas, and beginning/end frames.
- Produce a boundary ledger for every edit point. For each transition, inspect or play at least the final two seconds before the cut and first three seconds after it in the rendered master. Record PASS/FAIL for complete speech, preserved question/answer context, audio continuity, visual continuity, caption continuity, and absence of flash/black frames. Automated decode/probe PASS does not satisfy this gate.
- Independently transcribe the first 5–8 rendered seconds of every cold open and each rendered boundary window. Compare that ASR result with the expected source text and visible caption text. An audible word missing from captions—or a captioned word absent from audio—is a hard failure unless the artifact is explicitly designated non-verbatim.
- Review the final rendered beginning, title-to-body transition, every chapter transition, and ending in real time. A master is not review-ready while any boundary-ledger row is unreviewed or failed.
- Perform a final real-time listen to the exact deliverable files, not a proxy timeline. At minimum, review each speaker's first sustained passage, every cut boundary, every title/chapter/end transition, and the full audio-only opening and ending. For a first release or any materially revised mix, listen through the entire podcast-audio master. Record reviewer, asset checksum, playback route, findings, and PASS/FAIL. Hearing no defect is release evidence only when tied to the exact checksum.
- After upload, repeat the perceptual gate against the exact destination version. A ready-state/playback probe cannot substitute for Josh/Mrin listening to the uploaded version. Publication remains fail-closed until that decision is recorded.

### Direct-edit deliverables

For each locked episode, preserve:

- editorial brief (human-readable);
- compiled EDL/timeline (machine-readable);
- source and render manifests with checksums;
- reusable project/render script or project file;
- conversational/tight review assemblies when requested;
- locked 16:9 video master and audio-only podcast master;
- transcript/captions, chapters, show notes, cover/title assets, and lane derivatives;
- QC, review, approval, and distribution receipts.

## Stage 7: Lane Router

Before rendering short-form derivatives, `podcast-short-form-editorial` must lock one claim per clip, the exact complete opening and ending sentences, the first complete payoff, and the excluded tail. Review at least five seconds before and after every proposed endpoint. Duration is a guardrail, not a quota. Production may not move those boundaries without a new producer-approved ledger hash.

For broader derivative content, choose one route: Altari Content Repurposing Manager for a full multi-format campaign, or Blotato Repurpose for an explicitly requested fixed quick batch. Never run both as redundant passes. Viral Hooks may advise safe cold-open candidates or post-lock overlay text; Post Grader evaluates written copy, not spoken boundaries.

Read only the requested lane authority file, then create an independent package:

### Build Different

Podcast-first show identity. Favor episode narrative, guest insight, show discovery, listening/viewing CTA, and consistent episode branding.

The default derivative package is video-first: three to five approved short videos per episode, led by 9:16 vertical versions for LinkedIn, Instagram, TikTok, YouTube Shorts, and Facebook. Create 1:1 or 4:5 variants only when the destination placement materially benefits. Do not add routine text posts; a quote graphic or carousel is optional and must be earned by the material rather than included as a quota.

Default release cadence: strongest clip on Wednesday with the episode, clip two Thursday, clip three Friday, clip four the following Monday, and clip five Tuesday only when another strong standalone moment exists. Reuse evergreen clips later when the topic becomes timely again.

### Josh/Clearworks

Founder/operator point of view. Favor Josh's insight, video-first social, practical construction/AI leadership relevance, and Clearworks-appropriate CTA.

### Bones/AllSafe

Guest/company authority. Favor Bones's exact perspective, AllSafe relevance, and its own brand/approval rules. Never imply AllSafe approval from Build Different approval.

Each package should include the selected master/clip, platform variants, captions, thumbnail/cover where needed, copy, CTA, source evidence, version, and approval status.

## Stage 8–9: Approval and Distribution

Approval attaches to an exact asset version, copy version, audience, destinations, and timing. A revised asset invalidates prior approval when the change is material.

### Full-episode audiovisual release gate

For Build Different, an episode launch is one atomic outcome across Transistor and YouTube. Do not call the episode live, launched, complete, or published everywhere until the approved video is terminally public on the Build Different YouTube channel, that exact URL is saved in Transistor's `youtube_url`, and the public Transistor episode page visibly renders the playable embed. Immediately before final launch completion, read back and record all of the following:

- exact approved video master checksum/version and completed YouTube processing;
- exact approved audio master checksum/version and completed Transistor audio processing;
- isolated-stem perceptual QC, voice-match QC, response-entry context QC, platform-specific audio timing QC, and final perceptual playback receipts tied to the approved checksums;
- final title, a blank deprecated Episode Summary, episode-specific keywords, and a full HTML description with readable paragraph/section spacing;
- complete chapter list with `00:00` first, ascending timestamps, platform-valid spacing, Transistor native chapter records, and clickable chapter links after destination rendering;
- Clearworks.ai and AllSafe IT links in the final description;
- assigned people/credits and transcript/captions;
- terminal YouTube video ID/URL on the Build Different channel;
- exact Transistor `youtube_url` read-back matching that live video;
- public Transistor-page visual verification of the playable video embed;
- exact approval authorizing publication of that complete release version; and
- live episode page, RSS entry, media playback, chapter links, description links, and mobile/desktop destination read-back.

If any item is missing, stale, still processing, or points to a superseded asset, keep or return the episode to draft when that remains safely possible and report the exact partial state. If Transistor audio was already published, never describe the launch as complete: finish or explicitly block the YouTube-and-embed recovery lane. “Publish both,” “put them on Transistor,” or similar shorthand does not waive this completeness gate.

Default architecture unless Josh changes it:

- Riverside: capture, collaboration, transcript/editor operations.
- Google Drive: canonical originals, approved masters, and receipts.
- Transistor: single RSS/feed distribution and initial show website.
- Native video destinations: publish directly where platform-specific video is required.
- Social/email: lane-specific accounts only after the correct approval.

For short-form social delivery, enforce that ownership as a hard handoff: `Riverside export ID -> verified file checksum -> Google Drive asset ID/location -> approved platform payload -> Blotato submission/post ID -> terminal destination receipt`. Stop at the first missing field. Do not substitute another render or another transport to protect a posting deadline.

After publishing, read back the visible destination. Record URL/ID, timestamp, account, version checksum, and publisher identity.

### Show channel bootstrap

Create or claim distribution destinations as brand-owned Build Different properties rather than personal publishing lanes. Keep Transistor as the single RSS authority.

- YouTube: create a Build Different channel, retain Josh as owner, assign collaborators only at the requested manager/admin level, and connect the channel to the native-video workflow. A human identity or phone verification is a real human gate; record it without replacing the brand channel with a personal channel.
- Spotify for Creators and Apple Podcasts Connect: claim/submit the canonical Transistor RSS after the feed contains its first published episode, then verify ownership and listing state from the destination.
- Other podcast directories: submit through Transistor's Distribution surface when available; never create a second feed.
- Store show-level channel URLs, account ownership, role assignments, verification status, and connection receipts separately from episode metadata. Reuse the approved show identity; channel setup does not require unique per-platform editorial workflows.

## Stage 10: Learning

Collect comparable metrics at defined windows, such as 24 hours, 7 days, and 30 days. Separate creative hypotheses by lane and format. Feed supported findings into the next episode brief; do not rewrite durable brand rules from a single post.
