#!/usr/bin/env python3
"""GTA 6 Shorts clipper — free tools only (yt-dlp + ffmpeg, optional faster-whisper).

Subcommands
  find     search YouTube for reusable GTA 6 videos (Creative Commons or allowlisted creators)
  prepare  download a video (or take a local file), pick the best highlight windows, collect word timings
  render   cut one highlight into a 1080x1920 Short with blurred background, hook title,
           word-by-word captions and an on-screen creator credit
  mark     record a source as used so it is never clipped twice
"""
import argparse, json, math, os, re, subprocess, sys, time
from pathlib import Path

import numpy as np

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_STATE = SKILL_DIR / "data" / "used.json"
DEFAULT_ALLOW = SKILL_DIR / "data" / "allowlist.txt"
CC_FILTER = "EgIwAQ%253D%253D"  # YouTube search filter: Creative Commons


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw)


def load_json(p, default):
    try:
        return json.loads(Path(p).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


# ----------------------------------------------------------------------------- find
def load_allowlist(path):
    if not Path(path).exists():
        return set()
    out = set()
    for line in Path(path).read_text().splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if line:
            out.add(line.lstrip("@"))
    return out


def is_allowed(info, allow):
    lic = (info.get("license") or "").lower()
    if "creative commons" in lic:
        return True, "CC BY"
    keys = {str(info.get(k) or "").lower().lstrip("@") for k in
            ("channel_id", "uploader_id", "channel", "uploader", "channel_handle")}
    if keys & allow:
        return True, "creator permission (allowlist)"
    return False, None


def cmd_find(a):
    from yt_dlp import YoutubeDL
    allow = load_allowlist(a.allowlist)
    used = load_json(a.state, {})
    q = a.query.replace(" ", "+")
    urls = []
    if not a.any_license:
        urls.append(f"https://www.youtube.com/results?search_query={q}&sp={CC_FILTER}")
    urls.append(f"ytsearchdate{a.max}:{a.query}")
    flat = YoutubeDL({"quiet": True, "extract_flat": "in_playlist", "playlistend": a.max, "skip_download": True})
    full = YoutubeDL({"quiet": True, "skip_download": True})
    seen, results = set(), []
    for u in urls:
        try:
            entries = flat.extract_info(u, download=False).get("entries") or []
        except Exception as e:  # noqa: BLE001
            log(f"search failed for {u}: {e}")
            continue
        for e in entries[: a.max]:
            vid = e.get("id")
            if not vid or vid in seen or vid in used:
                continue
            seen.add(vid)
            try:
                info = full.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            except Exception as ex:  # noqa: BLE001
                log(f"skip {vid}: {ex}")
                continue
            ok, basis = is_allowed(info, allow)
            if not ok and not a.any_license:
                continue
            dur = info.get("duration") or 0
            if dur < a.min_dur or dur > a.max_dur:
                continue
            up = info.get("upload_date") or "19700101"
            age_days = max(0.5, (time.time() - time.mktime(time.strptime(up, "%Y%m%d"))) / 86400)
            if age_days > a.days:
                continue
            views = info.get("view_count") or 0
            results.append({
                "id": vid, "url": info.get("webpage_url"), "title": info.get("title"),
                "channel": info.get("channel") or info.get("uploader"),
                "channel_url": info.get("channel_url"), "license": info.get("license"),
                "reuse_basis": basis or "UNVERIFIED — do not post", "duration": dur,
                "views": views, "upload_date": up, "velocity": round(views / age_days),
            })
    results.sort(key=lambda r: r["velocity"], reverse=True)
    json.dump(results, sys.stdout, indent=2)
    print()


# -------------------------------------------------------------------------- prepare
def download(url, outdir):
    from yt_dlp import YoutubeDL
    opts = {
        "quiet": True, "outtmpl": str(outdir / "source.%(ext)s"),
        "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b",
        "merge_output_format": "mp4", "writesubtitles": True, "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-orig", "en.*"], "subtitlesformat": "json3",
    }
    with YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
    (outdir / "info.json").write_text(json.dumps({k: info.get(k) for k in (
        "id", "title", "channel", "uploader", "channel_url", "webpage_url", "license", "duration")}, indent=2))
    subs = sorted(outdir.glob("source*.json3"))
    return outdir / "source.mp4", (subs[0] if subs else None), info


