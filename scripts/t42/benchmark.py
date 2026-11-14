#!/usr/bin/env python3
"""T42 isolated benchmark. Generates its own inputs; never takes user media."""
import argparse
import hashlib
import json
import os
import plistlib
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
import time

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "tests/fixtures/generated"
FF = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n"]
PLAY = ["-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
LOSSLESS = ["-an", "-c:v", "ffv1", "-pix_fmt", "yuv420p"]


def run(args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def timed(args):
    start = time.monotonic()
    result = subprocess.run(["/usr/bin/time", "-l", *args], capture_output=True, text=True)
    stats = {"wallSeconds": time.monotonic() - start, "exitCode": result.returncode}
    for key, label in [("peakRssBytes", "maximum resident set size"),
                       ("peakFootprintBytes", "peak memory footprint")]:
        match = re.search(rf"^\s*(\d+)\s+{label}", result.stderr, re.MULTILINE)
        stats[key] = int(match[1]) if match else None
    if result.returncode:
        stats["error"] = result.stderr.splitlines()[0] if result.stderr else "No error output"
    return stats, result.stdout


def stage(args):
    stats, _ = timed(args)
    if stats["exitCode"]:
        raise RuntimeError(f"{args}: {stats}")
    return stats


def filters(src, dst, vf, codec):
    return stage([*FF, "-i", src, "-vf", vf, *codec, dst])


def fixture(path, w, h, fps, seconds, *, cut=True):
    label = path.parent / "label.png"
    motion = "overlay=x='30+mod(n*3,220)':y=30"
    source = f"testsrc2=s={w}x{h}:r={fps}:d={seconds}"
    graph = f"[0:v][1:v]{motion}"
    if cut and seconds > 1:
        # An abrupt orientation and palette change in the second shot.
        graph = (f"[0:v]split[p][q];[p]trim=end={seconds / 2},setpts=PTS-STARTPTS[a];"
                 f"[q]trim=start={seconds / 2},setpts=PTS-STARTPTS,hflip,hue=h=100[b];"
                 f"[a][b]concat=n=2:v=1:a=0[v];[v][1:v]{motion}")
    stage([*FF, "-f", "lavfi", "-i", source, "-i", label,
           "-filter_complex", graph, "-r", str(fps), *LOSSLESS, path])


def compare(reference, result, *, held_out=None):
    select = ""
    if held_out is not None:
        cut_frame, output_frames = held_out
        # Omit the midpoint at the known cut and the final held frame.
        select = (f"select='mod(n,2)*not(eq(n,{cut_frame * 2 - 1}))"
                  f"*lt(n,{output_frames - 1})',setpts=N/TB,")
    graph = f"[0:v]{select}format=yuv420p,split[a][b];[1:v]{select}format=yuv420p,split[c][d];[a][c]psnr[p];[b][d]ssim[s]"
    result = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", reference, "-i", result,
                             "-filter_complex", graph, "-map", "[p]", "-map", "[s]", "-f", "null", "-"],
                            check=True, text=True, capture_output=True)
    psnr = re.search(r"average:(\d+\.\d+|inf)", result.stderr)[1]
    return {"psnrDb": float(psnr) if psnr != "inf" else None, "psnrInfinite": psnr == "inf",
            "ssim": float(re.search(r"All:(\d+\.\d+)", result.stderr)[1])}


def verify_midpoints(path, w, h, cut, pix):
    size = w * h * 3 // 2 if pix == "nv12" else w * h * 4
    def digest(frame):
        block = frame.read(size)
        if block and len(block) != size:
            raise RuntimeError("Partial output frame")
        return hashlib.sha256(block).digest() if block else None
    with path.open("rb") as stream:
        first = digest(stream)
        unique = checked = holds = 0
        while first:
            mid, next_frame = digest(stream), digest(stream)
            if mid is None:
                raise RuntimeError("Odd frame count")
            if not next_frame or checked + holds + 1 == cut:
                if mid != first:
                    raise RuntimeError("Cut/final frame was not held")
                holds += 1
            else:
                unique += mid not in (first, next_frame)
                checked += 1
            first = next_frame
    if not checked or unique == 0:
        raise RuntimeError("No distinct intermediate frames")
    return {"distinctMidpoints": unique, "checkedMidpoints": checked, "boundaryHolds": holds}


