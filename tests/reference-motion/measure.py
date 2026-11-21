"""Run and measure the pinned OpenCut public workflows in private fixture directories."""

import argparse
import json
import os
import signal
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "fixtures/generated/reference-motion"


def rss(session, observed):
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,rss="], text=True)
    processes = [tuple(map(int, row.split())) for row in rows.splitlines() if len(row.split()) == 4]
    included = {p for p, _, group, _ in processes if group == session}
    included.update(observed)
    included.add(session)
    changed = True
    while changed:
        children = {p for p, parent, _, _ in processes if parent in included}
        changed = bool(children - included)
        included.update(children)
    observed.update(included)
    return sum(kb * 1024 for p, _, _, kb in processes if p in included)


def temporary(folder):
    total = 0
    for path in folder.rglob("*"):
        try:
            if path.is_file():
                stat = path.stat()
                total += stat.st_blocks * 512
        except FileNotFoundError:
            continue
    return total


def run(command, folder, scratch, name, memory_bytes, disk_bytes, stop_after=None):
    log = folder / (name + ".stderr")
    result = folder / (name + ".json")
    started = time.monotonic()
    peak_rss = peak_scratch = 0
    observed = set()
    cancellation = None
    reason = None
    with log.open("x") as err, result.open("x") as out:
        child = subprocess.Popen(command, stdout=out, stderr=err,
                                 env={**os.environ, "TMPDIR": str(scratch)},
                                 start_new_session=True)
        try:
            while child.poll() is None:
                try:
                    current_rss = rss(child.pid, observed)
                    current_scratch = temporary(scratch)
                    peak_rss = max(peak_rss, current_rss)
                    peak_scratch = max(peak_scratch, current_scratch)
                except ProcessLookupError:
                    continue
                elapsed = time.monotonic() - started
                if cancellation is None:
                    if elapsed > 900:
                        reason = "timeout"
                    elif peak_rss > memory_bytes:
                        reason = "process-tree RSS"
                    elif peak_scratch > disk_bytes:
                        reason = "temporary disk"
                    elif stop_after is not None and elapsed > stop_after:
                        reason = "requested"
                    if reason:
                        cancellation = time.monotonic()
                        child.send_signal(signal.SIGINT)
                elif time.monotonic() - cancellation > 10:
                    os.killpg(child.pid, signal.SIGKILL)
                    break
                time.sleep(0.1)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    elapsed = time.monotonic() - started
    data = {
        "case": name,
        "exitCode": child.returncode,
        "elapsedSeconds": elapsed,
        "treePeakRssBytes": peak_rss,
        "peakScratchBytes": peak_scratch,
        "ownedRssAfterExit": rss(child.pid, observed),
        "cancelReason": reason,
        "cancelToExitSeconds": None if cancellation is None else time.monotonic() - cancellation,
    }
    if child.returncode == 0:
        output = json.loads(result.read_text())
        if "frameCount" in output and name.endswith(("-render", "-range")):
            data["frames"] = output["frameCount"]
            data["framesPerSecondIncludingStartup"] = output["frameCount"] / elapsed
        if "pictureRanges" in output:
            data["reusedRanges"] = sum(item["status"] == "reused" for item in output["pictureRanges"])
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cli", type=Path)
    parser.add_argument("label")
    parser.add_argument("scenes", nargs="+")
    parser.add_argument("--warm", action="store_true")
    parser.add_argument("--picture-cache", action="store_true")
    parser.add_argument("--cancellation", action="store_true")
    parser.add_argument("--rss-gib", type=int, default=8)
    args = parser.parse_args()
    if not args.label.replace("-", "").isalnum():
        raise SystemExit("Use an alphanumeric label with optional hyphens.")
    output = ROOT / "measurements" / args.label
    output.mkdir(parents=True)
    scratch = output / "scratch"
    scratch.mkdir()
    cases = []
    gib = 1024 ** 3
    for scene in args.scenes:
        clip_path = ROOT / "workloads" / f"{scene}.video.json"
        if scene == "ordinary":
            clip_path = clip_path.with_suffix(".ts")
        for phase in ("cold", "warm") if args.warm else ("cold",):
            prefix = scene + "-" + phase
            commands = [
                ("compile", ["validate", str(clip_path)]),
                ("frame", ["preview", "frame", str(clip_path), "--frame", "10", "--quality", "quality",
                           "-o", str(output / (prefix + "-frame.png"))]),
                ("range", ["preview", "clip", str(clip_path), "--from", "30", "--to", "90",
                           "--quality", "quality", "-o", str(output / (prefix + "-range.mp4"))]),
                ("render", ["render", str(clip_path), "-o", str(output / (prefix + ".mp4")),
                            "--quality", "quality"]),
            ]
            for suffix, command in commands:
                command.extend(["--recipe-cache", str(scratch / (scene + "-recipes"))])
            if args.picture_cache:
                commands[-1][1].extend(["--picture-cache", str(output / (scene + "-picture"))])
            for suffix, command in commands:
                result = run([str(args.cli), *command, "--json"], output, scratch,
                             prefix + "-" + suffix, args.rss_gib * gib, 8 * gib)
                cases.append(result)
                print(json.dumps(result), flush=True)
    if args.cancellation:
        scene = args.scenes[0]
        clip_path = ROOT / "workloads" / f"{scene}.video.json"
        for index in range(3):
            result = run([str(args.cli), "render", str(clip_path), "-o", str(output / f"cancel-{index}.mp4"), "--json"],
                         output, scratch, f"cancel-{index}", args.rss_gib * gib, 8 * gib, 2)
            cases.append(result)
            print(json.dumps(result), flush=True)
    failed = [item for item in cases if item["exitCode"] and item["cancelReason"] != "requested"]
    failed.extend(item for item in cases if item["ownedRssAfterExit"])
    raise SystemExit(bool(failed))


if __name__ == "__main__":
    main()