def words_from_json3(path):
    data = json.loads(Path(path).read_text())
    words = []
    for ev in data.get("events", []):
        t0 = ev.get("tStartMs", 0)
        for s in ev.get("segs") or []:
            w = (s.get("utf8") or "").strip()
            if w and w != "\n":
                words.append({"w": w, "s": (t0 + s.get("tOffsetMs", 0)) / 1000})
    words.sort(key=lambda x: x["s"])
    for i, w in enumerate(words):
        nxt = words[i + 1]["s"] if i + 1 < len(words) else w["s"] + 0.6
        w["e"] = min(nxt, w["s"] + 1.0)
    return words


def words_from_whisper(media, model_name):
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel(model_name, device="cpu", compute_type="int8")
        segs, _ = m.transcribe(str(media), word_timestamps=True, vad_filter=True)
        return [{"w": w.word.strip(), "s": w.start, "e": w.end} for s in segs for w in (s.words or [])]
    except Exception as e:  # noqa: BLE001
        log(f"whisper unavailable ({e}); continuing without captions")
        return []


def duration_of(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(r.stdout.strip())


def loudness_per_sec(path, dur):
    sr = 8000
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                       capture_output=True, check=True)
    x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32)
    n = int(math.ceil(dur))
    out = np.full(n, -90.0)
    for i in range(n):
        seg = x[i * sr:(i + 1) * sr]
        if len(seg):
            out[i] = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-6)
    return out