def video_toolbox(work, effect, source, geometry, *, scale=1, cut=0, sample=None,
                  output_filter=None):
    w, h, fps = geometry
    pix = "rgba" if effect in ("frame-rate-conversion", "video-super-resolution") else "nv12"
    ow, oh = int(w * scale), int(h * scale)
    interpolate = effect.endswith("interpolation") or effect == "frame-rate-conversion"
    outfps = fps * (2 if interpolate else 1)
    raw_input, raw_output = work / "in.raw", work / "out.raw"
    try:
        decode = stage([*FF, "-i", source, "-pix_fmt", pix, "-f", "rawvideo", raw_input])
        stats, stdout = timed([work / "processor", effect, str(w), str(h), str(fps), str(scale),
                               str(cut), raw_input, raw_output])
        row = {"backend": effect, "input": [w, h, fps], "output": [ow, oh, outfps],
               "decodeToRaw": decode, "processing": stats,
               "status": "failed" if stats["exitCode"] else "completed"}
        if cut:
            row["sceneCutInputFrame"] = cut
        if stats["exitCode"]:
            return row
        native = json.loads(stdout)
        row["native"] = native
        row["processingOutputFps"] = native["outputFrames"] / stats["wallSeconds"]
        row["algorithmCallsPerSecond"] = native["processCalls"] / native["processSeconds"]
        if sample is not None:
            if interpolate:
                row["midpoints"] = verify_midpoints(raw_output, w, h, cut, pix)
            raw = ["-f", "rawvideo", "-pixel_format", pix, "-video_size", f"{ow}x{oh}",
                   "-framerate", str(outfps), "-i", raw_output]
            vf = ["-vf", output_filter] if output_filter else []
            row["encode"] = stage([*FF, *raw, *vf, *PLAY, sample])
            stage([*FF, *raw, *vf, *LOSSLESS, work / "result.mkv"])
        return row
    finally:
        raw_input.unlink(missing_ok=True)
        raw_output.unlink(missing_ok=True)


def software(work, effect, source, target, vf, input_geometry, output_geometry):
    lossless = work / "result.mkv"
    stats = filters(source, lossless, vf, LOSSLESS)
    return {"backend": effect, "status": "completed",
            "input": list(input_geometry), "output": list(output_geometry),
            "decodeFilterLosslessWrite": stats,
            "encode": stage([*FF, "-i", lossless, *PLAY, target])}


def probe_media(path, w, h, fps, frames):
    info = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                           "-show_entries", "stream=width,height,avg_frame_rate,nb_read_frames,sample_aspect_ratio",
                           "-of", "json", path]))["streams"][0]
    if ([info["width"], info["height"], info["avg_frame_rate"], int(info["nb_read_frames"])]
            != [w, h, f"{fps}/1", frames] or info.get("sample_aspect_ratio", "1:1") != "1:1"):
        raise RuntimeError(f"Unexpected stream geometry or timing: {info}")
    return info


def verify_sample(row, sample, reference, frames, *, cut=None, baseline=None,
                  minimum_ssim=None):
    if row["status"] != "completed":
        return
    lossless = reference.parent / "result.mkv"
    row["stream"] = probe_media(sample, *row["output"], frames)
    row["sample"] = sample.name
    if cut is None:
        row["quality"] = compare(reference, lossless)
    else:
        quality = compare(reference, lossless, held_out=(cut, frames))
        if minimum_ssim is not None and quality["ssim"] < minimum_ssim:
            raise RuntimeError(f"Rotated interpolation failed orientation check: {quality}")
        row["qualityHeldOutFrames"] = quality
    if baseline is not None:
        row["baselineQuality"] = baseline
    lossless.unlink()


def interpolation_fixture(work, geometry):
    w, h, fps = geometry
    reference, source = work / "ref.mkv", work / "src.mkv"
    fixture(reference, w, h, fps * 2, 2)
    vf = f"select='not(mod(n,2))',setpts=N/{fps}/TB"
    filters(reference, source, vf, ["-r", str(fps), *LOSSLESS])
    return reference, source


