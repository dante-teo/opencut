#!/usr/bin/env python3
"""Run CLI render profiles against generated sources. No tools or models are installed."""

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
CLI = ["node", str(ROOT / "apps/cli/dist/index.js")]
FIXTURES = ROOT / "tests/fixtures/generated"
FFMPEG = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
PROFILES = ("fast", "quality", "maximum")


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True)


def peak_tree_rss(root):
    children = {}
    rss = {}
    for row in run("/bin/ps", "-axo", "pid=,ppid=,rss=").splitlines():
        pid, parent, kib = map(int, row.split())
        children.setdefault(parent, []).append(pid)
        rss[pid] = kib
    descendants = [root]
    for pid in descendants:
        descendants.extend(children.get(pid, []))
    return sum(rss.get(pid, 0) for pid in descendants) * 1024


def measure(directory, *args):
    started = time.monotonic()
    peak = 0
    with tempfile.TemporaryFile(dir=directory) as out, tempfile.TemporaryFile(dir=directory) as err:
        with subprocess.Popen([*CLI, *args], cwd=ROOT, stdout=out, stderr=err) as child:
            try:
                while child.poll() is None:
                    peak = max(peak, peak_tree_rss(child.pid))
                    time.sleep(0.05)
            except KeyboardInterrupt:
                child.send_signal(signal.SIGINT)
                raise
        out.seek(0)
        err.seek(0)
        row = {
            "seconds": round(time.monotonic() - started, 3),
            "peakSampledTreeRssBytes": peak,
            "exitCode": child.returncode,
        }
        if child.returncode:
            row["diagnostic"] = err.read().decode(errors="replace")[-4000:]
        else:
            result = json.load(out)
            metadata = result.get("metadata", {})
            row.update({
                key: result[key]
                for key in ("quality", "frameCount", "durationSeconds", "recipeProcessing")
                if key in result
            })
            for stream in ("audio", "video"):
                if metadata.get(stream):
                    row[stream] = {
                        key: metadata[stream].get(key)
                        for key in ("startTimeSeconds", "durationSeconds")
                    }
        return row


