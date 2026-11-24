#!/usr/bin/env python3
"""Measure playable reviews and exports for a subtitle, four-frame cue move and music swap."""

import argparse
import hashlib
import json
import runpy
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
CLI = ["node", ROOT / "apps/cli/dist/index.js"]
FIXTURES = ROOT / "tests/fixtures/generated"


def execute(args):
    start = time.monotonic()
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=False)
    elapsed = time.monotonic() - start
    if result.returncode:
        raise RuntimeError(f"{' '.join(map(str, args))}\n{result.stdout[-3000:]}\n{result.stderr[-5000:]}")
    return result, elapsed


def write_json(path, value):
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def generated_project(directory):
    def ffmpeg(source, *options):
        execute(["ffmpeg", "-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", source, *options])

    ffmpeg("testsrc2=s=180x320:r=24:d=6", "-c:v", "libx264", "-threads", "2", directory / "plate.mp4")
    for name, frequency in [("voice", 410), ("music-a", 190), ("music-b", 695)]:
        ffmpeg(f"sine=f={frequency}:sample_rate=48000:d=6", directory / (name + ".wav"))
    (directory / "Graphic.tsx").write_text("""
import { useGraphicFrame } from '@opencut/graphics/react';
export default function Graphic({ card }) {
  const x = Math.min(useGraphicFrame(), 12) * 8 + 10;
  return <svg width="180" height="320">
    <rect x={x} y={card ? 120 : 40} width="30" height="60" fill={card ? '#d74545' : '#f5db71'}/>
  </svg>;
}
""", encoding="utf-8")

    def track(id, type, *clips, **extra):
        return {"id": id, "type": type, "clips": clips, **extra}

    def clip(id, asset, at, source_out, **extra):
        return {"id": id, "asset": asset, "at": at, "sourceOut": source_out, **extra}

    graphic = {"kind": "graphic", "renderer": "react", "path": "Graphic.tsx"}
    definition = {
        "canvas": {"width": 180, "height": 320, "frameRate": 24, "durationFrames": 144},
        "assets": {
            "plate": {"kind": "video", "path": "plate.mp4"},
            "glitter": {**graphic, "durationFrames": 36},
            "card": {**graphic, "durationFrames": 48, "props": {"card": True},
                     "staticRanges": [{"startFrame": 12, "endFrame": 48}]},
            **{key: {"kind": "audio", "path": f"{key}.wav"} for key in ("voice", "music-a", "music-b")},
        },
        "tracks": [
            track("shots", "video", clip("first", "plate", 0, 48), clip("second", "plate", 48, 96, sourceIn=48)),
            track("overlays", "video", clip("glitter-cue", "glitter", 38, 36), clip("end-card", "card", 96, 48)),
            track("narration", "audio", clip("read", "voice", 0, 96), audioRole="dialogue"),
            *[track(f"bed-{key}", "audio", clip(f"cue-{key}", f"music-{key}", 0, 144, volume=0.25),
                    audioRole="music") for key in ("a", "b")],
        ],
        "musicComparison": {"candidates": [{"trackId": "bed-a"}, {"trackId": "bed-b"}], "selected": "bed-a"},
        "subtitles": {"style": {"fontSize": 17}, "cues": [
            {"id": "opening", "text": "A little sparkle", "start": {"numerator": 1, "denominator": 2},
             "end": {"numerator": 3, "denominator": 2}},
        ]},
    }
    baseline = directory / "baseline.video.ts"
    baseline.write_text("export default " + json.dumps(definition) + ";\n", encoding="utf-8")
    paths = []
    for name, operation in [
        ("caption", {"operation": "caption", "id": "opening", "text": "A bit more sparkle"}),
        ("glitter", {"operation": "graphic", "id": "glitter-cue", "at": 34}),
    ]:
        patch = directory / f"{name}.json"
        output = directory / f"{name}.video.ts"
        write_json(patch, {"operations": [operation]})
        execute([*CLI, "timeline", "patch", baseline, "--edit", patch, "--output", output, "--json"])
        paths.append(output)
    marks = directory / "marks.json"
    write_json(marks, [{"name": "opening", "start": 0, "end": 1.75}, {"name": "reveal", "start": 2.5, "end": 4}])
    return baseline, *paths, baseline, marks, ["--music-candidate", "bed-b"]


