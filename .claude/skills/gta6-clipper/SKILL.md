---
name: gta6-clipper
description: Find reusable GTA 6 videos on YouTube (Creative Commons or creators who allowed clipping), cut the best moments into captioned vertical Shorts with free tools (yt-dlp + ffmpeg), upload them to Google Drive and schedule them to YouTube through Metricool at the best time. Use when asked to "clip GTA 6", "make GTA 6 shorts", "run the clipper", or "post GTA clips".
---

# GTA 6 Shorts clipper

Everything is free and local: `yt-dlp` finds and downloads, `ffmpeg` edits, captions come from
YouTube's own auto-captions (word-timed json3), with `faster-whisper` as a fallback.
Script: `scripts/clipper.py` (run `python3 scripts/clipper.py <cmd> -h` for all options).

Work dir for a run: `$JOB = <scratchpad>/gta6/<YYYYMMDD-HHMM>`.

## 0. Setup (silent, every run)

```bash
pip install -q -U yt-dlp faster-whisper numpy
```

`ffmpeg` must exist. If a `find`/`prepare` call fails with a proxy 403 or "Sign in to confirm you're
not a bot", the environment cannot reach YouTube: stop and tell the user (see "Network" below). Do not
try other sites to get around it.

## 1. Find a source — reuse rules are not optional

```bash
python3 scripts/clipper.py find --query "GTA 6" --days 3 --max 20 > $JOB/candidates.json
```

Only candidates whose `reuse_basis` is `CC BY` or `creator permission (allowlist)` may be used.
Never pass `--any-license` in an automated run and never post an `UNVERIFIED` source: reposting other
creators' videos without permission gets Content ID claims and copyright strikes (3 strikes = channel
deleted). If nothing qualifies, try other queries ("GTA 6 gameplay", "GTA VI", "GTA 6 funny moments",
"GTA 6 stunts"); if still nothing, stop and report — do not lower the bar.

Creators who told the user they allow clipping go in `data/allowlist.txt` (channel handle or id, one
per line). Pick the candidate with the highest `velocity` (views per day).

## 2. Prepare highlights

```bash
python3 scripts/clipper.py prepare --url <url> --out $JOB/src --count 3 --length 32
```

It scores every second by loudness, scene cuts and speech, skips intros/outros and returns the best
non-overlapping windows with their transcript. Read each `transcript`; drop a window that is a sponsor
read, a "subscribe" plea, a static menu, or makes no sense out of context. Adjust a window with
`--start/--end` at render time if a sentence is cut mid-way (keep 20–45 s).

## 3. Render each Short

Write a hook for each clip: max 6 words, curiosity or reaction, no clickbait lies, no fake claims
about Rockstar. Examples: "He did NOT expect that", "Vice City cops are brutal", "This jump shouldn't work".

```bash
python3 scripts/clipper.py render --plan $JOB/src/plan.json --clip 0 \
  --hook "<hook>" --out $JOB/out/clip0.mp4
```

Output: 1080x1920 H.264, -14 LUFS audio, blurred-fill background, zoomed gameplay, hook bar on top,
word-by-word captions (current word yellow), on-screen credit line, plus `clip0_cover.jpg` and
`clip0.json` (metadata + transcript). Look at the cover image (Read tool) before posting; if the
captions are empty or wrong, re-render with `--no-captions` rather than post nonsense.

## 4. Title, description, tags

- Title (≤ 70 chars): hook-style, include "GTA 6", end with `#Shorts`.
- Description, always with the credit block:

```
<one-line hook/context>

🎥 Original video: "<source_title>" by <source_channel>
<source_url>
Used under <license | the creator's permission>. Clipped, edited and captioned by us.

#GTA6 #GTAVI #Shorts #Gaming
```

- Tags: `GTA 6`, `GTA VI`, `Grand Theft Auto 6`, `GTA 6 gameplay`, plus 3–5 from the transcript.

## 5. Host on Google Drive

1. Find or create a Drive folder `GTA6 Clips` (`mcp__Google_Drive__search_files`, else `create_file`
   with `contentMimeType: application/vnd.google-apps.folder`).
2. Upload: `mcp__Google_Drive__create_file` with `title: <slug>.mp4`, `contentMimeType: video/mp4`,
   `disableConversionToGoogleType: true`, `parentId: <folder>`, and
   `base64Content: "sha256:<sha256sum of file>:<absolute path>"` (a file reference — never inline base64).
3. `mcp__Google_Drive__share_file` with `permissionId: "anyoneWithLink"`, `role: reader`; use the
   returned link as the media URL. (Metricool pulls Drive links only if Google Drive is linked in the
   Metricool account; if scheduling fails on media, tell the user to link it in Metricool.)

## 6. Schedule on YouTube via Metricool

1. `getBrandSettings` → `blogId` (`id`) and `timezone` of the brand with `youtubeData`.
2. `getBestTimeToPostByNetwork` for `youtube`, next 48 h. Pick the top slots in the future, at least
   3 h apart, one per clip.
3. `createScheduledPost` per clip — `info`:

```json
{
  "text": "<description>",
  "providers": [{"network": "youtube"}],
  "publicationDate": {"dateTime": "YYYY-MM-DDTHH:mm:ss", "timezone": "<brand tz>"},
  "media": ["<drive link>"],
  "autoPublish": true, "draft": false, "shortener": false,
  "firstCommentText": "", "hasNotReadNotes": false, "descendants": [],
  "mediaAltText": [], "smartLinkData": {"ids": []},
  "youtubeData": {"title": "<title>", "type": "short", "privacy": "public",
                  "tags": ["GTA 6", "..."], "category": "GAMING", "madeForKids": false,
                  "isAiGeneratedContent": false}
}
```

## 7. Bookkeeping

```bash
python3 scripts/clipper.py mark <video id> --note "<n> clips scheduled"
```

Commit `data/used.json` so the same video is never clipped twice. Finish with a short table:
clip, hook, title, scheduled time, Metricool `plannerUrl`, source + reuse basis.

## Network

YouTube downloads need `www.youtube.com` and the rotating `*.googlevideo.com` media hosts. If the
cloud environment blocks them, the user can either allow them in their environment's network settings,
or run this skill in Claude Code on their own computer, where it works as is.