def scene_cuts(path):
    p = subprocess.run(["ffmpeg", "-v", "info", "-i", str(path), "-an", "-vf",
                        "scale=320:-2,select='gt(scene,0.32)',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True)
    return [float(m) for m in re.findall(r"pts_time:([\d.]+)", p.stderr)]


def pick_windows(dur, loud, cuts, words, length, count):
    n = len(loud)
    z = (loud - np.median(loud)) / (np.std(loud) + 1e-6)
    score = np.clip(z, -2, 3)
    for c in cuts:
        if int(c) < n:
            score[int(c)] += 0.6
    speech = np.zeros(n)
    for w in words:
        if int(w["s"]) < n:
            speech[int(w["s"])] = 1
    score += 0.4 * speech
    lo = int(max(5, dur * 0.04))           # skip intros
    hi = int(min(n, dur * 0.92)) - length  # skip outros / end screens
    if hi <= lo:
        lo, hi = 0, max(0, n - length)
    cands = []
    for s in range(lo, hi + 1):
        cands.append((float(score[s:s + length].mean()), s))
    cands.sort(reverse=True)
    chosen = []
    for sc, s in cands:
        if all(abs(s - c["start"]) >= length for c in chosen):
            # snap start to a nearby scene cut so the clip opens on a clean shot
            near = [c for c in cuts if s - 2 <= c <= s + 1.5]
            st = round(near[0], 2) if near else float(s)
            chosen.append({"start": st, "end": round(min(dur, st + length), 2), "score": round(sc, 3)})
        if len(chosen) >= count:
            break
    for c in chosen:
        c["transcript"] = " ".join(w["w"] for w in words if c["start"] <= w["s"] < c["end"])
    return chosen


def cmd_prepare(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.url:
        src, subs, info = download(a.url, out)
        info = json.loads((out / "info.json").read_text())
    else:
        src, subs = Path(a.file).resolve(), (Path(a.subs) if a.subs else None)
        info = {"title": src.stem, "channel": a.credit or "", "webpage_url": a.source_url or "", "license": a.license or ""}
    words = words_from_json3(subs) if subs and subs.exists() else []
    if not words and not a.no_whisper:
        words = words_from_whisper(src, a.whisper_model)
    dur = duration_of(src)
    log(f"analysing {dur:.0f}s of video…")
    loud = loudness_per_sec(src, dur)
    cuts = scene_cuts(src)
    clips = pick_windows(dur, loud, cuts, words, a.length, a.count)
    plan = {"source": str(src), "info": info, "duration": dur, "words": words, "clips": clips}
    (out / "plan.json").write_text(json.dumps(plan, indent=2))
    json.dump({"plan": str(out / "plan.json"), "title": info.get("title"), "channel": info.get("channel"),
               "clips": clips}, sys.stdout, indent=2)
    print()


# --------------------------------------------------------------------------- render
def ass_time(t):
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def esc(s):
    return s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def build_ass(words, start, end, hook, credit, fg_bottom):
    cap_y = min(1700, fg_bottom + 190)
    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        "Style: Cap,Inter,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,5,60,60,0,1",
        "Style: Hook,Inter,70,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,18,0,8,70,70,170,1",
        "Style: Credit,Inter,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,90,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    L = end - start
    if hook:
        lines.append(f"Dialogue: 2,{ass_time(0)},{ass_time(L)},Hook,,0,0,0,,{{\\fad(150,0)}}{esc(hook.upper())}")
    if credit:
        lines.append(f"Dialogue: 2,{ass_time(0)},{ass_time(L)},Credit,,0,0,0,,{esc(credit)}")
    ws = [dict(w, s=w["s"] - start, e=w["e"] - start) for w in words if start <= w["s"] < end]
    chunks, cur = [], []
    for w in ws:  # chunks of up to 3 words, broken on pauses and punctuation
        if cur and (len(cur) >= 3 or w["s"] - cur[-1]["e"] > 0.45):
            chunks.append(cur); cur = []
        cur.append(w)
        if re.search(r"[.!?,]$", w["w"]):
            chunks.append(cur); cur = []
    if cur:
        chunks.append(cur)
    for ch in chunks:
        for i, w in enumerate(ch):
            t0 = w["s"]
            t1 = ch[i + 1]["s"] if i + 1 < len(ch) else max(w["e"], t0 + 0.25)
            parts = []
            for j, x in enumerate(ch):
                txt = esc(re.sub(r"[^\w'’!?$%#&-]", "", x["w"]).upper()) or esc(x["w"].upper())
                parts.append("{\\c&H00E6FF&\\fscx112\\fscy112}" + txt + "{\\c&HFFFFFF&\\fscx100\\fscy100}" if j == i else txt)
            lines.append(f"Dialogue: 1,{ass_time(t0)},{ass_time(min(t1, L))},Cap,,0,0,0,,"
                         f"{{\\pos(540,{cap_y})}}" + " ".join(parts))
    return "\n".join(lines) + "\n"


def cmd_render(a):
    plan = json.loads(Path(a.plan).read_text())
    clip = plan["clips"][a.clip]
    start, end = clip["start"], clip["end"]
    if a.start is not None:
        start = a.start
    if a.end is not None:
        end = a.end
    info = plan["info"]
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
             "-of", "csv=p=0", plan["source"]])
    w, h = (int(v) for v in r.stdout.strip().split(",")[:2])
    fg_h = round(1080 * h / w / 2) * 2
    if a.zoom:  # crop sides so gameplay fills more of the vertical frame
        fg_h = min(1300, round(fg_h * a.zoom / 2) * 2)
    fg_top = (1920 - fg_h) // 2 - 60
    credit = a.credit if a.credit is not None else (f"Clip: {info.get('channel')} • full video in description"
                                                     if info.get("channel") else "")
    ass = out.with_suffix(".ass")
    ass.write_text(build_ass(plan["words"] if not a.no_captions else [], start, end, a.hook, credit, fg_top + fg_h))
    L = end - start
    fg = f"scale=1080:{fg_h}" if not a.zoom else f"scale=-2:{fg_h},crop=1080:{fg_h}"
    vf = (f"[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
          f"boxblur=24:2,eq=brightness=-0.12:saturation=1.2[bg];[b]{fg},setsar=1[fg];"
          f"[bg][fg]overlay=0:{fg_top},fps=30,ass='{ass}',fade=in:0:8[v]")
    af = f"loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.15,afade=t=out:st={max(0, L - 0.4):.2f}:d=0.4[aout]"
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start}", "-t", f"{L}", "-i", plan["source"],
           "-filter_complex", vf + ";[0:a]" + af, "-map", "[v]", "-map", "[aout]",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
    thumb = out.with_name(out.stem + "_cover.jpg")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{min(1.5, L / 2)}", "-i", str(out),
                    "-frames:v", "1", "-q:v", "3", str(thumb)], check=True)
    meta = {"video": str(out), "cover": str(thumb), "start": start, "end": end, "seconds": round(L, 2),
            "source_title": info.get("title"), "source_channel": info.get("channel"),
            "source_url": info.get("webpage_url"), "license": info.get("license"),
            "transcript": " ".join(x["w"] for x in plan["words"] if start <= x["s"] < end)}
    out.with_suffix(".json").write_text(json.dumps(meta, indent=2))
    json.dump(meta, sys.stdout, indent=2)
    print()