def source(output, width, height, fps, seconds):
    run(*FFMPEG, "-f", "lavfi", "-i", f"testsrc2=s={width}x{height}:r={fps}:d={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:d={seconds}",
        "-c:v", "libx264", "-threads:v", "2", "-preset", "ultrafast", "-crf", "12",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-c:a", "aac", "-n", output)


def sample(input_file, output, filters, fps):
    run(*FFMPEG, "-i", input_file, "-vf", filters, "-r", str(fps), "-c:v", "libx264",
        "-threads:v", "2", "-preset", "ultrafast", "-qp", "0", "-c:a", "copy", "-n", output)


def definition(directory, name, input_file, width, height, fps, seconds, steps=(), twin=False):
    frames = fps * seconds
    assets = {"main": {"kind": "video", "path": os.path.relpath(input_file, directory), **({"recipe": steps} if steps else {})}}
    tracks = [
        {"type": "video", "clips": [{"asset": "main", "at": 0, "sourceOut": frames}]},
    ]
    if twin:
        assets["twin"] = {
            "kind": "video", "path": input_file.name,
            "recipe": [{**step, "sceneThreshold": 9} if step["type"] == "interpolateFrames" else step for step in steps],
        }
        tracks[0]["clips"].append({"asset": "twin", "at": frames, "sourceOut": frames})
        frames *= 2
    path = directory / f"{name}.video.ts"
    path.write_text("import { defineVideo } from '@opencut/sdk';\nexport default defineVideo(" +
                    json.dumps({
                        "name": name,
                        "canvas": {"width": width, "height": height, "frameRate": fps, "durationFrames": frames},
                        "assets": assets, "tracks": tracks,
                        "subtitles": {
                            "style": {"fontSize": 20},
                            "cues": [{
                                "id": "caption", "text": "Motion and audio",
                                "start": {"numerator": 0, "denominator": 1},
                                "end": {"numerator": 1, "denominator": 1},
                            }],
                        },
                    }, indent=2) + ");\n")
    return path


def compare(reference, output, *, held_out=False, temporal=False):
    # Exclude the subtitle area for pixel metrics. Omit the last held frame
    # from interpolated results, and compare only synthesized odd positions.
    selection = "select='mod(n,2)*lt(n,PREV_LAST)',settb=1/48,setpts=N," if held_out else ""
    if held_out:
        frame_count = run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                  "stream=nb_frames", "-of", "csv=p=0", output)
        selection = selection.replace("PREV_LAST", str(int(frame_count.strip()) - 1))
    filters = f"{selection}crop=iw:trunc(ih*0.75/2)*2:0:0,format=yuv420p"
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", reference, "-i", output,
         "-filter_complex", f"[0:v]{filters},split[a][b];[1:v]{filters},split[c][d];[a][c]psnr=shortest=1[p];[b][d]ssim=shortest=1[s]",
         "-map", "[p]", "-map", "[s]", "-f", "null", "-"],
        text=True, capture_output=True, check=True,
    ).stderr
    def psnr(log):
        value = re.search(r"average:([\d.]+|inf)", log)[1]
        return float(value) if value != "inf" else "infinite"

    metrics = {"psnrDb": psnr(result), "ssim": float(re.search(r"All:([\d.]+)", result)[1])}
    if temporal:
        delta = "crop=iw:trunc(ih*0.75/2)*2:0:0,format=yuv420p,tblend=all_mode=difference,settb=1/48,setpts=N"
        log = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-i", reference, "-i", output,
             "-filter_complex", f"[0:v]{delta}[a];[1:v]{delta}[b];[a][b]psnr=shortest=1",
             "-f", "null", "-"], text=True, capture_output=True, check=True,
        ).stderr
        metrics["temporalPsnrDb"] = psnr(log)
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label", help="new directory name under tests/fixtures/generated")
    parser.add_argument("--sustained-seconds", type=int, default=30)
    parser.add_argument("--action-fixture", type=Path,
                        help="optional generated 24 fps SDR action excerpt with at least two seconds of video")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.label) or args.sustained_seconds < 0:
        parser.error("use a simple label and a nonnegative sustained duration")
    action = args.action_fixture.resolve() if args.action_fixture else None
    if action and (not action.is_file() or not action.is_relative_to(FIXTURES)):
        parser.error("--action-fixture must identify a file already inside the generated fixtures directory")
    directory = FIXTURES / args.label
    directory.mkdir(parents=True)
    system = json.loads(run(*CLI, "system", "inspect", "--json"))
    report = {"system": system, "ffmpeg": run("ffmpeg", "-version").splitlines()[0], "cases": {}}

    def record(name, *command, reference=None, output=None, held_out=False, temporal=False):
        row = measure(directory, *command, "--json")
        if output and not row["exitCode"]:
            row["output"] = output.name
            row["outputBytes"] = output.stat().st_size
            if reference:
                row.update(compare(reference, output, held_out=held_out, temporal=temporal))
        report["cases"][name] = row
        (directory / "benchmark.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"{name}: {row['seconds']:.3f}s, exit {row['exitCode']}", flush=True)

    for width, height, seconds in ((1920, 1080, 12), (3840, 2160, 2)):
        name = f"normal-{height}"
        original = directory / f"{name}-source.mp4"
        source(original, width, height, 24, seconds)
        script = definition(directory, name, original, width, height, 24, seconds)
        if height == 1080:
            cache = directory / "normal-compile-cache"
            for state in ("cold", "warm"):
                record(f"definition-{state}", "validate", script, "--recipe-cache", cache)
            record("preview-default", "preview", "clip", script, "--from", "0", "--to", "48",
                   "--output", directory / "preview-default.mp4")
            for frame in (0, 264):
                output = directory / f"seek-{frame}.png"
                record(f"seek-{frame}", "preview", "frame", script, "--frame", str(frame), "--size", "640",
                       "--output", output, output=output)
        for profile in PROFILES:
            output = directory / f"{name}-{profile}.mp4"
            record(f"{name}-{profile}", "render", script, "--quality", profile,
                   "--output", output, reference=original, output=output)

    truth = directory / "reference-48.mp4"
    truth_low = directory / "reference-low-48.mp4"
    truth_24 = directory / "reference-24.mp4"
    ai_input = directory / "ai-input.mp4"
    source(truth, 960, 540, 48, 2)
    sample(truth, truth_low, "scale=640:360:flags=lanczos", 48)
    decimate = "select='not(mod(n,2))',setpts=N/24/TB"
    sample(truth, truth_24, decimate, 24)
    sample(truth_low, ai_input, decimate, 24)
    interpolation = {"type": "interpolateFrames", "numerator": 48}
    upscale = {"type": "superResolution", "width": 960, "height": 540}
    for name, steps, reference, width, height, fps in (
        ("interpolation", [interpolation], truth_low, 640, 360, 48),
        ("super-resolution", [upscale], truth_24, 960, 540, 24),
        ("combined", [interpolation, upscale], truth, 960, 540, 48),
    ):
        script = definition(directory, name, ai_input, width, height, fps, 2, steps)
        for profile in PROFILES:
            cache = directory / f"{name}-{profile}-cache"
            for state in ("cold", "warm"):
                output = directory / f"{name}-{profile}-{state}.mp4"
                record(f"{name}-{profile}-{state}", "render", script, "--quality", profile,
                       "--recipe-cache", cache, "--output", output, output=output,
                       reference=reference, held_out=fps == 48, temporal=state == "cold")

    if action:
        probe = json.loads(run("ffprobe", "-v", "error", "-select_streams", "v:0",
                               "-show_entries", "stream=width,height,avg_frame_rate,duration",
                               "-of", "json", action))["streams"][0]
        if probe["avg_frame_rate"] != "24/1" or float(probe.get("duration", 0)) < 2:
            parser.error("--action-fixture must have at least two seconds of 24 fps video")
        script = definition(directory, "action", action, probe["width"], probe["height"], 48, 2,
                            [{"type": "trim", "start": 0, "end": 2}, interpolation])
        for profile in PROFILES:
            output = directory / f"action-{profile}.mp4"
            record(f"action-{profile}", "render", script, "--quality", profile,
                   "--recipe-cache", directory / f"action-{profile}-cache", "--output", output, output=output)

    twin = definition(directory, "combined-twin", ai_input, 960, 540, 48, 2,
                      [interpolation, upscale], twin=True)
    for workers in (1, 2):
        output = directory / f"combined-{workers}-workers.mp4"
        record(f"combined-{workers}-workers", "render", twin, "--recipe-workers", str(workers),
               "--recipe-cache", directory / f"workers-{workers}-cache", "--output", output, output=output)
    output = directory / "combined-2-workers-budget-4gib.mp4"
    record("combined-2-workers-budget-4gib", "render", twin, "--recipe-workers", "2",
           "--recipe-memory-bytes", str(4 * 1024 ** 3),
           "--recipe-cache", directory / "workers-2-budget-4gib-cache", "--output", output, output=output)

    if args.sustained_seconds:
        original = directory / "sustained-source.mp4"
        source(original, 640, 360, 24, args.sustained_seconds)
        script = definition(directory, "sustained", original, 640, 360, 48,
                            args.sustained_seconds, [interpolation])
        for profile in ("fast", "quality"):
            report[f"sustained-{profile}-before"] = telemetry()
            output = directory / f"sustained-{profile}.mp4"
            record(f"sustained-{profile}", "render", script, "--quality", profile,
                   "--recipe-cache", directory / f"sustained-{profile}-cache", "--output", output, output=output)
            report[f"sustained-{profile}-after"] = telemetry()
    (directory / "benchmark.json").write_text(json.dumps(report, indent=2) + "\n")


def telemetry():
    status = json.loads(run(*CLI, "system", "inspect", "--json"))
    return {"thermalState": status["videoToolbox"].get("thermalState"),
            "memoryPressure": status["rendering"]["resources"]["memoryPressure"]}


if __name__ == "__main__":
    main()