def measure(args, cache_state, output_kind):
    result, elapsed = execute(args)
    data = json.loads(result.stdout)
    stages, graphics = {}, {}
    for line in result.stderr.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        stage = event.get("stage")
        if event.get("event") != "progress" or event.get("percent") != 100 or not stage:
            continue
        if stage == "graphics":
            key = event["clipId"] + "/" + event.get("detail", "combined")
            graphics.setdefault(key, []).append(event["elapsedSeconds"])
        else:
            stages.setdefault(stage, []).append(event["elapsedSeconds"])
    row = {
        "secondsToPlayable": round(elapsed, 3),
        "outputKind": output_kind,
        "cacheState": cache_state,
        "stageDurationsSeconds": {key: round(sum(samples), 3) for key, samples in stages.items()},
        "costliestGraphics": sorted(
            ({"clip": key, "seconds": round(sum(samples), 3), "tasks": len(samples)} for key, samples in graphics.items()),
            key=lambda item: item["seconds"], reverse=True,
        )[:5],
        "pictureRanges": data.get("pictureRanges", []),
        **{key: data[key] for key in ("width", "height", "frameRate", "frameCount", "encoder", "graphicSampling", "pictureReuse")
           if key in data},
    }
    return row, data


def benchmark(directory, args, project):
    baseline, caption, glitter, music, marks, selection = project

    def processing(cache):
        return ["--recipe-workers", "1", "--recipe-cache", cache / "recipe", "--json"]

    def controls(cache):
        bitrate = ["--video-bitrate", str(args.video_bitrate)] if args.video_bitrate else []
        return ["--encoder", args.encoder, "--quality", args.quality, "--picture-cache", cache / "picture",
                *bitrate, *processing(cache)]

    def render(source, output, cache, state, extra=()):
        return measure([*CLI, "render", source, "--output", output, "--revision-evidence",
                        *controls(cache), *extra], state, "full export")

    seed = directory / "baseline-cache"
    mp4 = directory / "baseline.mp4"
    baseline_run, report = render(baseline, mp4, seed, "cold")
    report_path = directory / "baseline.render.json"
    write_json(report_path, report)
    baseline_ranges = {(row["startFrame"], row["endFrame"]) for row in report.get("pictureRanges", [])}
    cases = {}
    for name, source, selection in [("subtitle", caption, []), ("glitterMinusFourFrames", glitter, []),
                                    ("musicOnly", music, selection)]:
        rows = {"cold": [], "warm": [], "review": [], "remix": []}
        for i in range(args.runs):
            label = f"{name}-{i + 1}"
            review, review_data = measure([
                *CLI, "review", source, "--against", mp4, "--render-report", report_path, "--output", directory / f"{label}-review",
                *processing(seed), *selection, *(["--marks", marks] if name == "musicOnly" else []),
            ], "baseline export available", "bounded review")
            candidate = review_data["candidates"][0]
            review["renderedReviewRanges"] = [mark["after"] for mark in candidate["marks"]]
            changes = candidate["changes"]["ranges"]
            rows["review"].append(review)
            for state in ("cold", "warm"):
                cache = directory / f"{label}-{state}-cache"
                if state == "warm":
                    shutil.copytree(seed, cache)
                output = directory / f"{label}-{state}.mp4"
                plan = json.loads(execute([*CLI, "render", "plan", source, "--output", output,
                                           *controls(cache), *selection])[0].stdout)
                row, _ = render(source, output, cache, state, selection)
                for interval in plan["pictureRanges"]:
                    interval["changedDependencies"] = sorted({
                        dependency for change in changes
                        if interval["startFrame"] < change["endFrame"] and change["startFrame"] < interval["endFrame"]
                        for dependency in change["reasons"]
                    })
                    if interval["status"] == "rebuild":
                        if state == "cold":
                            interval["changedDependencies"].append("empty picture cache")
                        elif not interval["changedDependencies"] and (interval["startFrame"], interval["endFrame"]) not in baseline_ranges:
                            interval["changedDependencies"].append("changed picture cache range boundaries")
                row["rangePlan"] = plan["pictureRanges"]
                rows[state].append(row)
                shutil.rmtree(cache)
            if name == "musicOnly":
                reuse, _ = measure([
                    *CLI, "remix", source, "--picture-from", mp4, "--render-report", report_path,
                    "--output", directory / f"{label}-remix.mp4", *processing(seed), *selection,
                ], "verified export available; no picture cache supplied", "full export")
                rows["remix"].append(reuse)
        cases[name] = {
            "runs": rows,
            "medianSecondsToPlayable": {key: statistics.median(row["secondsToPlayable"] for row in samples)
                                        for key, samples in rows.items() if samples},
        }
    return {"baseline": baseline_run, "cases": cases}