def cmd_mark(a):
    used = load_json(a.state, {})
    used[a.id] = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "note": a.note or ""}
    Path(a.state).parent.mkdir(parents=True, exist_ok=True)
    Path(a.state).write_text(json.dumps(used, indent=2))
    print(f"marked {a.id}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("find")
    f.add_argument("--query", default="GTA 6")
    f.add_argument("--max", type=int, default=15)
    f.add_argument("--days", type=float, default=7, help="only videos uploaded in the last N days")
    f.add_argument("--min-dur", type=int, default=60)
    f.add_argument("--max-dur", type=int, default=3600)
    f.add_argument("--allowlist", default=str(DEFAULT_ALLOW))
    f.add_argument("--state", default=str(DEFAULT_STATE))
    f.add_argument("--any-license", action="store_true", help="also list videos with no reuse permission (marked UNVERIFIED)")
    f.set_defaults(fn=cmd_find)

    pr = sub.add_parser("prepare")
    src = pr.add_mutually_exclusive_group(required=True)
    src.add_argument("--url")
    src.add_argument("--file")
    pr.add_argument("--subs", help="json3 caption file for --file input")
    pr.add_argument("--credit", help="creator name for --file input")
    pr.add_argument("--source-url")
    pr.add_argument("--license")
    pr.add_argument("--out", required=True)
    pr.add_argument("--length", type=int, default=32, help="clip length in seconds (Shorts max 60)")
    pr.add_argument("--count", type=int, default=3)
    pr.add_argument("--whisper-model", default="base.en")
    pr.add_argument("--no-whisper", action="store_true")
    pr.set_defaults(fn=cmd_prepare)

    r = sub.add_parser("render")
    r.add_argument("--plan", required=True)
    r.add_argument("--clip", type=int, default=0)
    r.add_argument("--hook", default="", help="big title text at the top")
    r.add_argument("--credit", help="override on-screen credit line")
    r.add_argument("--start", type=float)
    r.add_argument("--end", type=float)
    r.add_argument("--zoom", type=float, default=1.35, help="enlarge gameplay (crops sides); 0 = fit full width")
    r.add_argument("--no-captions", action="store_true")
    r.add_argument("--out", required=True)
    r.set_defaults(fn=cmd_render)

    m = sub.add_parser("mark")
    m.add_argument("id")
    m.add_argument("--note")
    m.add_argument("--state", default=str(DEFAULT_STATE))
    m.set_defaults(fn=cmd_mark)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
