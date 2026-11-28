#!/usr/bin/env python3
"""Measure the audio-dependent preview, MP4 index and software export workflows."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import resource
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--cli", type=Path, default=ROOT / "apps/cli/dist/index.js")
parser.add_argument("--runs", type=int, default=3)
args = parser.parse_args()
if args.runs < 1:
    parser.error("--runs must be positive")
entry = args.cli.resolve(strict=True)
measure = runpy.run_path(str(ROOT / "tests/reference-motion/measure.py"))["run"]
generated = ROOT / "tests/fixtures/generated"
if generated.is_symlink():
    parser.error("The generated fixture directory must not be a symlink")
generated.mkdir(parents=True, exist_ok=True)


def ffmpeg(*args):
    return subprocess.check_output(["ffmpeg", "-v", "error", "-nostdin", *args])

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def definition(path, value):
    path.write_text("export default " + json.dumps(value) + ";\n")

with tempfile.TemporaryDirectory(dir=generated, prefix="hybrid-bench-") as temporary:
    work = Path(temporary)
    os.chdir(work)
    scratch = work / "scratch"
    scratch.mkdir()
    frames = 30 * 480
    ffmpeg("-f", "lavfi", "-i", "sine=f=221:sample_rate=48000:d=480", str(work / "tōne.wav"))
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30000/1001:d=3", "-threads", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(work / "plate.mp4"))
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=300", "-threads", "2", "-c:v", "libx264", str(work / "long.mp4"))
    definition(work / "spectrum.video.ts", {
        "version": 3,
        "canvas": {"width": 192, "height": 108, "frameRate": 30, "durationFrames": frames, "backgroundColor": "#101818"},
        "assets": {
            "input": {"kind": "audio", "path": "tōne.wav"},
            "view": {"kind": "graphic", "renderer": "scene", "durationFrames": frames,
                "audioAnalysis": {"version": 1, "source": "mix", "window": 4096, "hop": 256, "waveform": 16, "bins": 48},
                "scene": {"version": 1, "units": "px", "children": [
                    {"id": "fft", "type": "audio", "mode": "spectrum", "x": 0, "y": 10,
                     "width": 192, "height": 90, "gain": 10, "color": "#55ffee"}]}}},
        "tracks": [{"id": "picture", "type": "video", "clips": [{"asset": "view", "at": 0, "sourceOut": frames}]},
                   {"id": "sound", "type": "audio", "clips": [{"asset": "input", "at": 0, "sourceOut": frames}]}]})
    definition(work / "media.video.ts", {
        "version": 3,
        "canvas": {"width": 640, "height": 360, "frameRate": 30, "durationFrames": 72},
        "assets": {"plate": {"kind": "video", "path": "plate.mp4"}},
        "tracks": [{"id": "picture", "type": "video", "clips": [
            {"asset": "plate", "at": 0, "sourceIn": 6, "sourceOut": 42},
            {"asset": "plate", "at": 36, "sourceIn": 30, "sourceOut": 66}]}]})
    rows = {}
    cli = ["node", str(entry)]
    def run(case, repeat, command, output):
        name = f"{case}-{repeat}"
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        result = measure([*cli, *map(str, command), "--output", output, "--json"], work, scratch, name, 8 * 2**30, 10 * 2**30)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        result["childCpuSeconds"] = round(
            after.ru_utime - before.ru_utime + after.ru_stime - before.ru_stime, 3,
        )
        if result["exitCode"]:
            raise RuntimeError((work / (name + ".stderr")).read_text())
        path = work / output
        if path.suffix == ".png":
            result["picture"] = sha(path)
        else:
            result["picture"] = ffmpeg("-i", str(path), "-map", "0:v:0", "-f", "hash", "-").decode().strip()
        rows.setdefault(case, []).append(result)
    for i in range(args.runs):
        for mode in ("cold", "warm"):
            run(f"spectrum-{mode}", i, ["preview", "frame", "spectrum.video.ts", "--frame", 7500,
                                        "--recipe-cache", f"recipe-{i}"], f"spectrum-{mode}-{i}.png")
        run("index", i, ["preview", "contact-sheet", "long.mp4", "--frames", "0,4500,8999"], f"index-{i}.png")
        for name, width, height in [("1080p", 1920, 1080), ("4K", 3840, 2160)]:
            run(name + "-render", i, ["render", "media.video.ts", "--encoder", "software",
                "--quality", "fast", "--width", width, "--height", height], f"{name}-{i}.mp4")
    print(json.dumps(rows, indent=2))