def graphics_benchmark(directory, args):
    helpers = runpy.run_path(ROOT / "tests/reference-motion/measure.py")
    results = []
    for width, height in ((1080, 1920), (2160, 3840)):
        folder = directory / str(height)
        folder.mkdir()
        cache = folder / "cache"
        scratch = folder / "scratch"
        scratch.mkdir()
        definition = folder / "transition.video.ts"
        (folder / "Transition.tsx").write_text("""
import { useGraphicFrame, useGraphicTiming } from '@opencut/graphics/react';
export default function Transition() {
  const tick = Math.floor(useGraphicFrame() / 4);
  const { width, height } = useGraphicTiming();
  const edge = tick * width / 15;
  return <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
    <defs><linearGradient id="wash"><stop stopColor="#e33eac" stopOpacity=".3"/>
      <stop offset="1" stopColor="#68e8fe" stopOpacity=".8"/></linearGradient></defs>
    <path d={`M0 0H${edge}L${edge + width / 6} ${height}H0Z`} fill="url(#wash)"/>
  </svg>;
}
""", encoding="utf-8")
        definition.write_text("export default " + json.dumps({
            "canvas": {"width": width, "height": height, "frameRate": 60, "durationFrames": 72,
                       "backgroundColor": "#304080"},
            "assets": {
                "transition": {"kind": "graphic", "renderer": "react", "path": "Transition.tsx",
                               "durationFrames": 72},
            },
            "tracks": [{"id": "graphics", "type": "video", "clips": [
                {"id": "wash", "asset": "transition", "at": 0, "sourceOut": 72}
            ]}],
        }) + ";", encoding="utf-8")
        env = ["--recipe-cache", folder / "recipes", "--json"]

        def profile(label, command):
            row = helpers["run"]([*CLI, *command, *env], folder, scratch, label,
                                 16 * 1024**3, 12 * 1024**3)
            if row["exitCode"]:
                raise RuntimeError((folder / (label + ".stderr")).read_text()[-6000:])
            # Scope scratch also includes stage directories adjacent to outputs.
            events = [json.loads(line) for line in (folder / (label + ".stderr")).read_text().splitlines()
                      if line.startswith("{")]
            row["stageWork"] = [
                {key: e[key] for key in ("clipId", "stage", "detail", "elapsedSeconds", "totalFrames", "cacheHits")
                 if key in e}
                for e in events if e.get("event") == "progress" and e.get("percent") == 100
            ]
            return row

        def samples(file):
            result, _ = execute(["ffmpeg", "-v", "error", "-i", file, "-an", "-vf",
                                 r"select=eq(n\,0)+eq(n\,20)+eq(n\,42)+eq(n\,71)",
                                 "-fps_mode", "passthrough", "-f", "framemd5", "-"])
            return [line.split(",")[-1].strip() for line in result.stdout.splitlines()
                    if line and not line.startswith("#")]

        rows = []
        for run in range(1, args.runs + 1):
            shutil.rmtree(cache, ignore_errors=True)
            row = {"run": run}
            row["review"] = profile(f"review-{run}", [
                "preview", "clip", definition, "--from", "0", "--to", "60",
                "--output", scratch / f"review-{run}.mp4", "--quality", args.quality,
            ])
            for state in ("cold", "warm"):
                out = scratch / f"{state}-{run}.mp4"
                row[state] = profile(f"{state}-{run}-render", [
                    "render", definition, "--output", out, "--picture-cache", cache,
                    "--encoder", args.encoder, "--quality", args.quality,
                ])
                row[state]["sampleFrameHashes"] = samples(out)
                # Warm the browser raster cache while still composing and encoding the whole clip.
                shutil.rmtree(cache / "picture-v1", ignore_errors=True)
            pngs = sorted(cache.glob("graphics-v1/*/media.png"))
            row["transparentPngHashes"] = [
                hashlib.sha256(pngs[i].read_bytes()).hexdigest()
                for i in sorted({0, len(pngs) // 2, len(pngs) - 1}) if 0 <= i < len(pngs)
            ]
            if pngs:
                pixels, _ = execute(["ffmpeg", "-v", "error", "-i", pngs[len(pngs) // 2], "-vf",
                                     "alphaextract,signalstats,metadata=print:file=-",
                                     "-frames:v", "1", "-f", "null", "-"])
                row["alphaMinMax"] = [line for line in pixels.stdout.splitlines()
                                      if line.startswith(("lavfi.signalstats.YMIN", "lavfi.signalstats.YMAX"))]
            if row["cold"]["sampleFrameHashes"] != row["warm"]["sampleFrameHashes"]:
                raise RuntimeError("Cold and warm exports differ.")
            rows.append(row)
        results.append({"width": width, "height": height, "fps": 60, "runs": rows})
    return {"graphics": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--graphics-only", action="store_true")
    parser.add_argument("--encoder", choices=("software", "videotoolbox"), default="software")
    parser.add_argument("--quality", choices=("fast", "quality", "maximum"), default="quality")
    for key in ("baseline", "caption", "glitter", "music", "marks"):
        parser.add_argument("--" + key, type=Path)
    parser.add_argument("--music-candidate")
    parser.add_argument("--video-bitrate", type=int)
    args = parser.parse_args()
    if args.video_bitrate is not None and not 100 <= args.video_bitrate <= 100000:
        parser.error("--video-bitrate must be 100–100000 kb/s")
    if args.runs < 1:
        parser.error("--runs must be positive")
    custom = (args.baseline, args.caption, args.glitter, args.music, args.marks)
    if any(custom) and not all(custom):
        parser.error("Supply --baseline, --caption, --glitter, --music and --marks together.")
    if not args.baseline:
        if FIXTURES.is_symlink():
            parser.error("The generated fixture directory must not be a symlink.")
        FIXTURES.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="revision-", dir=None if args.baseline else FIXTURES) as scratch:
        directory = Path(scratch)
        if args.graphics_only:
            result = graphics_benchmark(directory, args)
        else:
            project = (*[path.resolve() for path in custom],
                   ["--music-candidate", args.music_candidate] if args.music_candidate else []) if args.baseline else generated_project(directory)
            result = benchmark(directory, args, project)
    processor = platform.processor() or platform.machine()
    if platform.system() == "Darwin":
        processor = execute(["sysctl", "-n", "machdep.cpu.brand_string"])[0].stdout.strip()
    print(json.dumps({
        "openCut": json.loads(execute([*CLI, "--version", "--json"])[0].stdout)["version"],
        "hardware": {"processor": processor, "logicalCPUs": os.cpu_count(), "platform": platform.platform()},
        "ffmpeg": execute(["ffmpeg", "-version"])[0].stdout.splitlines()[0],
        "sourceRevision": execute(["git", "rev-parse", "HEAD"])[0].stdout.strip(),
        "workingTreeChanges": bool(execute(["git", "status", "--porcelain"])[0].stdout.strip()),
        "renderSettings": {"encoder": args.encoder, "quality": args.quality, "videoBitrateKbps": args.video_bitrate,
                           "recipeWorkers": 1},
        "project": "Generated transparent React/SVG wipe at 1080p and 4K, 60 fps" if args.graphics_only else
                   (str(args.baseline.resolve()) if args.baseline else "Generated 180×320, 24 fps, six-second project"),
        "runsPerCase": args.runs,
        "cacheDefinitions": {"cold": "Empty OpenCut picture and recipe caches; operating-system caches are uncontrolled.",
                             "warm": "A populated graphics raster cache with the picture cache cleared." if args.graphics_only else "Independent copy of the OpenCut caches seeded by the baseline."},
        "timing": "Command launch to verified publication. Stage clocks may overlap.",
        **result,
    }, indent=2))


if __name__ == "__main__":
    main()
