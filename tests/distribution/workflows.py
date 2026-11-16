"""Evaluate installed OpenCut in a fresh project using its public CLI only."""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import time
import traceback
from array import array
from pathlib import Path


class UnavailableAI(Exception):
    pass


def processor_reason(system, name, width, height, *, scale=1, requires_model=False):
    probe = (system or {}).get("videoToolbox", {})
    if probe.get("status") != "probed":
        return f"VideoToolbox probe: {probe.get('reason', probe.get('status', 'unavailable'))}"
    processor = probe["frameProcessors"][name]
    if processor["status"] != "reported-supported":
        return f"{name}: {processor['status']}"
    for size in processor["testedSizes"]:
        if (size["width"], size["height"]) != (width, height):
            continue
        for config in size["configurations"]:
            if config["scale"] == scale and config["status"] == "configuration-accepted":
                status = config["modelStatus"]
                return None if not requires_model or status == "ready" else f"{name}: {status}"
    return f"{name}: no accepted configuration for {width}×{height} at {scale}×"


def ai_start(test, label, *args, unavailable):
    result = test.run(label, *args, expected=(0, 1))
    if test.metrics[label]["exitCode"] == 0:
        return result
    diagnostic = (test.project / f"{label}.log").read_text()
    for line in reversed(diagnostic.splitlines()):
        if line.startswith('{"ok":false,'):
            error = json.loads(line)["error"]
            if error["code"] == "PROCESSING_FAILED" and re.search(unavailable, error["message"]):
                raise UnavailableAI(error["message"].splitlines()[0])
            break
    raise AssertionError(diagnostic)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def media_tools(tool, *args):
    return subprocess.check_output([tool, "-v", "error", *args], timeout=120)


def subtree(pid):
    ps = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,rss="], text=True)
    rows = [tuple(map(int, row.split())) for row in ps.splitlines()]
    found = {pid}
    while new := {child for child, parent, _ in rows if parent in found} - found:
        found.update(new)
    return {child: rss * 1024 for child, _, rss in rows if child in found}


def allocated(directory, exclude=()):
    total = 0
    for parent, directories, files in os.walk(directory):
        directories[:] = [name for name in directories if Path(parent, name) not in exclude]
        for name in files:
            path = Path(parent, name)
            try:
                total += path.stat().st_blocks * 512
            except FileNotFoundError:
                pass
    return total


