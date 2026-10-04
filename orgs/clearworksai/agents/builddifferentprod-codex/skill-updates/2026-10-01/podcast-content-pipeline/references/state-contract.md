# Episode State Contract

Maintain `episode-state.json` as the machine-readable source of workflow truth.

## Minimum Shape

```json
{
  "schema_version": "1.0",
  "episode_id": "BD-E001",
  "title": "",
  "source_project": {
    "provider": "riverside",
    "project_id": "",
    "recording_id": "",
    "edit_id": "",
    "current_revision": null,
    "sensitive_reference_location": ""
  },
  "editorial_control": {
    "source_playback_receipt": null,
    "producer_instruction_timestamp": null,
    "editorial_plan_hash": null,
    "boundary_ledger_hash": null,
    "approved_master_checksum": null
  },
  "participants": [],
  "release_readiness": {
    "approved_video_asset_id": null,
    "approved_audio_asset_id": null,
    "video_processing_complete": false,
    "audio_processing_complete": false,
    "youtube_publication_complete": false,
    "transistor_youtube_url_attached": false,
    "transistor_video_embed_verified": false,
    "isolated_stem_qc_complete": false,
    "voice_timbre_match_verified": false,
    "contextual_entry_qc_complete": false,
    "platform_specific_audio_master_verified": false,
    "perceptual_playback_qc_complete": false,
    "dialogue_edit_engine_verified": false,
    "human_dialogue_edit_review_complete": false,
    "inactive_mic_qc_complete": false,
    "restoration_headphone_ab_approved": false,
    "exact_destination_perceptual_approval_complete": false,
    "chapters_complete": false,
    "chapter_links_verified": false,
    "native_chapters_verified": false,
    "description_complete": false,
    "description_format_verified": false,
    "summary_omitted": false,
    "keywords_complete": false,
    "business_links_verified": false,
    "people_credits_complete": false,
    "transcript_captions_complete": false,
    "publication_approval_id": null,
    "destination_readback_receipt": null,
    "youtube_live_video_id": null,
    "youtube_publication_receipt": null,
    "transistor_embed_readback_receipt": null
  },
  "stages": {
    "brief": {"status": "pending", "receipt": null},
    "prep": {"status": "pending", "receipt": null},
    "capture": {"status": "pending", "receipt": null},
    "source_intake": {"status": "pending", "receipt": null},
    "transcript": {"status": "pending", "receipt": null},
    "episode_strategy": {"status": "pending", "receipt": null},
    "editorial_direction": {"status": "pending", "receipt": null},
    "riverside_implementation": {"status": "pending", "receipt": null},
    "master_edit": {"status": "pending", "receipt": null},
    "short_form_editorial": {"status": "pending", "receipt": null},
    "short_form_production": {"status": "pending", "receipt": null},
    "repurposing_copy": {"status": "pending", "receipt": null},
    "lane_build_different": {"status": "pending", "receipt": null},
    "lane_clearworks": {"status": "pending", "receipt": null},
    "lane_allsafe": {"status": "pending", "receipt": null},
    "approval": {"status": "pending", "receipt": null},
    "distribution": {"status": "pending", "receipt": null},
    "learning": {"status": "pending", "receipt": null}
  },
  "assets": [],
  "short_form_handoffs": [],
  "approvals": [],
  "distribution_receipts": [],
  "riverside_edit_receipts": {
    "transcript_revision": null,
    "approved_selection_ids": [],
    "validated_plan_hash": null,
    "applied_from_revision": null,
    "applied_to_revision": null,
    "revision_diff_receipt": null,
    "native_playback_review_receipt": null
  },
  "resume": {"next_stage": "brief", "blocker": null}
}
```

## Asset Record

Each asset record should include:

