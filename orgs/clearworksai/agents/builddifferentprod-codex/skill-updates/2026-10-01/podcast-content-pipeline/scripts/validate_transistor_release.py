#!/usr/bin/env python3
"""Fail closed unless a Build Different Transistor release package is complete."""

import argparse
import json
import sys
from pathlib import Path


REQUIRED_TRUE = (
    "video_processing_complete",
    "audio_processing_complete",
    "youtube_publication_complete",
    "transistor_youtube_url_attached",
    "transistor_video_embed_verified",
    "isolated_stem_qc_complete",
    "voice_timbre_match_verified",
    "contextual_entry_qc_complete",
    "platform_specific_audio_master_verified",
    "perceptual_playback_qc_complete",
    "dialogue_edit_engine_verified",
    "human_dialogue_edit_review_complete",
    "inactive_mic_qc_complete",
    "restoration_headphone_ab_approved",
    "exact_destination_perceptual_approval_complete",
    "chapters_complete",
    "chapter_links_verified",
    "native_chapters_verified",
    "description_complete",
    "description_format_verified",
    "summary_omitted",
    "keywords_complete",
    "business_links_verified",
    "people_credits_complete",
    "transcript_captions_complete",
)
REQUIRED_IDS = (
    "approved_video_asset_id",
    "approved_audio_asset_id",
    "publication_approval_id",
    "destination_readback_receipt",
    "youtube_live_video_id",
    "youtube_publication_receipt",
    "transistor_embed_readback_receipt",
)


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("state", type=Path)
    parser.add_argument("--chapters", type=Path)
    parser.add_argument("--spotify-chapters", type=Path)
    parser.add_argument("--metadata", type=Path)
    args = parser.parse_args()

    state = json.loads(args.state.read_text())
    ready = state.get("release_readiness")
    if not isinstance(ready, dict):
        fail("release_readiness is missing")

    missing_true = [key for key in REQUIRED_TRUE if ready.get(key) is not True]
    missing_ids = [key for key in REQUIRED_IDS if not ready.get(key)]
    if missing_true or missing_ids:
        fail(f"release gate incomplete: false={missing_true}, missing={missing_ids}")

    if args.chapters:
        chapters = json.loads(args.chapters.read_text()).get("chapters", [])
        starts = [float(c.get("audio_start_seconds", c.get("start_seconds", -1))) for c in chapters]
        if len(starts) < 3 or starts[0] != 0 or starts != sorted(set(starts)):
            fail("chapters must contain 3+ unique ascending entries beginning at 00:00")
        if any((b - a) < 10 for a, b in zip(starts, starts[1:])):
            fail("canonical chapter spacing must be at least 10 seconds")

    if args.spotify_chapters:
        spotify = json.loads(args.spotify_chapters.read_text()).get("chapters", [])
        starts = [float(c.get("audio_start_seconds", c.get("start_seconds", -1))) for c in spotify]
        if len(starts) < 3 or starts[0] != 0 or starts != sorted(set(starts)):
            fail("Spotify chapters must contain 3+ unique ascending entries beginning at 00:00")
        if any((b - a) < 30 for a, b in zip(starts, starts[1:])):
            fail("Spotify chapter spacing must be at least 30 seconds")

    if args.metadata:
        metadata = json.loads(args.metadata.read_text())
        if str(metadata.get("summary", "")).strip():
            fail("deprecated Transistor episode summary must be blank")
        keywords = metadata.get("keywords")
        if isinstance(keywords, str):
            keyword_values = [value.strip() for value in keywords.split(",") if value.strip()]
        elif isinstance(keywords, list):
            keyword_values = [str(value).strip() for value in keywords if str(value).strip()]
        else:
            keyword_values = []
        if len(keyword_values) < 3:
            fail("metadata must contain at least three episode-specific keywords")
        description = str(metadata.get("description_html", ""))
        if "<p" not in description.lower() or not any(
            marker in description.lower() for marker in ("<h2", "<h3", "<br")
        ):
            fail("description_html must contain readable paragraph and section spacing")
        text = description
        for url in ("https://clearworks.ai", "https://www.allsafeit.com"):
            if url not in text:
                fail(f"missing required business link: {url}")
        youtube_url = str(metadata.get("youtube_url", "")).strip()
        if not youtube_url.startswith(("https://www.youtube.com/watch?v=", "https://youtu.be/")):
            fail("metadata must contain the exact live YouTube URL used by the Transistor embed")

    print(json.dumps({"status": "PASS", "episode_id": state.get("episode_id")}))


if __name__ == "__main__":
    main()
