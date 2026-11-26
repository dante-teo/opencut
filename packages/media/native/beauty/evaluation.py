"""Matched working-frame evidence for an already rendered beauty recipe."""

from itertools import islice, zip_longest
import json
from pathlib import Path
import sys

import av
import cv2
import numpy as np

from analysis import unpack
from controls import FACE_OVAL, FEATURES
from quality_motion import MotionResidual, constant_controls, motion_input
from worker import emit, frames, open_read_only, stream_for


PROFILE = json.loads(Path(__file__).with_name("quality-profile.json").read_text())


def save_rgb(path, picture):
    rgb = cv2.cvtColor(picture, cv2.COLOR_RGB2BGR)
    success, data = cv2.imencode(".png", rgb)
    if not success:
        raise ValueError("Could not encode a beauty evidence image.")
    with path.open("xb") as handle:
        handle.write(data.tobytes())


def bounds(points, width, height):
    low = np.min(points, axis=0)
    high = np.max(points, axis=0)
    padding = .17 * (high - low) + 5
    x, y = np.floor(np.maximum(0, low - padding)).astype(int)
    right, bottom = np.ceil(np.minimum((width, height), high + padding)).astype(int)
    if right - x < 8 or bottom - y < 8:
        return None
    return [int(x), int(y), int(right), int(bottom)]


def evidence_regions(db, frame, targets, scale, width, height):
    for track, box, face, body in db.execute("SELECT track, box, face, body FROM people WHERE frame = ?", (frame,)):
        if track not in targets:
            continue
        box = np.asarray(json.loads(box), np.float32).reshape(2, 2) * scale
        yield track, "person", bounds(box, width, height)
        if face:
            points = np.asarray(json.loads(face), np.float32) * scale
            yield track, "face-skin", bounds(points[list(FACE_OVAL)], width, height)
            for index in (0, 1):
                yield track, "eye-" + str(index + 1), bounds(points[list(FEATURES[index])], width, height)
        if body:
            points = np.asarray(json.loads(body), np.float32)
            for label, ids in (("arms", [11, 12, 13, 14, 15, 16]), ("legs", [23, 24, 25, 26, 27, 28, 29, 30, 31, 32])):
                selected = points[ids]
                visible = selected[selected[:, 2] > .55, :2]
                if len(visible):
                    yield track, label, bounds(visible * scale, width, height)


def applied_targets(intervals, start, end):
    """Use each frame's effective controls to identify the people allowed to change."""
    active = [set() for _ in range(end - start)]
    for effect in intervals:
        if effect["status"] not in {"applied", "attenuated"}:
            continue
        target = effect["target"]
        identity = (target["shotId"], target["trackId"])
        for interval in effect["intervals"]:
            for frame in range(max(start, interval["startFrame"]), min(end, interval["endFrame"])):
                active[frame - start].add(identity)
    return active


def protected_people(db, frame, shot, active, size):
    """Return independently observed cores of people without an active edit."""
    for track, packed in db.execute("SELECT track, mask FROM people WHERE frame = ?", (frame,)):
        if (shot, track) in active:
            continue
        core = cv2.resize(unpack(packed), size, interpolation=cv2.INTER_LINEAR) >= 230
        if np.any(core):
            yield track, core


def mux_comparison_packets(target, packets, durations):
    for packet in packets:
        packet.duration = durations.pop(packet.pts * packet.time_base)
        target.mux(packet)


def verify_comparison_timing(comparison, expected):
    with av.open(comparison) as video:
        stream = stream_for(video, 0)
        packets = (packet for packet in video.demux(stream) if packet.size)
        for interval, packet in zip_longest(expected, packets):
            if (interval is None or packet is None or packet.pts is None
                    or interval != (packet.pts * packet.time_base, packet.duration * packet.time_base)):
                raise ValueError("Visual evidence did not preserve the selected source frame intervals.")