class Evaluation:
    def __init__(self, cli, project):
        self.cli = cli
        self.project = project
        self.cache = project / "cache"
        scratch = project / "scratch"
        scratch.mkdir()
        self.cache.mkdir()
        self.env = dict(os.environ, XDG_CACHE_HOME=str(self.cache), TMPDIR=str(scratch),
                        OPENCUT_DIALOGUE_PYTHON=str(project / "missing-python"))
        for key in ("NODE_PATH", "NODE_OPTIONS", "SDKROOT"):
            self.env.pop(key, None)
        self.env["DEVELOPER_DIR"] = "/var/empty"
        self.metrics = {}

    def run(self, label, *args, expected=0, interrupt_at=None):
        json_output = interrupt_at is None
        stdout_path = self.project / f"{label}.json"
        stderr_path = self.project / f"{label}.log"
        start = time.monotonic()
        interrupted = None
        excluded = (self.cache, self.project / "media")
        project_before = allocated(self.project, excluded)
        peak_rss = peak_project_growth = peak_cache = 0
        children = set()
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr, subprocess.Popen(
            [self.cli, *args, *(["--json"] if json_output else [])], cwd=self.project,
            env=self.env, stdout=stdout, stderr=stderr, start_new_session=True,
        ) as job:
            try:
                while job.poll() is None:
                    processes = subtree(job.pid)
                    children.update(processes.keys() - {job.pid})
                    peak_rss = max(peak_rss, sum(processes.values()))
                    peak_project_growth = max(
                        peak_project_growth, allocated(self.project, excluded) - project_before)
                    peak_cache = max(peak_cache, allocated(self.cache))
                    now = time.monotonic()
                    if interrupt_at and interrupted is None and interrupt_at in stderr_path.read_text():
                        job.send_signal(signal.SIGINT)
                        interrupted = now
                    if now - start > 600 or (interrupted is not None and now - interrupted > 10):
                        raise TimeoutError(label)
                    time.sleep(0.05)
            finally:
                if job.poll() is None:
                    os.killpg(job.pid, signal.SIGKILL)
                    job.wait()
        self.metrics[label] = {
            "exitCode": job.returncode, "seconds": round(time.monotonic() - start, 3),
            "peakSampledRssBytes": peak_rss, "peakSampledWorkspaceGrowthBytes": peak_project_growth,
            "peakSampledCacheBytes": peak_cache,
        }
        if interrupt_at:
            assert interrupted is not None, stderr_path.read_text()
            self.metrics[label]["cancellationSeconds"] = round(time.monotonic() - interrupted, 3)
            pids = subprocess.check_output(["/bin/ps", "-axo", "pid="], text=True)
            assert not children.intersection(map(int, pids.split())), "Worker survived cancellation"
        exit_codes = (expected,) if isinstance(expected, int) else expected
        assert job.returncode in exit_codes, f"{label}: {stderr_path.read_text()[-3000:]}"
        result = stdout_path.read_text()
        return json.loads(result) if json_output and result.strip() else None

    def render(self, label, definition, *args):
        return self.run(label, "render", definition, *args, "-o", f"{label}.mp4")

    def params(self, name, **data):
        path = self.project / f"{name}.params.json"
        path.write_text(json.dumps(data), encoding="utf8")
        return ["--params", path.name]

    def probe(self, name, width, height, fps, count):
        path = self.project / name
        data = json.loads(media_tools(
            "ffprobe", "-show_streams", "-show_frames", "-select_streams", "v:0", "-of", "json", path,
        ))
        video, = data["streams"]
        assert (video["width"], video["height"]) == (width, height)
        stamps = [float(frame["best_effort_timestamp_time"]) for frame in data["frames"]]
        assert len(stamps) == count
        assert all(abs(stamp - tick / fps) < 0.000002 for tick, stamp in enumerate(stamps))
        assert abs(float(video["duration"]) - count / fps) < 0.001
        media_tools("ffmpeg", "-xerror", "-i", path, "-f", "null", "-")
        return {"width": width, "height": height, "fps": fps, "frames": count,
                "duration": count / fps, "sha256": digest(path)}

    def frames(self, name, frames, width, height, color="gray"):
        select = "+".join(f"eq(n\\,{frame})" for frame in frames)
        pixels = media_tools(
            "ffmpeg", "-i", self.project / name, "-vf", f"select={select},scale={width}:{height}",
            "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", color, "-",
        )
        stride = width * height * (3 if color == "rgb24" else 1)
        assert len(pixels) == len(frames) * stride
        return [pixels[i:i + stride] for i in range(0, len(pixels), stride)]


