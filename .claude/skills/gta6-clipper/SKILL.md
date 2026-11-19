---
name: gta6-clipper
description: Find reusable GTA 6 videos on YouTube (Creative Commons or creators who allowed clipping), cut the best moments into captioned vertical Shorts with free tools (yt-dlp + ffmpeg), host them via vidIQ and schedule them to YouTube through Metricool at the best time. Use when asked to "clip GTA 6", "make GTA 6 shorts", "run the clipper", or "post GTA clips".
---

# GTA 6 Shorts clipper

**Daily quota: 5 Shorts per run** (unless the user asks for another number). Use 2–3 different source
videos, at most 2 clips from any one source, so the channel doesn't look repetitive. Spread the
posts over the next 24 h (see step 6).

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

## 1a. Links from the user first (data/queue.txt)

The user can paste links (YouTube videos, VODs, streams) in chat or in `data/queue.txt` as
`<link> | <reason> | <optional section>`. A link is usable only with a reason: `cc`,
`clip-program: <who>` (the creator publicly invites clippers) or `permission: <who/when>`. If the
user pastes a link without one, ask once which it is; if none applies, skip it and say why. Never
clip a streamer or YouTuber just because their video is popular. Put the reason in the post
description (see step 4). Move processed lines to `data/queue_done.txt`.

Long streams: pass `--section h:mm:ss-h:mm:ss` to `prepare` (30–60 min at a time) so transcription
stays fast; walk through the stream in sections across runs if needed.

## 1b. Otherwise search Creative Commons

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

## 2. Get the video and prepare highlights

Cloud servers are bot-blocked by YouTube, so import through the vidIQ connector (free, 0 credits):
`mcp__vidIQ__vidiq_video_upload` with `url: <youtube link>`, then poll `mcp__vidIQ__vidiq_job_poll`
until `completed` (wait ~60 s between polls with a background `sleep`), then
`curl -L -o $JOB/dl/source.mp4 '<videoUrl>'`. (On a home PC, `prepare --url <url>` downloads directly.)

```bash
python3 scripts/clipper.py prepare --file $JOB/dl/source.mp4 --credit "<channel>" \
  --source-url "<youtube link>" --license "Creative Commons Attribution (CC BY)" \
  --out $JOB/src --count 3 --length 32
```

Captions come from faster-whisper (`base.en`); videos with no commentary get no captions.
**Then pick moments by reading, not just by score.** Run

```bash
python3 scripts/clipper.py transcript --plan $JOB/src/plan.json
```

It prints timestamped lines with `[LOUD]` flags (laughing, yelling, explosions, chat-reaction spikes).
Read it like an editor and choose the strongest 20–45 s moments: punchlines and the reaction after
them, rage or disbelief, chaotic fails, surprise reveals, hype wins, a story with a payoff. Each clip
must make sense with no context: start a beat before the setup, end right after the reaction. Avoid
slurs or anything mean about real people, sponsor reads, and dead air. Then render with
`--start/--end` set to your chosen times (they are seconds in the analysed file).

The automatic score below is the fallback for videos with no speech.
It scores every second by loudness, scene cuts and speech, skips intros/outros and returns the best
non-overlapping windows with their transcript. Read each `transcript`; drop a window that is a sponsor
read, a "subscribe" plea, a static menu, or makes no sense out of context. Adjust a window with
`--start/--end` at render time if a sentence is cut mid-way (keep 20–45 s).

## 3. Render each Short

Write a hook for each clip: max 6 words, and true: the gameplay is someone else's, so never "I did X"; curiosity or reaction, no clickbait lies, no fake claims
about Rockstar. Examples: "He did NOT expect that", "Vice City cops are brutal", "This jump shouldn't work".

```bash
python3 scripts/clipper.py render --plan $JOB/src/plan.json --clip 0 \
  --hook "<hook>" --out $JOB/out/clip0.mp4
```

Every clip automatically gets: a progress bar, and an animated LIKE → SUBSCRIBE pop-up with a
cursor clicking both, 8 s before the end (`--cta-at` to move it, `--no-cta` to drop it). If
`assets/greenscreen/` contains green-screen videos, one is keyed in at that moment instead. Only put
overlays there that the user is licensed to use (own work, or free for commercial use, no Content ID).

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
Used under <CC BY | <creator>'s clipping program | permission from <creator>>. Clipped, edited and captioned by us.

#GTA6 #GTAVI #Shorts #Gaming
```

- Tags: `GTA 6`, `GTA VI`, `Grand Theft Auto 6`, `GTA 6 gameplay`, plus 3–5 from the transcript.

## 5. Host the clip (free, via vidIQ)

1. `mcp__vidIQ__vidiq_video_upload` with `localFile: {path, sizeBytes (wc -c), contentType: "video/mp4"}`.
2. Run the returned shell `command` exactly as given (it uploads the file).
3. Call `vidiq_video_upload` again with the `uploadId`; use its `videoUrl` as the Metricool media URL.
   Metricool copies the file to its own storage when the post is created.

## 6. Schedule on YouTube via Metricool

1. `getBrandSettings` → `blogId` (`id`) and `timezone` of the brand with `youtubeData`.
2. `getBestTimeToPostByNetwork` for `youtube`, next 36 h. Check `getScheduledPosts` so new posts
   don't collide with ones already queued. Pick the 5 best future slots at least 2 h apart, one per clip.
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

Commit `data/used.json` and push it to the branch the skill came from (in the cloud:
`ccr-fc1b8961-6q0q2k` of `NuelNexus/crypminer`), so the same video is never clipped twice on later days. Finish with a short table:
clip, hook, title, scheduled time, Metricool `plannerUrl`, source + reuse basis.

## Network

YouTube downloads need `www.youtube.com` and the rotating `*.googlevideo.com` media hosts. If the
cloud environment blocks them, the user can either allow them in their environment's network settings,
or run this skill in Claude Code on their own computer, where it works as is.