def evaluate(request):
    start, end = request["startFrame"], request["endFrame"]
    output = Path(request["destination"])
    comparison = output / "comparison.mp4"
    report = request["report"]
    targets = {(item["target"]["shotId"], item["target"]["trackId"]) for item in report["intervals"]}
    active_targets = applied_targets(report["intervals"], start, end)
    stable_controls = constant_controls(report["intervals"], start, end)
    residual = MotionResidual()
    picks = set(np.linspace(start, end - 1, min(6, end - start), dtype=int).tolist())
    reconstruction = {}
    for observation in report.get("reconstruction", ()):
        frame = observation["sample"]["frame"]
        if start <= frame < end:
            reconstruction.setdefault(frame, []).append(observation)
            picks.add(frame)
    original_peaks, person_peaks = [], []
    artifacts, findings = [], []
    changed = affected_background = clipping = evaluated_background = 0
    changed_other_people = evaluated_other_people = 0
    width, height = request["width"], request["height"]
    preview_width = min(640, width) & ~1
    preview_height = max(2, round(height * preview_width / width) & ~1)
    expected, durations = [], {}
    mux_options = {"video_track_timescale": str(request["timeScale"]),
                   "movie_timescale": str(request["timeScale"])}
    with av.open(request["source"]) as source, av.open(request["processed"]) as result, av.open(
        comparison, "w", options=mux_options,
    ) as target, open_read_only(request["analysis"]) as db:
        stream = stream_for(source, request["stream"])
        processed = stream_for(result, 0)
        codec = target.add_stream("libx264", rate=stream.average_rate, options={"preset": "fast", "crf": "17", "bf": "0"})
        codec.pix_fmt = "yuv420p"
        codec.width, codec.height = preview_width * 2, preview_height
        codec.time_base = stream.time_base
        codec.codec_context.time_base = stream.time_base
        codec.codec_context.thread_count = 1
        first_pts = None
        count = 0
        pair = zip(frames(source, stream, request), result.decode(processed))
        for index, ((pts, seconds, ticks, original), processed_frame) in enumerate(islice(pair, start, end), start):
            if processed_frame.pts is None or processed_frame.pts * processed_frame.time_base != pts * stream.time_base:
                raise ValueError("Visual evidence input timestamps failed to align.")
            edited = processed_frame.to_ndarray(format="rgb24")
            if original.shape != edited.shape:
                raise ValueError("Visual evidence inputs differ in source dimensions.")
            count += 1
            first_pts = pts if first_pts is None else first_pts
            row = db.execute("SELECT shot, occupied FROM frames WHERE frame = ?", (index,)).fetchone()
            shot, packed = row
            occupied_small = unpack(packed)
            scale = np.array([width / occupied_small.shape[1], height / occupied_small.shape[0]], np.float32)
            occupied = cv2.resize(occupied_small, (width, height), interpolation=cv2.INTER_LINEAR) > 12
            buffer = cv2.distanceTransform((~occupied).astype(np.uint8), cv2.DIST_L2, 3) if occupied.any() else np.full(occupied.shape, np.inf)
            outside = buffer > max(PROFILE["outsideInfluence"]["minRadiusPixels"],
                                   np.hypot(width, height) * PROFILE["outsideInfluence"]["sourceDiagonalFraction"])
            difference = np.abs(original.astype(np.int16) - edited)
            change = np.any(difference > 0, axis=2)
            changed += int(np.count_nonzero(change))
            affected = int(np.count_nonzero(outside & change))
            affected_background += affected
            evaluated_background += int(np.count_nonzero(outside))
            for track, core in protected_people(db, index, shot, active_targets[index - start], (width, height)):
                affected_person = int(np.count_nonzero(core & change))
                evaluated_other_people += int(np.count_nonzero(core))
                changed_other_people += affected_person
                if affected_person:
                    person_peaks.append((affected_person, index, seconds, shot, track))
            clipped = np.any(((edited == 0) | (edited == 255)) & ((original > 1) & (original < 254)), axis=2)
            clipping += int(np.count_nonzero(clipped))
            if affected:
                original_peaks.append((affected, index, seconds))
            state = stable_controls[index - start]
            motion = (motion_input(db, index, shot, active_targets[index - start], original, edited, occupied)
                      if state is not None else None)
            residual.observe(index, shot, seconds, state, motion)
            if index in picks:
                prefix = "frame-" + str(index).zfill(6)
                for kind, image in (("original", original), ("processed", edited)):
                    full = output / f"{prefix}-{kind}.png"
                    save_rgb(full, image)
                    artifacts.append({"kind": kind, "frame": index, "seconds": seconds, "path": str(full)})
                for track, kind, region in evidence_regions(db, index, {track for s, track in targets if s == shot}, scale, width, height):
                    if region is None:
                        continue
                    x, y, right, bottom = region
                    crop = output / f"{prefix}-{track}-{kind}.png"
                    save_rgb(crop, np.concatenate([original[y:bottom, x:right], edited[y:bottom, x:right]], axis=1))
                    artifacts.append({"kind": kind, "frame": index, "seconds": seconds, "shotId": shot,
                                      "trackId": track, "box": region, "path": str(crop)})
                for ordinal, item in enumerate(reconstruction.get(index, ())):
                    x, y, size_x, size_y = item["sample"]["box"]
                    region = np.s_[max(0, y - 6):min(height, y + size_y + 6),
                                   max(0, x - 6):min(width, x + size_x + 6)]
                    path = output / f"{prefix}-reconstructed-background-{ordinal + 1}.png"
                    save_rgb(path, np.concatenate([original[region], edited[region]], axis=1))
                    artifacts.append({"kind": "reconstructed-background", "frame": index, "seconds": seconds,
                                      "shotId": shot, "trackId": item["target"]["trackId"], "effectId": item["effectId"],
                                      "box": [x, y, x + size_x, y + size_y], "path": str(path)})
            resized = [cv2.resize(img, (preview_width, preview_height), interpolation=cv2.INTER_AREA) for img in (original, edited)]
            video = av.VideoFrame.from_ndarray(np.concatenate(resized, axis=1), format="rgb24")
            video.pts, video.time_base = pts - first_pts, stream.time_base
            timestamp = video.pts * video.time_base
            expected.append((timestamp, ticks * video.time_base))
            durations[timestamp] = ticks
            mux_comparison_packets(target, codec.encode(video), durations)
        mux_comparison_packets(target, codec.encode(None), durations)
    if count != end - start or durations:
        raise ValueError("Visual evidence did not cover every selected frame.")
    verify_comparison_timing(comparison, expected)
    for affected, index, seconds in sorted(original_peaks, reverse=True)[:20]:
        findings.append({"severity": "error", "check": "outside-influence-unchanged",
                         "frame": index, "seconds": seconds, "changedPixels": affected})
    for affected, index, seconds, shot, track in sorted(person_peaks, reverse=True)[:20]:
        findings.append({"severity": "error", "check": "nonTargetPeopleUnchanged", "frame": index,
                         "seconds": seconds, "shotId": shot, "trackId": track, "changedPixels": affected})
    people = ("failed" if changed_other_people else
              "passed" if evaluated_other_people else "not-evaluated")
    background = ("failed" if affected_background > PROFILE["outsideInfluence"]["maxChangedPixels"]
                  else "passed" if evaluated_background else "not-evaluated")
    checks = {
        "sourceTiming": "passed", "outsideInfluenceUnchanged": background,
        "nonTargetPeopleUnchanged": people,
        "geometryBounds": report["quality"]["geometryBounds"],
        "motionCompensatedStability": "not-evaluated", "targetIdentity": "not-evaluated",
        "geometryDirectionAndResponse": "not-evaluated", "occlusionOrdering": "not-evaluated",
        "skinTexture": "not-evaluated", "colorQuality": "not-evaluated",
        "reconstructionContinuity": "not-evaluated", "visualAcceptance": "not-evaluated",
    }
    return {"ok": "failed" not in (background, people), "profile": PROFILE["version"], "profileSettings": PROFILE,
            "checks": checks, "findings": findings, "startFrame": start, "endFrame": end,
            "metrics": {"changedPixels": changed, "outsideInfluencePixels": evaluated_background,
                        "changedOutsideInfluencePixels": affected_background, "newClippingPixels": clipping,
                        "nonTargetPersonPixels": evaluated_other_people,
                        "changedNonTargetPersonPixels": changed_other_people},
            "motionCompensatedResidual": residual.result(),
            "comparisonVideo": str(comparison), "artifacts": artifacts, "processing": report}


if __name__ == "__main__":
    try:
        emit({"event": "result", "result": evaluate(json.loads(Path(sys.argv[2]).read_text()))})
    except (ImportError, ValueError, OSError) as error:
        print(f"Beauty evaluation: {error}", file=sys.stderr)
        sys.exit(1)