def verify_social(test, files):
    definition = "social.video.ts"
    test.run("social-valid", "validate", definition)
    draft = test.run("social-preview", "preview", "clip", definition,
                     "--from", "0", "--to", "96", "-o", "social-preview.mp4")
    assert draft["quality"] == "fast"
    test.run("social-draft-frame", "preview", "frame", definition,
             "--frame", "25", "-o", "social-draft.png")
    revise(test, definition, "城市漫游", "城市风景")
    test.run("social-revised-preview", "preview", "contact-sheet", definition,
             "--count", "4", "-o", "social-revised.png")
    test.run("social-revised-frame", "preview", "frame", definition,
             "--frame", "25", "-o", "social-caption.png")
    result = test.render("social", definition)
    assert result["quality"] == "quality"
    files["social"] = test.probe("social.mp4", 360, 640, 24, 96)
    audio = result["metadata"]["audio"]
    assert audio["codec"] == "aac" and abs(audio["startTimeSeconds"]) < 1 / 24
    assert abs(audio["durationSeconds"] - 4) < 1 / 24
    first, last = test.frames("social.mp4", [47, 48], 90, 160, "rgb24")
    assert sum(abs(a - b) for a, b in zip(first, last)) / len(first) > 15
    draft_frame, = test.frames("social-draft.png", [0], 360, 640)
    revised_frame, = test.frames("social-caption.png", [0], 360, 640)
    assert draft_frame[:360 * 320] == revised_frame[:360 * 320]
    assert draft_frame[360 * 320:] != revised_frame[360 * 320:]
    samples = array("h", media_tools("ffmpeg", "-i", test.project / "social.mp4",
                                    "-ac", "1", "-ar", "48000", "-f", "s16le", "-"))
    assert abs(len(samples) / 48000 - 4) < 1 / 24

    def rms(window):
        return math.sqrt(sum(sample ** 2 for sample in window) / len(window))

    early = rms(samples[0:4800])
    late = rms(samples[187200:192000])
    assert early > 500 and late < early / 4
    files["social"]["decodedAudioRms"] = {"first100ms": early, "last100ms": late}
    test.run("social-captions", "subtitles", "export", definition, "-o", "captions.srt")
    captions = (test.project / "captions.srt").read_text()
    assert "00:00:01,000 --> 00:00:02,000\n城市风景" in captions
    assert "00:00:02,000 --> 00:00:04,000\n沿河而行" in captions

    variants = test.project / "variants.json"
    entries = [
        {"id": "valid", "params": {"caption": "你好"}},
        {"id": "retry", "params": {"caption": 42}},
    ]
    variants.write_text(json.dumps(entries))
    args = ("batch", definition, "--variants", variants.name, "--output-dir", "variants")
    batch = test.run("batch", *args, expected=1)
    assert [entry["status"] for entry in batch["variants"]] == ["completed", "failed"]
    previous = digest(test.project / "variants/valid.mp4")
    entries[1]["params"]["caption"] = "新版本"
    variants.write_text(json.dumps(entries))
    retry = test.run("batch-retry", *args, "--only", "retry")
    assert [(entry["id"], entry["status"]) for entry in retry["variants"]] == [("retry", "completed")]
    assert digest(test.project / "variants/valid.mp4") == previous


