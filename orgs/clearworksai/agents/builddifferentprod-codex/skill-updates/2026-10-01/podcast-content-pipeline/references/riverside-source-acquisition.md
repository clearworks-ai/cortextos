# Riverside Source Acquisition

Use this procedure to acquire native episode sources from Riverside without silently substituting editor-preview media.

## Required Access

Require a Riverside **Recordings/project share link** for the correct episode. An Editor preview/review link may expose a transcript and review playback but can serve reduced-resolution media and is not sufficient evidence of native-track access.

Preflight every run in this order:

1. Confirm Riverside MCP OAuth can identify the exact edit, revision, and completed export ID.
2. If the MCP returns file bytes or a signed download URL, use it and bind the result to that export ID.
3. If the MCP returns only export metadata or an object key, use the official Business API download route with `RIVERSIDE_API_KEY` from the approved secret store.
4. If an API key is unavailable, use the authenticated Riverside web session with `RIVERSIDE_PASSWORD` from the approved secret store. Log in, open the exact edit, choose Download, preserve the approved resolution/settings, and capture the browser's completed download.
5. A missing route is a technical recovery condition, not a reason to ask a producer to download the file. Exhaust the authorized MCP, Business API, and authenticated-web routes before creating a human task.

Never place the password, API key, session cookie, signed URL, or share token in a command transcript, task description, receipt, `.env` file, or documentation. Store credential values only in the approved secret manager/keychain and document their variable names. A credential preflight proves presence and successful authentication without printing the value.

Treat the project share token, review token, and signed media URLs as secrets. Do not repeat them in chat, ordinary logs, filenames, ledgers, or reports. Store only a protected reference location.

## 1. Confirm Project Identity

Before downloading, record non-secret identity fields:

- show and episode ID;
- Riverside project and recording IDs;
- recording name, creation date, and duration;
- expected participants;
- transcript readiness;
- whether the project is the final recording rather than a test, clip, or editor export.

Stop on an episode/project mismatch.

## 2. Inventory Before Transfer

On the Recordings tab, inventory each participant row and the combined-participant row. For every participant, record the available asset types and displayed native resolution.

Expected participant assets may include:

- Raw video — CFR MP4;
- Aligned video — CFR MP4;
- Cloud MP4;
- Raw audio — WAV;
- Magic Audio — WAV;
- Compressed audio — MP3.

For canonical editing sources, prefer each participant's **Raw video CFR MP4** and **Raw audio WAV**. Download Magic Audio only as an optional comparison; never replace the raw WAV without an explicit editorial decision.

## 3. Download Deterministically

Use a browser session scoped to the protected project. For each participant:

1. Open that participant row's Download menu.
2. Select `Raw video - CFR MP4`.
3. Observe the browser download manager and identify the new active transfer.
4. Wait for terminal completion. If Riverside/Chrome leaves a canceled or stalled entry, use the download manager's `Retry` action once and monitor the replacement entry.
5. Read the completed entry's local `filePath`; do not assume the visible UUID or requested destination name became the final path.
6. Move/rename the completed file to the deterministic episode name only after the browser reports complete.
7. Repeat for `Raw audio - WAV`.

Do not start duplicates merely because a transfer has no friendly filename or progress text. Inspect the active download entry and filesystem byte growth first. Stop after one bounded retry and report the exact failure if it still does not progress.

### Completed Editor Export

For an approved short or edited master, bind the download to the exact Riverside edit ID, source revision, completed export ID, export settings, and exported filename before transfer. A metadata response containing only an S3/object key is identification evidence, not file receipt evidence.

When the authenticated web route is required:

1. Open the exact edit/revision in Riverside.
2. Open `Export` → `Download` and verify the approved quality/settings before acting.
3. Trigger the browser-managed download once and wait for its terminal file.
4. Read the actual downloaded path; Riverside may return a UUID-like filename without an extension.
5. Identify the container with `file`/`ffprobe`, then rename it to the export's deterministic filename.
6. Prove full decode, duration, resolution, streams, size, SHA-256, and visual continuity before Drive upload.

Do not create a replacement export merely because the existing completed export lacks a direct MCP download URL. Use the approved export's current revision/settings and record whether the provider reused the completed export or generated a byte-identical replacement.

### Transfer Progress Evidence

For any transfer that does not finish promptly, record at least two byte/time samples and calculate effective throughput plus an estimated completion time. Compare the estimate with the expected asset size and the recent samples. Treat repeated negligible growth, a worsening or implausible ETA, or a browser state that no longer agrees with filesystem growth as a stalled transfer rather than describing it merely as active. Use the single bounded recovery path above, preserve the measured samples in the receipt, and do not launch a duplicate while meaningful byte growth continues.

## 4. Prove Completion

A download click, signed URL, `.crdownload`, sparse preallocated file, or active browser item is not completion. Require all of the following:

- browser download state is complete;
- the final local path exists without `.crdownload`/`.part`;
- byte size is non-zero and stable;
- `ffprobe` parses the file successfully;
- duration approximately matches the recording;
- video reports the expected native width, height, codec, and frame rate;
- audio reports PCM WAV, channel count, sample rate, bit depth, and duration;
- SHA-256 is recorded.

For a publication-quality source gate, video must be native 1080p or better when Riverside advertises it, and audio must be the participant's isolated lossless WAV. Never describe an upscale as native resolution.

## 5. Archive and Protect

Archive untouched originals to the episode's canonical Drive source folder before editing. Recommended naming:

```text
BD-E001-Josh-raw-video.mp4
BD-E001-Josh-raw-audio.wav
BD-E001-Bones-raw-video.mp4
BD-E001-Bones-raw-audio.wav
```

Record local SHA-256 and the provider/Drive checksum or size read-back. Create working copies or derived outputs outside the originals folder.

For approved short-form masters, archive the verified export in the episode's private `Approved Social Masters` folder. Drive read-back must match local byte size and at least one provider checksum; retain the Drive file ID, parent folder ID, private permission read-back, and web view link. Only that Drive-bound asset may advance to Blotato.

## 6. Source Receipt

The source-stage receipt must enumerate expected versus acquired assets per participant and show the probe/checksum evidence. Mark the stage `blocked` when any required native source is missing. Downstream transcript analysis may continue when its inputs are independently verified, but a final media render may not bypass the missing-source gate.