def interpolation_cases(out, work, save):
    for input_fps in (24, 30):
        for tag, w, h in (("wide", 1920, 1080), ("portrait", 1080, 1920)):
            geometry = (w, h, input_fps)
            reference, source = interpolation_fixture(work, geometry)
            stage([*FF, "-i", source, *PLAY, out / f"{tag}{input_fps}-original.mp4"])
            output_geometry = (w, h, input_fps * 2)
            for effect in ("duplicate", "low-latency-interpolation", "frame-rate-conversion"):
                sample = out / f"{tag}{input_fps}-{effect}.mp4"
                if effect == "duplicate":
                    row = software(work, effect, source, sample, f"fps={input_fps * 2}",
                                   geometry, output_geometry)
                else:
                    row = video_toolbox(work, effect, source, geometry,
                                        cut=input_fps, sample=sample)
                verify_sample(row, sample, reference, input_fps * 4, cut=input_fps)
                save(row)
            reference.unlink()
            source.unlink()


def upscayl_paths(resources):
    model_dir = resources / "models"
    model = "upscayl-standard-4x"
    return resources / "bin/upscayl-bin", model_dir, model


def upscayl_info(resources):
    runtime, model_dir, model = upscayl_paths(resources)
    checksums = {}
    for file in (runtime, model_dir / f"{model}.bin", model_dir / f"{model}.param"):
        with file.open("rb") as stream:
            checksums[file.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    plist = resources.parent / "Info.plist"
    version = None
    if plist.is_file():
        with plist.open("rb") as stream:
            version = plistlib.load(stream).get("CFBundleShortVersionString")
    return {"version": version, "model": model, "nativeScale": 4,
            "outputScale": 3, "sha256": checksums}


def upscayl_case(work, resources, source, sample, geometry, output_geometry, frames):
    runtime, model_dir, model = upscayl_paths(resources)
    with TemporaryDirectory(dir=work) as staging:
        images, enhanced = Path(staging) / "input", Path(staging) / "output"
        images.mkdir()
        enhanced.mkdir()
        decode = stage([*FF, "-i", source, images / "%03d.png"])
        process, _ = timed([runtime, "-i", images, "-o", enhanced, "-m", model_dir,
                            "-n", model, "-z", "4", "-s", "3", "-j", "1:1:1", "-f", "png"])
        row = {"backend": model, "status": "failed" if process["exitCode"] else "completed",
               "input": list(geometry), "output": list(output_geometry),
               "decodeToPng": decode, "modelLoadInferencePngIo": process}
        if process["exitCode"] == 0:
            image_input = ["-framerate", str(geometry[2]), "-i", enhanced / "%03d.png"]
            stage([*FF, *image_input, *LOSSLESS, work / "result.mkv"])
            row["encode"] = stage([*FF, *image_input, *PLAY, sample])
            row["processingOutputFps"] = frames / process["wallSeconds"]
        return row


def enhancement_fixture(work, geometry, scale, seconds):
    w, h, fps = geometry
    reference, source = work / "ref.mkv", work / "src.mkv"
    fixture(reference, int(w * scale), int(h * scale), fps, seconds)
    filters(reference, source, f"scale={w}:{h}:flags=area,setsar=1", LOSSLESS)
    return reference, source


def enhancement_cases(out, work, save, resources):
    for tag, w, h in (("wide", 1280, 720), ("portrait", 720, 1280)):
        for scale, fps, seconds in ((1.5, 24, 2), (3, 4, 1)):
            geometry = (w, h, fps)
            ow, oh = int(w * scale), int(h * scale)
            output_geometry = (ow, oh, fps)
            reference, source = enhancement_fixture(work, geometry, scale, seconds)
            prefix = f"{tag}-{oh}h"
            stage([*FF, "-i", source, *PLAY, out / f"{prefix}-source.mp4"])
            stage([*FF, "-i", reference, *PLAY, out / f"{prefix}-reference.mp4"])
            sample = out / f"{prefix}-lanczos.mp4"
            row = software(work, "lanczos", source, sample,
                           f"scale={ow}:{oh}:flags=lanczos,setsar=1", geometry, output_geometry)
            verify_sample(row, sample, reference, fps * seconds)
            save(row)

            effect = "low-latency-super-resolution"
            sample = out / f"{prefix}-{effect}.mp4"
            row = video_toolbox(work, effect, source, geometry, scale=scale, sample=sample)
            verify_sample(row, sample, reference, fps * seconds)
            save(row)

            # Measure the offline scaler at its native 4x. The follow-up converts
            # this output to UHD and evaluates quality against the same reference.
            cut = fps * seconds // 2 if seconds > 1 else 0
            save(video_toolbox(work, "video-super-resolution", source, geometry, scale=4, cut=cut))
            if resources is not None and scale == 3:
                sample = out / f"{prefix}-upscayl.mp4"
                row = upscayl_case(work, resources, source, sample, geometry, output_geometry,
                                   fps * seconds)
                verify_sample(row, sample, reference, fps * seconds)
                save(row)
            reference.unlink()
            source.unlink()


def denoise_cases(out, work, save):
    for tag, w, h in (("wide", 1920, 1080), ("portrait", 1080, 1920)):
        geometry = (w, h, 24)
        reference, source = work / "ref.mkv", out / f"{tag}-noisy-source.mp4"
        fixture(reference, *geometry, 2)
        filters(reference, source, "noise=alls=18:allf=t+u:all_seed=42", [*PLAY, "-crf", "27"])
        stage([*FF, "-i", reference, *PLAY, out / f"{tag}-clean-reference.mp4"])
        baseline = compare(reference, source)
        sample = out / f"{tag}-temporal-noise-filter.mp4"
        row = video_toolbox(work, "temporal-noise-filter", source, geometry, cut=24, sample=sample)
        verify_sample(row, sample, reference, 48, baseline=baseline)
        save(row)
        sample = out / f"{tag}-hqdn3d.mp4"
        row = software(work, "hqdn3d", source, sample, "hqdn3d=3:2:4.5:3", geometry, geometry)
        verify_sample(row, sample, reference, 48, baseline=baseline)
        save(row)
        reference.unlink()


def sustained_case(work, save, seconds):
    geometry = (1080, 1920, 30)
    source = work / "sustained.mkv"
    fixture(source, *geometry, seconds, cut=False)
    row = video_toolbox(work, "low-latency-interpolation", source, geometry)
    row["sustainedSourceSeconds"] = seconds
    save(row)


def native_follow_up(out, work, save):
    for tag, geometry in (("wide", (1280, 720, 4)), ("portrait", (720, 1280, 4))):
        w, h, fps = geometry
        reference, source = enhancement_fixture(work, geometry, 3, 1)
        portrait = w < h
        rotated = work / "rotated.mkv"
        if portrait:
            filters(source, rotated, "transpose=clock", LOSSLESS)
        sample = out / f"{tag}-apple-video-sr-uhd.mp4"
        normalize = ",transpose=cclock" if portrait else ""
        row = video_toolbox(work, "video-super-resolution", rotated if portrait else source,
                            (1280, 720, fps), scale=4, sample=sample,
                            output_filter=f"scale=3840:2160:flags=lanczos{normalize},setsar=1")
        row.update(nativeOutput=row["output"], nativeInput=row["input"], input=list(geometry),
                   output=[w * 3, h * 3, fps], rotatedForProcessing=portrait)
        verify_sample(row, sample, reference, fps)
        save(row)
        reference.unlink()
        source.unlink()
        rotated.unlink(missing_ok=True)

    geometry = (1080, 1920, 30)
    reference, source = interpolation_fixture(work, geometry)
    stored, tagged = work / "stored.mp4", work / "tagged.mp4"
    filters(source, stored, "transpose=clock", ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0"])
    stage([*FF, "-display_rotation", "90", "-i", stored, "-c", "copy", tagged])
    sample = out / "portrait-display-rotation-low-latency.mp4"
    row = video_toolbox(work, "low-latency-interpolation", tagged, geometry, cut=30, sample=sample)
    row.update(inputStorageGeometry=[1920, 1080], inputDisplayRotationDegrees=90)
    verify_sample(row, sample, reference, 120, cut=30, minimum_ssim=0.95)
    save(row)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label", help="New name below tests/fixtures/generated")
    parser.add_argument("--sdk", default=os.environ.get("SDKROOT"), help="macOS 26+ SDK path")
    parser.add_argument("--upscayl-resources", type=Path,
                        help="Opt in to a locally installed Upscayl Resources directory")
    parser.add_argument("--sustained-seconds", type=int, default=60, metavar="0..120")
    parser.add_argument("--native-follow-up", action="store_true",
                        help="Only test 4x Apple SR followed by UHD sizing, and display rotation metadata")
    opts = parser.parse_args()
    if not re.fullmatch(r"t42-[a-zA-Z0-9-]+", opts.label):
        parser.error("label must start with t42- and contain only letters, numbers and hyphens")
    if not 0 <= opts.sustained_seconds <= 120:
        parser.error("sustained seconds must be 0..120")
    if opts.upscayl_resources and opts.native_follow_up:
        parser.error("--upscayl-resources does not apply to --native-follow-up")
    sdk = opts.sdk or run(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"]).strip()
    out = GENERATED / opts.label
    out.mkdir(parents=True)
    with TemporaryDirectory(prefix="work-", dir=out) as work:
        benchmark(opts, out, Path(work), sdk)
    print(out / "benchmark.json")


def target_hardware_status(system):
    # Apple's model identifiers for the 13-inch and 15-inch M4 MacBook Air.
    if system["model"] in ("Mac16,12", "Mac16,13") and system["memory"]["installedBytes"] == 16 * 2**30:
        return "current-run"
    return "untested"


def benchmark(opts, out, work, sdk):
    run(["/usr/bin/clang", "-O2", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
         "-mmacosx-version-min=13.0", "-isysroot", sdk, "-framework", "Foundation",
         "-framework", "VideoToolbox", "-framework", "CoreMedia", "-framework", "CoreVideo",
         ROOT / "scripts/t42/processor.m", "-o", work / "processor"])
    run(["node", "-e", """
const sharp = require(process.argv[1]);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="310" height="38">' +
  '<rect width="310" height="38" fill="black"/>' +
  '<text x="8" y="28" font-family="Menlo" font-size="24" fill="white">OpenCut T42 012345</text></svg>';
sharp(Buffer.from(svg)).png().toFile(process.argv[2]).catch((error) => {
  console.error(error); process.exitCode = 1;
});
""", ROOT / "packages/media/node_modules/sharp", work / "label.png"])
    system = json.loads(run(["node", ROOT / "apps/cli/dist/index.js", "system", "inspect", "--json"]))
    if system["videoToolbox"]["status"] != "probed":
        raise RuntimeError("Build the CLI with a macOS 26+ SDK before running T42")
    report = {"version": 1, "dateUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "system": system, "ffmpeg": run(["ffmpeg", "-version"]).splitlines()[0],
              "reference": "Generated moving text and rectangles, with a known midpoint cut in two-shot fixtures.",
              "targetMacBookAirM4_16GB": target_hardware_status(system), "cases": []}
    resources = opts.upscayl_resources
    if resources is not None:
        resources = resources.resolve()
        report["upscayl"] = upscayl_info(resources)

    def save(row):
        report["cases"].append(row)
        pending = out / "benchmark.json.tmp"
        pending.write_text(json.dumps(report, indent=2) + "\n")
        pending.replace(out / "benchmark.json")
        print(row["backend"], row["input"], row["status"], flush=True)

    if opts.native_follow_up:
        native_follow_up(out, work, save)
    else:
        interpolation_cases(out, work, save)
        enhancement_cases(out, work, save, resources)
        denoise_cases(out, work, save)
        if opts.sustained_seconds:
            sustained_case(work, save, opts.sustained_seconds)


if __name__ == "__main__":
    main()