- `asset_id`, `episode_id`, and `lane` (`source`, `build-different`, `clearworks`, or `allsafe`);
- `kind`, `version`, `status`, and parent/source asset IDs;
- local and canonical storage locations;
- size and SHA-256 (plus provider checksum where available);
- media properties relevant to QC;
- creation/retrieval timestamp and tool;
- sensitivity classification;
- QC and approval receipt IDs.
- versioned EDL source-cue text for every spoken boundary;
- rendered boundary-ledger receipt covering every cut, chapter transition, title-to-body transition, and final frame.
- independent rendered ASR and visible-caption parity receipt for cold opens and spoken boundaries.
- isolated-stem perceptual QC receipts covering low-frequency buildup, intelligibility, room/noise, dynamics, and representative passages for every speaker;
- a speaker-to-speaker perceptual match receipt tied to the final mix checksum;
- an antecedent/context receipt for every response-led cold open, chapter entry, and splice-in;
- separate video and audio-only timeline receipts proving visual-only silence was removed or deliberately replaced and chapter timebases were derived independently;
- a final real-time perceptual playback receipt naming the exact asset checksum, reviewer, playback route, reviewed scope, findings, and PASS/FAIL.
- Riverside/native-editor edit ID and version plus the reviewer who approved the synchronized dialogue timeline;
- inactive-mic treatment receipt covering sustained speech, overlap, laughter, breaths, and room-noise buildup;
- restoration headphone A/B receipt, or an explicit receipt that untouched isolated WAVs were retained;
- exact-destination perceptual approval receipt tied to the uploaded platform version.
- the approved editorial-plan hash, producer instruction timestamp, boundary-ledger hash, and exact approved-master checksum that authorize the asset.

Never store a tokenized share URL or signed media URL directly in this ledger. Store only a protected reference location.

## Short-Form Handoff Record

For every Build Different short authorized for distribution, record:

- Riverside edit ID, revision, completed export ID, and exact exported filename;
- verified file size, duration/media properties, and SHA-256;
- canonical Google Drive asset ID/location, stored filename, and approval receipt tied to that exact checksum;
- platform-specific approved copy/payload IDs, exact Blotato account and subaccount/page IDs, visibility, and timing;
- Blotato submission/post ID and terminal destination ID/URL or exact failure.

The handoff is incomplete until the exact export has been verified and stored in Drive. Riverside social-account state cannot satisfy or block this record because Riverside is not the Build Different short-form publishing transport.

## Status Values

Use `pending`, `in_progress`, `blocked`, `review`, `approved`, `published`, `complete`, or `superseded`. Include an exact blocker and resume action whenever status is `blocked`.

## Receipt Requirements

A receipt must be evidence, not prose alone. Depending on stage, include checksums, probe output, reviewer decision, visible destination read-back, message ID, provider object ID, or test result. Redact credentials and sensitive tokens.

Publication is forbidden while any `release_readiness` field is false or null. A completed audio upload is not evidence that the approved visual master is present, and a prior approval does not attach to a newly revised asset version.

For Build Different, `youtube_publication_complete` requires the exact approved full-episode video to be terminally public on the Build Different YouTube channel. `transistor_youtube_url_attached` requires Transistor's saved `youtube_url` to equal that live video URL. `transistor_video_embed_verified` requires a fresh public Transistor-page read-back showing a playable video embed for that same YouTube video. API acceptance, a non-null URL, or a live YouTube page alone cannot satisfy the embed gate.

`dialogue_edit_engine_verified` requires evidence that conversational speech edits were executed in Riverside's synchronized multitrack editor or an explicitly approved professional NLE; ASR-to-ffmpeg speech timelines cannot set it true. `human_dialogue_edit_review_complete` requires review of the actual joined Riverside/NLE timeline, not the edit brief. `inactive_mic_qc_complete` requires sustained-passages evidence that inactive rooms are not audible beneath the active speaker. `restoration_headphone_ab_approved` is true only when a processed isolated stem beat the untouched WAV on headphones; when no restoration is used, record the raw-retained receipt and set it true. `exact_destination_perceptual_approval_complete` requires human approval of the uploaded destination version.

`isolated_stem_qc_complete` and `voice_timbre_match_verified` require perceptual evidence; loudness and peak measurements alone are insufficient. `contextual_entry_qc_complete` requires every response-led entry to retain an audible antecedent or begin at a self-contained clause. `platform_specific_audio_master_verified` requires an independently rendered and reviewed audio-only timeline with no inherited visual-only dead air. `perceptual_playback_qc_complete` requires a receipt tied to the exact final checksums; probes, ASR, and screenshots alone cannot set it true.

The deprecated Transistor Episode Summary must be blank. `keywords_complete` requires a non-empty, episode-specific keyword set. `description_format_verified` requires readable paragraph/section spacing in the destination-rendered description. `native_chapters_verified` requires chapter records on the Transistor episode itself; description timestamps alone do not satisfy it.
