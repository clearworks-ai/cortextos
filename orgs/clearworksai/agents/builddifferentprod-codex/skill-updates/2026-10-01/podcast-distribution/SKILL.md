---
name: podcast-distribution
description: Publish or schedule approved Build Different full episodes and short videos to their exact destinations, then verify terminal live state and preserve receipts.
---

# Podcast Distribution

Require exact-master and exact-post approval. Creation, rendering, upload, or prior-version approval never authorizes publication.

This skill owns distribution state and receipts. Blotato Post Scheduler is a transport adapter beneath it, not a second workflow owner. Altari Publishing Manager is noncanonical for Build Different.

## Workflow

- Wednesday 7:00 AM Pacific: verify processing, files, captions, chapters, description, links, people, transcript, and metadata.
- At 8:00 AM obtain approval of the exact destination versions.
- Default release: 9:00 AM full episode to Transistor/RSS and YouTube.
- Treat that default full-episode release as one atomic launch outcome. A terminal Transistor audio receipt is only a partial publication. Do not report the episode as live, launched, complete, or published everywhere until the exact approved video is terminally public on the Build Different YouTube channel, its URL is saved in the Transistor episode's `youtube_url`, and a fresh public Transistor-page read-back visibly proves the playable video embed renders. Keep the launch task open on any missing leg.
- Before any short-form post for that episode, publish an approved LinkedIn launch post that links to the full YouTube episode. The default Build Different destination is the Build Different LinkedIn company page—not Josh's personal profile—even when Josh's profile administers the page. Require the company-page ID to appear in the connected-account read-back before scheduling. This is a hard sequence gate: no episode short may be scheduled or published until the LinkedIn launch post has a terminal published receipt. Record the YouTube URL, exact LinkedIn page/account IDs, approved copy, publish time, and live LinkedIn post ID/URL in the episode ledger.
- A LinkedIn full-episode launch must never be text-only and must not depend on LinkedIn generating a link preview. Always upload an approved episode thumbnail, launch graphic, or video as explicit media while keeping the full YouTube URL in the post copy. Verify the exact media attachment in the scheduled payload and live destination; a URL in the text or an empty `mediaUrls` field fails the gate.
- After that gate passes, begin the approved vertical-clip sequence on Build Different channels. Use one social post per day by default; a same-day launch post plus first short is an episode-specific exception requiring explicit approval of both times.
- Default follow-ons: clip two Thursday, clip three Friday, clip four the following Monday, and clip five Tuesday only when another strong standalone moment exists.
- Before each social publish, show the exact account, asset, copy, visibility, and timing.
- For Build Different short-form distribution, keep system ownership explicit: Riverside is the edit/export source, Google Drive is the canonical store for the exact approved master and receipts, and Blotato Post Scheduler is the publishing transport. Acquire the completed Riverside export, verify its identity and checksum, save that exact approved file to the Build Different Drive publishing folder, then hand its Drive asset ID/checksum plus the approved platform payload to Blotato. A Riverside social-account connection is not a prerequisite and direct Riverside social publishing is noncanonical.
- Run source-acquisition preflight before declaring a short blocked: confirm the exact completed export through Riverside MCP; use an MCP download if exposed; otherwise use the official Business API with `RIVERSIDE_API_KEY`; otherwise authenticate to Riverside with `RIVERSIDE_PASSWORD` from the secure keychain/secret manager and download through the exact edit's Export → Download flow. Exhaust these authorized routes before creating a human task. Never expose credential values or signed URLs in logs or receipts.
- Pass only the exact Drive-bound approved asset, copy, account, visibility, and time to Blotato Post Scheduler. Record its post ID, then independently verify the destination. Scheduler acceptance is not a release receipt. If the exact export cannot be acquired or its Drive identity/checksum cannot be proven, stop as blocked; never substitute a proxy, earlier render, or another publishing route.
- At scheduling time, register a daemon-owned delivery monitor that survives restarts. It must fire no later than five minutes after the approved publish time, poll each destination at bounded intervals until terminal (30-minute default ceiling), capture exact live IDs/URLs, alert `#build-different-prod` immediately on any failure, and self-remove only after terminal handling. An email from Blotato must never be the first failure signal.
- Poll upload/export status to a terminal result and perform live destination read-back. Do not infer “live” from request acceptance. A multi-platform batch is complete only when every destination has either a verified live URL or an exact reported failure and recovery owner.
- Preserve successful sibling destinations when one platform fails. Before any retry, prove the failed platform did not publish a duplicate and diagnose the exact error. Never silently retry; if recovery changes the asset, copy, destination, visibility, or timing, obtain fresh approval.

Transistor remains the single RSS authority and holds one media enclosure per episode. The separate YouTube video is attached through `youtube_url`; it is not a second RSS enclosure. Freeze concurrent API writes during dashboard media processing.

## Exit Receipt

Return platform/account, Riverside export ID, canonical Drive asset ID/location, asset checksum/version, copy version, Blotato submission/post ID, visibility, publish time, terminal status, live URL/ID, and destination read-back. Before delivery, re-read the workflow above and confirm the receipt proves the Riverside-to-Drive handoff and the Drive-to-Blotato transport; do not ship a receipt that implies Riverside published the social post. For a full episode, the exit receipt must include the Transistor URL, YouTube video ID/URL, exact saved Transistor `youtube_url`, and visible public embed read-back. If Tuesday approval is missed, explicitly reduce scope or move the release; never skip QA to protect Wednesday.