def verify_motion(test, files):
    definition = "motion.video.ts"
    ai_start(test, "motion-preview", "preview", "clip", definition,
             "--quality", "quality", "--recipe-cache", "cache/draft-motion",
             "--from", "44", "--to", "52", "-o", "motion-preview.mp4",
             unavailable=r"VideoToolbox could not initialize the interpolation model")
    revise(test, definition, "exposure: 0.15", "exposure: 0.20")
    result = test.render("motion", definition)
    assert result["quality"] == "quality" and result["recipeProcessing"][0]["status"] == "completed"
    files["motion"] = test.probe("motion.mp4", 640, 360, 24, 96)

    def center(frame):
        mask = [i for i, luma in enumerate(frame) if luma > 120]
        return (sum(i % 640 for i in mask) / len(mask), sum(i // 640 for i in mask) / len(mask))

    frames = test.frames("motion.mp4", [12, 13, 14, 46, 47, 48], 640, 360)
    truth, = test.frames("media/motion-reference.mp4", [13], 640, 360)
    centers = list(map(center, frames))
    first, between, last, before_cut, held, after_cut = centers
    assert first[0] < between[0] < last[0]
    assert abs(between[0] - center(truth)[0]) <= 4
    assert abs(before_cut[1] - held[1]) < 2 and after_cut[1] - held[1] > 100
    files["motion"]["decodedCenters"] = centers
    maximum = test.render("motion-maximum", definition, "--quality", "maximum")
    assert maximum["quality"] == "maximum"
    assert maximum["recipeProcessing"][0]["status"] == "cache-hit"
    assert maximum["recipeProcessing"][0]["key"] == result["recipeProcessing"][0]["key"]
    files["motionMaximum"] = test.probe("motion-maximum.mp4", 640, 360, 24, 96)


def verify_uhd(test, files):
    definition = "enhance.video.ts"
    test.run("uhd-fast-unsupported", "preview", "frame", definition,
             "--frame", "0", "-o", "uhd-fast.png", expected=1)
    fast_error = (test.project / "uhd-fast-unsupported.log").read_text()
    assert "2×" in fast_error or "2x" in fast_error, fast_error
    assert not (test.project / "uhd-fast.png").exists()
    ai_start(test, "uhd-preview", "preview", "frame", definition,
             "--quality", "quality", "--recipe-cache", "cache/draft-uhd",
             "--frame", "0", "-o", "uhd-preview.png",
             unavailable=r"super-resolution model (requires a download|is still downloading)")
    revise(test, definition, "saturation: 1,", "saturation: 0.98,")
    result = test.render("uhd", definition)
    assert result["recipeProcessing"][0]["status"] == "completed"
    files["uhd"] = test.probe("uhd.mp4", 3840, 2160, 12, 12)


def verify_lanczos(test, files):
    test.render("lanczos", "enhance.video.ts", *test.params("lanczos", method="lanczos"))
    files["lanczos"] = test.probe("lanczos.mp4", 3840, 2160, 12, 12)
    args = ("-filter_complex", "psnr", "-an", "-f", "null", "-")
    for output in ("uhd", "lanczos") if "uhd" in files else ("lanczos",):
        process = subprocess.run(
            ["ffmpeg", "-v", "info", "-i", f"{output}.mp4", "-i", "media/uhd-reference.mp4", *args],
            cwd=test.project, capture_output=True, text=True, check=True, timeout=120,
        )
        files[output]["psnrDb"] = float(re.findall(r"average:(\d+\.\d+)", process.stderr)[-1])
    if "uhd" not in files:
        return
    ai = test.frames("uhd.mp4", [0, 4, 8], 960, 540)
    baseline = test.frames("lanczos.mp4", [0, 4, 8], 960, 540)
    assert all(a != b for a, b in zip(ai, baseline))


def revise(test, name, old, new):
    path = test.project / name
    original = path.read_text(encoding="utf8")
    assert original.count(old) == 1, f"{name} must contain exactly one {old!r}"
    path.with_name(name.replace(".video.ts", "-draft.video.ts")).write_text(
        original, encoding="utf8",
    )
    path.write_text(original.replace(old, new), encoding="utf8")


def verify_failures(test):
    invalid = test.project / "invalid.video.ts"
    invalid.write_text("export default { canvas: { width: 0 } };\n")
    test.run("invalid", "validate", invalid.name, expected=1)
    test.run("missing", "separate-dialogue", "media/music.wav", "-o", "stems", expected=1)
    resize = test.params("memory-limit", method="lanczos")
    test.run("memory-limit", "render", "enhance.video.ts", *resize,
             "--recipe-memory-bytes", str(32 * 1024 * 1024), "--recipe-cache", "cache/limited",
             "-o", "failed.mp4", expected=1)
    assert not (test.project / "failed.mp4").exists()
    assert "INVALID_VIDEO_DEFINITION" in (test.project / "invalid.log").read_text()
    assert "MISSING_DEPENDENCY" in (test.project / "missing.log").read_text()
    diagnostic = (test.project / "memory-limit.log").read_text()
    assert "Recipe step exceeded its native memory limit." in diagnostic, diagnostic


def verify_denoise(test, files, reason):
    definition = "enhance.video.ts"
    flags = test.params("denoise", method="denoise")
    if reason in ("temporal-noise-filter: hardware-unsupported", "temporal-noise-filter: os-unavailable"):
        test.run("denoise-unsupported", "render", definition, *flags,
                 "-o", "denoise.mp4", expected=1)
        diagnostic = (test.project / "denoise-unsupported.log").read_text()
        assert re.search(r"temporal denoising is unsupported|AI enhancement requires Apple Silicon and macOS 26",
                         diagnostic), diagnostic
        assert not (test.project / "denoise.mp4").exists()
    if reason:
        raise UnavailableAI(reason)
    ai_start(test, "denoise", "render", definition, *flags, "-o", "denoise.mp4",
             unavailable=r"VideoToolbox could not initialize the enhancement model")
    files["denoise"] = test.probe("denoise.mp4", 3840, 2160, 12, 12)


def verify_recovery(test, files, *, software):
    definition = "motion.video.ts"
    flags = test.params("sustained", seconds=30, software=software)
    count = 720 if software else 1440
    test.render("sustained", definition, *flags)
    files["sustained"] = test.probe("sustained.mp4", 640, 360, 24, count)
    previous = files["sustained"]["sha256"]
    args = ("render", definition, *flags, "-o", "sustained.mp4", "--overwrite")
    test.run("interrupt", *args, expected=130, interrupt_at="rendering:")
    assert digest(test.project / "sustained.mp4") == previous
    receipt = test.run("receipt", "build", "inspect", definition, *flags)
    assert any(step["reusable"] for step in receipt["steps"])
    retry = test.run("recover", *args)
    assert retry["recipeProcessing"][0]["status"] == "cache-hit"
    files["recovered"] = test.probe("sustained.mp4", 640, 360, 24, count)


def verify_package(test, package, files):
    example = Path("examples/video/opening-card.video.ts")
    for relative in (
        "docs/INSTALL.md", "docs/CLI.md", "docs/SDK.md",
        "docs/VIDEO_DEFINITIONS.md", "skills/video-editor/SKILL.md",
        "skills/video-editor/references/cli.md", "skills/video-editor/references/sdk.md",
        "skills/video-editor/references/video-definitions.md",
        "skills/video-editor/references/workflow.md", example,
    ):
        path = package / relative
        assert path.is_file() and path.stat().st_size > 0, f"Missing installed file {relative}"
    # Follow the installed Skill. Node's TypeScript loader rejects definitions
    # under node_modules, even when the definition ships in the package.
    shutil.copyfile(package / example, test.project / example.name)
    test.render("opening", example.name)
    files["opening"] = test.probe("opening.mp4", 640, 360, 24, 48)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cli", type=Path)
    parser.add_argument("project", type=Path, help="Fresh directory outside the checkout")
    parser.add_argument("media", type=Path)
    parser.add_argument("--package-dir", type=Path, help="Also verify the installed guides and example")
    args = parser.parse_args()
    project = args.project.resolve()
    project.mkdir()
    shutil.copytree(args.media, project / "media")
    for name in ("social", "motion", "enhance"):
        shutil.copyfile(Path(__file__).with_name(f"{name}.video.ts"), project / f"{name}.video.ts")
    test = Evaluation(args.cli.absolute(), project)
    files = {}
    problems = {}
    skipped = {}

    def evaluate(name, verify, *inputs, **settings):
        try:
            return verify(*inputs, **settings)
        except UnavailableAI as error:
            skipped[name] = str(error)
        except (AssertionError, LookupError, OSError, TypeError, ValueError, subprocess.SubprocessError) as error:
            location = traceback.extract_tb(error.__traceback__)[-1]
            problems[name] = f"{location.name}:{location.lineno}: {error or type(error).__name__}"
            return None

    def doctor_system():
        result = test.run("doctor", "doctor")
        assert result["media"]["ready"], result["media"]
        return result["system"]

    def optional(name, verify, reason):
        if reason:
            skipped[name] = reason
        else:
            evaluate(name, verify, test, files)

    try:
        system = evaluate("doctor", doctor_system)
        if args.package_dir is not None:
            evaluate("package", verify_package, test, args.package_dir.resolve(), files)
        evaluate("social", verify_social, test, files)
        optional("interpolation", verify_motion,
                 processor_reason(system, "frame-rate-conversion-quality", 640, 360))
        optional("super-resolution", verify_uhd,
                 processor_reason(system, "video-super-resolution", 960, 540, scale=4, requires_model=True))
        evaluate("lanczos", verify_lanczos, test, files)
        evaluate("failures", verify_failures, test)
        evaluate("denoise", verify_denoise, test, files,
                 processor_reason(system, "temporal-noise-filter", 960, 540))
        evaluate("recovery", verify_recovery, test, files, software="motion" not in files)
        evaluate("system-after", test.run, "system-after", "system", "inspect")
    finally:
        summary = {
            "inputs": {path.name: digest(path) for path in sorted((project / "media").iterdir())},
            "definitions": {path.name: digest(path) for path in sorted(project.glob("*.video.ts"))},
            "commands": test.metrics, "decodedMedia": files, "skipped": skipped, "failures": problems,
        }
        (project / "evaluation.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(project / "evaluation.json")
    for name, reason in skipped.items():
        print(f"{name} skipped: {reason}")
    for name, problem in problems.items():
        print(f"{name}: {problem}")
    return bool(problems)


if __name__ == "__main__":
    raise SystemExit(main())
