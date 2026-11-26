"""OpenCut's headless CPU beauty worker. This process never fetches models or media."""

from collections import deque
from fractions import Fraction
import json
from pathlib import Path
from itertools import islice, zip_longest
import resource
import sqlite3
import sys
import time

import av
import cv2
import numpy as np

from response import VisibleResult
from controls import FACE_OVAL, GEOMETRY, GEOMETRY_SET, polygon, protection, sample_parameters, skin_edit
from deformation import ground_anchor, pose_head_contour
from effects import geometry_edit

cv2.setNumThreads(1)
cv2.ocl.setUseOpenCL(False)
MAX_SECONDS = 86_400
SHAPE_STRENGTH_CONTROLS = {"headReduce", "armLength", "legLength"}
LEG_CHAINS = np.array([[25, 27, 29, 31], [26, 28, 30, 32]])


def dumps(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def emit(value):
    print(dumps(value), flush=True)


def stream_for(container, index):
    stream = container.streams[index]
    if stream.type != "video" or stream.time_base is None or stream.average_rate is None:
        raise ValueError("Timed video with a presentation clock is required.")
    stream.thread_type = "NONE"
    stream.codec_context.thread_count = 1
    return stream


def decode_picture(frame, request):
    rgb = frame.reformat(format="rgb24", src_colorspace=request["matrix"],
                         src_color_range=request["range"], dst_color_range="JPEG").to_ndarray()
    orientation = round(request["rotation"] / 90) % 4
    if orientation:
        rgb = np.ascontiguousarray(np.rot90(rgb, orientation))
    if rgb.shape[:2] != (request["height"], request["width"]):
        raise ValueError("Decoded video dimensions changed within the source.")
    return rgb


def frames(container, stream, request):
    first = None
    pending = None
    clock = stream.time_base
    for frame in container.decode(stream):
        if frame.pts is None or frame.time_base != clock or (pending is not None and frame.pts <= pending[0]):
            raise ValueError("Video presentation timestamps must be available and strictly increasing.")
        if first is None:
            first = frame.pts
        elapsed = float((frame.pts - first) * clock)
        if elapsed > MAX_SECONDS:
            raise ValueError("Beauty supports at most 24 hours of source video.")
        if pending is not None:
            pts, seconds, _, rgb = pending
            # Presentation intervals come from consecutive PTS. With B-frames,
            # the packet duration can refer to a different decode-order slot.
            yield pts, seconds, frame.pts - pts, rgb
        pending = frame.pts, elapsed, frame.duration, decode_picture(frame, request)
    if pending is not None:
        pts, seconds, ticks, rgb = pending
        if stream.start_time is not None and stream.duration is not None:
            end = stream.start_time + stream.duration
            if end > pts:
                ticks = end - pts
        yield pts, seconds, ticks or max(1, round(1 / (clock * stream.average_rate))), rgb


class Budget:
    def __init__(self, request, file):
        self.request = request
        self.file = file
        self.last = 0
        self.started = time.perf_counter()

    def check(self, seconds):
        now = time.perf_counter()
        if now - self.last < 1:
            return
        self.last = now
        if self.file.exists() and self.file.stat().st_size > self.request["maxBytes"]:
            raise ValueError("Beauty exceeded its temporary disk budget.")
        if self.peak > self.request["maxMemory"]:
            raise ValueError("Beauty exceeded its worker memory budget.")
        emit({"event": "progress", "seconds": seconds})

    @property
    def peak(self):
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)

    def finish(self):
        return {"seconds": time.perf_counter() - self.started,
                "peakWorkerBytes": self.peak, "bytes": self.file.stat().st_size}


def add_interval(intervals, frame, seconds, end):
    if intervals and intervals[-1]["endFrame"] == frame:
        intervals[-1]["endFrame"] = frame + 1
        intervals[-1]["endSeconds"] = end
    else:
        intervals.append({"startFrame": frame, "endFrame": frame + 1,
                          "startSeconds": seconds, "endSeconds": end})


def analyze(request):
    from contextlib import ExitStack
    from analysis import (Detector, Tracker, active_picture, analysis_size, detect_active_picture,
                          initialized_db, is_cut, jpeg, pack, region_observations, shot_signature,
                          supplement_wide_people)

    output = Path(request["output"])
    budget = Budget(request, output)
    width, height = analysis_size(request["width"], request["height"])
    high_resolution = request["width"] * request["height"] >= 4_000_000
    wide_picture = high_resolution and width >= 1.3 * height
    shots = []
    tracks = {}
    corrections = {}
    applied_corrections = []
    for correction in request["corrections"]:
        corrections.setdefault(correction["frame"], []).append(correction)
    with ExitStack() as stack:
        db = stack.enter_context(sqlite3.connect(output))
        source = stack.enter_context(av.open(request["source"]))
        stream = stream_for(source, request["stream"])
        time_base = stream.time_base
        detector = Detector(request["models"], stack)
        initialized_db(db)
        previous = None
        for index, (pts, seconds, ticks, full) in enumerate(frames(source, stream, request)):
            rgb = cv2.resize(full, (width, height), interpolation=cv2.INTER_AREA)
            signature = shot_signature(rgb)
            if previous is None or is_cut(previous, signature):
                shot_id = "shot-" + str(len(shots) + 1)
                shot = {"id": shot_id, "startSeconds": seconds, "startFrame": index, "ambiguousIntervals": []}
                shots.append(shot)
                tracker = Tracker(width, height)
                picture_bounds = active_picture(rgb) if high_resolution else None
            previous = signature
            duration = float(ticks * stream.time_base)
            end = seconds + duration
            shot["endSeconds"], shot["endFrame"] = end, index + 1
            people, unresolved = detector.detect(rgb)
            if not people and picture_bounds is not None:
                recovered = detect_active_picture(detector, full, rgb, picture_bounds)
                if recovered is not None and recovered[0]:
                    people, unresolved = recovered
            if wide_picture and len(people) == 1:
                supplement_wide_people(detector, full, rgb.shape[:2], people)
            overrides = corrections.pop(index, [])
            if any(item["shotId"] != shot_id for item in overrides):
                raise ValueError("A correction refers to a different shot at its source frame.")
            ambiguous = tracker.assign(people, seconds, overrides, unresolved=bool(np.any(unresolved)))
            for correction in overrides:
                applied_corrections.append({
                    **correction, "reassociated": correction["trackId"] in tracker.reassociated,
                })
            if ambiguous:
                add_interval(shot["ambiguousIntervals"], index, seconds, end)
            occupied = unresolved.copy()
            for person in people:
                occupied = np.maximum(occupied, person["mask"])
                track_id = person["id"]
                if track_id is None:
                    continue
                track_key = (shot_id, track_id)
                if track_key not in tracks:
                    tracks[track_key] = {"shotId": shot_id, "trackId": track_id, "sampleFrame": index,
                                         "sampleSeconds": seconds, "box": np.round(person["box"], 3).tolist(),
                                         "intervals": [], "faceIntervals": [], "poseIntervals": [], "skinIntervals": [],
                                         "regions": {}}
                    db.execute("INSERT INTO samples VALUES (?, ?, ?, ?)", (shot_id, track_id, index, jpeg(rgb)))
                summary = tracks[track_key]
                if not ambiguous:
                    add_interval(summary["intervals"], index, seconds, end)
                face, pose = person["face"], person["body"]
                if face is not None and not ambiguous:
                    add_interval(summary["faceIntervals"], index, seconds, end)
                if pose is not None and not ambiguous:
                    add_interval(summary["poseIntervals"], index, seconds, end)
                if np.count_nonzero((person["parts"] == 2) | (person["parts"] == 3)) > 20 and not ambiguous:
                    add_interval(summary["skinIntervals"], index, seconds, end)
                regions = region_observations(person)
                for name, (state, confidence) in regions.items():
                    states = summary["regions"].setdefault(name, {})
                    state = "ambiguous-association" if ambiguous else state
                    observed = states.setdefault(state, {"frames": 0, "confidence": None, "intervals": []})
                    observed["frames"] += 1
                    add_interval(observed["intervals"], index, seconds, end)
                    if confidence is not None:
                        bounds = observed["confidence"] or [confidence, confidence]
                        observed["confidence"] = [min(bounds[0], confidence), max(bounds[1], confidence)]
                db.execute("INSERT INTO people VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (
                    index, track_id, dumps(person["box"].tolist()),
                    None if face is None else dumps(np.round(face, 3).tolist()),
                    None if pose is None else dumps(np.round(pose, 3).tolist()),
                    pack(person["mask"]), pack(person["parts"]), dumps(regions),
                ))
            db.execute("INSERT INTO frames VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (index, pts, seconds, duration, shot_id, ambiguous, pack(occupied)))
            if index % 12 == 0:
                db.commit()
            budget.check(seconds)
        if not shots:
            raise ValueError("The source contained no decoded video frames.")
        if corrections:
            raise ValueError("A track correction refers to a source frame past the end.")
        if "context" in request:
            if len(shots) != 1:
                raise ValueError("Beauty context requires a single-shot excerpt.")
            save_background_context(db, request, detector, (width, height), budget, shots[0])
        db.commit()
    result = {"analysisSize": [width, height], "timeBase": f"{time_base.numerator}/{time_base.denominator}",
              "frames": shots[-1]["endFrame"], "durationSeconds": shots[-1]["endSeconds"],
              "shots": shots, "tracks": list(tracks.values()), "resources": budget.finish()}
    if applied_corrections:
        result["correctionsApplied"] = applied_corrections
    emit({"event": "result", "result": result})


def open_read_only(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro&immutable=1", uri=True)


def read_occupancy(db, index, output_size):
    from analysis import unpack

    row = db.execute("SELECT shot, seconds, occupied FROM frames WHERE frame = ?", (index,)).fetchone()
    if row is None:
        return None
    shot, seconds, raw = row
    return shot, seconds, cv2.resize(unpack(raw), output_size, interpolation=cv2.INTER_LINEAR) > 26


def context_anchors(db, request, count):
    from analysis import unpack

    if count < 3:
        raise ValueError("Beauty context requires at least three decoded frames.")
    anchors = []
    indices = set(np.linspace(0, count - 1, min(5, count), dtype=int))
    with av.open(request["source"]) as source:
        stream = stream_for(source, request["stream"])
        for frame, (_, seconds, _, image) in enumerate(frames(source, stream, request)):
            if frame not in indices:
                continue
            mask, ambiguous = db.execute(
                "SELECT occupied, ambiguous FROM frames WHERE frame = ?", (frame,),
            ).fetchone()
            visible = cv2.resize(unpack(mask), (request["width"], request["height"])) >= 128
            if ambiguous or min(np.count_nonzero(visible), np.count_nonzero(~visible)) < 50:
                raise ValueError("The excerpt needs identifiable foreground across the context match.")
            anchors.append((seconds, image.astype(np.int16), visible))
    return anchors


def save_background_context(db, request, detector, analysis_size, budget, shot):
    from analysis import is_cut, pack, shot_signature, unpack

    context = request["context"]
    prefix = context["start"]
    anchors = context_anchors(db, request, shot["endFrame"])
    if prefix + anchors[-1][0] > 180:
        raise ValueError("Beauty context matching is limited to the first 180 seconds of the original recording.")
    matches = [None] * len(anchors)
    observed = []
    shot_id = 0
    previous = None
    next_sample = 0.
    scan_end = min(180., max(60., prefix + anchors[-1][0] + 18.5))
    with av.open(context["source"]) as source:
        stream = stream_for(source, context["stream"])
        duration = float(source.duration / av.time_base) if source.duration else scan_end
        interval = max(.13, min(duration, scan_end) / 252)
        for frame, (_, seconds, _, image) in enumerate(frames(source, stream, context)):
            if seconds > scan_end:
                break
            small = cv2.resize(image, analysis_size, interpolation=cv2.INTER_AREA)
            signature = shot_signature(small)
            if previous is not None and is_cut(previous, signature):
                shot_id += 1
            previous = signature
            for index, (anchor_time, anchor, foreground) in enumerate(anchors):
                if abs(seconds - prefix - anchor_time) > .075:
                    continue
                error = np.abs(anchor - image).mean(axis=2)
                moving_error = error[foreground]
                score = float(moving_error.mean())
                if score > 8 or np.percentile(moving_error, 90) > 16 or np.percentile(error[~foreground], 90) > 7:
                    continue
                if matches[index] is None or score < matches[index][0]:
                    matches[index] = (score, shot_id, seconds)
            if seconds + .001 >= next_sample:
                next_sample = max(next_sample + interval, seconds)
                people, unsafe = detector.detect(small)
                if people:
                    occupied = unsafe.copy()
                    for person in people:
                        occupied = np.maximum(occupied, person["mask"])
                    observed.append((shot_id, seconds, pack(image), pack(occupied)))
            budget.check(seconds)
    if (any(match is None for match in matches) or len({match[1] for match in matches}) != 1
            or any(a[2] >= b[2] for a, b in zip(matches, matches[1:]))):
        raise ValueError("The original context did not match the excerpt at the supplied offset within one shot.")
    references = [entry[1:] for entry in observed if entry[0] == matches[0][1]]
    if len(references) < 3:
        raise ValueError("Too few background observations were recovered from the matched context shot.")
    if len(references) > 80:
        # Keep time-distributed observations and prioritize ones that expose
        # parts of the wall or floor covered throughout the excerpt.
        target = np.zeros(analysis_size[::-1], np.float32)
        for (occupied,) in db.execute("SELECT occupied FROM frames ORDER BY frame"):
            target += (unpack(occupied) > 26)
        target *= 1. / shot["endFrame"]
        target = cv2.dilate(target, np.ones((7, 7), np.uint8))
        xx, yy, width, height = cv2.boundingRect((target > 0).astype(np.uint8))
        region = np.s_[yy:yy + height, xx:xx + width]
        available = np.array([
            (cv2.dilate((unpack(data) > 26).astype(np.uint8), np.ones((5, 5), np.uint8))[region] == 0)
            for _, _, data in references
        ])
        selected = list(np.linspace(0, len(references) - 1, 24, dtype=int))
        evidence = available[selected].sum(axis=0)
        for _ in range(80 - len(selected)):
            importance = target[region] / (1 + evidence) ** 2
            gains = np.sum(available * importance, axis=(1, 2))
            gains[selected] = -1
            best = int(np.argmax(gains))
            selected.append(best)
            evidence += available[best]
        references = [references[index] for index in sorted(selected)]
    db.execute("CREATE TABLE background_context (seconds REAL, picture BLOB, occupied BLOB)")
    db.executemany("INSERT INTO background_context VALUES (?, ?, ?)", references)


def read_background_context(db, output_size, budget):
    from analysis import unpack

    if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'background_context'").fetchone() is None:
        return []
    count = db.execute("SELECT COUNT(*) FROM background_context").fetchone()[0]
    limit = min(80, count, budget // (8 * 4 * output_size[0] * output_size[1]))
    if limit < 3:
        return []
    ids = set(np.linspace(1, count, limit, dtype=int))
    references = []
    for index, picture, occupied in db.execute("SELECT rowid, picture, occupied FROM background_context ORDER BY rowid"):
        if index in ids:
            rgb = cv2.imdecode(np.frombuffer(picture, np.uint8), cv2.IMREAD_COLOR)
            if rgb is None or rgb.shape[:2] != output_size[::-1]:
                raise ValueError("Invalid original-context picture in the analysis.")
            mask = cv2.resize(unpack(occupied), output_size, interpolation=cv2.INTER_LINEAR) > 26
            references.append((rgb, mask))
    return references


def read_shot_witnesses(db, request, shot, current_frame, limit):
    """Read a bounded set of actual background observations across one shot."""
    from analysis import unpack

    low = db.execute(
        "SELECT frame FROM frames WHERE frame < ? AND shot != ? ORDER BY frame DESC LIMIT 1",
        (current_frame, shot),
    ).fetchone()
    high = db.execute(
        "SELECT frame FROM frames WHERE frame > ? AND shot != ? ORDER BY frame LIMIT 1",
        (current_frame, shot),
    ).fetchone()
    first_id = low[0] + 1 if low else 0
    last_id = high[0] - 1 if high else db.execute("SELECT MAX(frame) FROM frames").fetchone()[0]
    first_time = db.execute("SELECT seconds FROM frames WHERE frame = ?", (first_id,)).fetchone()[0]
    last_time = db.execute("SELECT seconds FROM frames WHERE frame = ?", (last_id,)).fetchone()[0]
    duration = last_time - first_time
    if duration <= 3.3:
        return []
    size = (request["width"], request["height"])
    witnesses = []
    last_time = first_time - 1
    with av.open(request["source"]) as source:
        stream = stream_for(source, request["stream"])
        for index in np.linspace(first_id, last_id, min(limit, int(duration) + 1), dtype=int):
            pts, seconds, ambiguous, mask = db.execute(
                "SELECT pts, seconds, ambiguous, occupied FROM frames WHERE frame = ?", (int(index),),
            ).fetchone()
            if ambiguous or seconds - last_time < .85:
                continue
            last_time = seconds
            try:
                source.seek(pts, stream=stream, backward=True, any_frame=False)
                for ordinal, frame in enumerate(source.decode(stream)):
                    if ordinal >= 240 or frame.pts is None or frame.pts > pts:
                        break
                    if frame.pts == pts and frame.time_base == stream.time_base:
                        image = decode_picture(frame, request)
                        occupied = cv2.resize(unpack(mask), size, interpolation=cv2.INTER_LINEAR) > 26
                        witnesses.append((seconds, image, occupied))
                        break
            except av.FFmpegError:
                # Nonseekable or unusually long GOPs still use local observations.
                continue
    return witnesses



def recover_pose_sample(pose, before, after, fraction, mask):
    """Repair a one-frame landmark dropout only when both sides corroborate it."""
    upper = [11, 12]
    hips = [23, 24]
    torso = upper + hips
    if np.any(before[torso, 2] < .80) or np.any(after[torso, 2] < .80):
        return pose
    spans = [np.linalg.norm(neighbor[11, :2] - neighbor[12, :2])
             for neighbor in (before, after)]
    span = min(spans)
    if span < 10 or max(spans) > span * 1.35:
        return pose
    estimate = before[:, :2] * (1 - fraction) + after[:, :2] * fraction
    agreement = np.linalg.norm(before[:, :2] - after[:, :2], axis=1) <= .70 * span
    reliable = (np.minimum(before[:, 2], after[:, 2]) >= .80) & agreement
    height, width = mask.shape

    def observed(points):
        x, y = np.rint(points).astype(int).T
        inside = (x > 1) & (x < width - 2) & (y > 1) & (y < height - 2)
        support = np.zeros(len(points), bool)
        support[inside] = mask[y[inside], x[inside]] >= 150
        return support

    # When the detector's weak current sample is close to the interpolated
    # motion and falls on observed foreground, keep its actual position.
    current = pose[:, :2]
    weak = pose[:, 2] < .55
    current_agrees = np.linalg.norm(current - estimate, axis=1) <= .25 * span
    corroborated = weak & reliable & current_agrees & observed(current)
    estimate[corroborated] = current[corroborated]
    supported = observed(estimate)

    # A real side-on pose must remain side-on in the result. Repair a collapse
    # only when the surrounding shoulder axes agree and the original image
    # mask independently supports both predicted joints.
    shoulder_axis = before[11, :2] - before[12, :2]
    other_axis = after[11, :2] - after[12, :2]
    aligned = np.dot(shoulder_axis, other_axis) > .85 * spans[0] * spans[1]
    collapsed = np.linalg.norm(pose[11, :2] - pose[12, :2]) < .50 * span
    repair = weak & reliable & supported
    if aligned and collapsed and (reliable & supported)[torso].all():
        repair[torso] = True
        radius = max(1, round(span * .13))
        for chain in ([11, 13, 15], [12, 14, 16]):
            if not reliable[chain].all():
                continue
            for joint in chain[1:]:
                if supported[joint]:
                    continue
                col, row = np.rint(estimate[joint]).astype(int)
                left, top = max(1, col-radius), max(1, row-radius)
                right, bottom = min(width-1, col+radius+1), min(height-1, row+radius+1)
                yy, xx = np.nonzero(mask[top:bottom, left:right] >= 150)
                if len(xx):
                    points = np.column_stack((xx + left, yy + top))
                    distance = np.linalg.norm(points - estimate[joint], axis=1)
                    closest = int(np.argmin(distance))
                    if distance[closest] <= radius:
                        estimate[joint] = points[closest]
                        supported[joint] = True
            if supported[chain].all():
                repair[chain] = True
    if not np.any(repair):
        return pose
    corrected = pose.copy()
    corrected[repair, :2] = estimate[repair]
    corrected[repair, 2] = np.minimum(before[repair, 2], after[repair, 2])
    return corrected


def stabilized_person(db, index, shot, track, seconds, shape, amount):
    from analysis import unpack

    row = db.execute("SELECT box, face, body, mask, parts FROM people WHERE frame = ? AND track = ?", (index, track)).fetchone()
    if row is None:
        return None
    box, face, pose = (None if item is None else np.asarray(json.loads(item), np.float32) for item in row[:3])
    mask, parts = map(unpack, row[3:])
    if amount > 0:
        y, x = mask.shape
        neighbors = db.execute("""
            SELECT f.seconds, p.box, p.face, p.body, p.mask FROM people p JOIN frames f USING(frame)
            WHERE p.track = ? AND f.shot = ? AND f.ambiguous = 0
            AND f.frame BETWEEN ? AND ? AND f.frame != ?
        """, (track, shot, index - 2, index + 2, index))
        face_delta = np.zeros_like(face) if face is not None else None
        pose_delta = np.zeros_like(pose) if pose is not None else None
        before_pose = after_pose = None
        mask_delta = np.zeros_like(mask, np.float32)
        total = 0
        for other_time, other_box, other_face, other_pose, other_mask in neighbors:
            dt = abs(other_time - seconds)
            if dt > .12:
                continue
            nearby_pose = None if pose is None or other_pose is None else np.asarray(json.loads(other_pose), np.float32)
            if nearby_pose is not None and dt <= .085:
                if other_time < seconds and (before_pose is None or other_time > before_pose[0]):
                    before_pose = other_time, nearby_pose
                if other_time > seconds and (after_pose is None or other_time < after_pose[0]):
                    after_pose = other_time, nearby_pose
            other_center = np.asarray(json.loads(other_box), np.float32).reshape(2, 2).mean(axis=0)
            local_center = box.reshape(2, 2).mean(axis=0)
            shift = local_center - other_center
            if np.linalg.norm(shift) > max(x, y) * .055:
                continue
            weight = 1 - dt / .12
            total += weight
            matrix = np.float32([[1, 0, shift[0]], [0, 1, shift[1]]])
            aligned = cv2.warpAffine(unpack(other_mask), matrix, (x, y))
            mask_delta += np.clip(aligned.astype(np.float32) - mask, -28, 28) * weight
            if face_delta is not None and other_face is not None:
                nearby_face = np.asarray(json.loads(other_face), np.float32)
                delta = (nearby_face - nearby_face[1]) - (face - face[1])
                face_delta += np.clip(delta, -3, 3) * weight
            if nearby_pose is not None:
                axes = (nearby_pose[[23, 24], :2] - pose[[23, 24], :2]).mean(axis=0)
                delta = nearby_pose[:, :2] - axes - pose[:, :2]
                pose_delta[:, :2] += (np.clip(delta, -4, 4) * (nearby_pose[:, 2, None] >= .55)) * weight
        weight = amount / max(1, total)
        mask = np.rint(np.clip(mask + mask_delta * weight * ((mask > 38) & (mask < 225)), 0, 255)).astype(np.uint8)
        if face_delta is not None:
            # Keep eye landmarks at the observed frame so blinks are never averaged open.
            for end in (33, 133, 362, 263):
                distance = np.linalg.norm(face - face[end], axis=1)
                face_delta[distance < np.linalg.norm(face[234] - face[454]) * .18] = 0
            face += face_delta * weight
        if pose_delta is not None:
            pose += pose_delta * weight
            if before_pose is not None and after_pose is not None:
                first, before = before_pose
                last, after = after_pose
                pose = recover_pose_sample(pose, before, after, (seconds - first) / (last - first), mask)
    scale = np.array([shape[0] / mask.shape[1], shape[1] / mask.shape[0]], np.float32)
    if face is not None:
        face *= scale
    if pose is not None:
        pose[:, :2] *= scale
    return (cv2.resize(mask, shape, interpolation=cv2.INTER_LINEAR),
            cv2.resize(parts, shape, interpolation=cv2.INTER_NEAREST), face, pose)


def recover_leg_sample(pose, mask, missing, before, after, fraction):
    """Repair one ankle chain only when the same visible shoe supports the estimate."""
    chain = LEG_CHAINS[missing]
    shin = np.linalg.norm(pose[chain[0], :2] - pose[chain[1], :2])
    if shin < 12:
        return pose

    matched = []
    for observed, foreground in (before, after):
        positions = observed[LEG_CHAINS][..., :2]
        reference = pose[LEG_CHAINS][..., :2]
        direct = np.linalg.norm(positions - reference, axis=2).mean()
        flipped = np.linalg.norm(positions[::-1] - reference, axis=2).mean()
        if abs(direct - flipped) <= .25 * shin:
            return pose
        ids = LEG_CHAINS[missing if direct < flipped else 1 - missing]
        knee, ankle, *foot = ids
        if ground_anchor(foreground, observed, knee, ankle, foot) is None:
            return pose
        matched.append(observed[ids])

    first, last = matched
    delta = np.linalg.norm(first[:, :2] - last[:, :2], axis=1)
    estimate = first * (1 - fraction) + last * fraction
    if (np.any(delta > .35 * shin)
            or np.any(np.linalg.norm(estimate[:, :2] - pose[chain, :2], axis=1) > .22 * shin)):
        return pose
    x, y = np.rint(estimate[:, :2]).astype(int).T
    height, width = mask.shape
    if not np.all((x >= 0) & (x < width) & (y >= 0) & (y < height)):
        return pose
    if mask[y[0], x[0]] < 150 or np.max(mask[y[2:], x[2:]]) < 150:
        return pose
    corrected = pose.copy()
    corrected[chain] = estimate
    corrected[chain, 2] = np.minimum(first[:, 2], last[:, 2])
    knee, ankle, *foot = chain
    return corrected if ground_anchor(mask, corrected, knee, ankle, foot) is not None else pose


def corroborate_leg_pose(db, index, shot, track, seconds, size, amount, mask, pose):
    if pose is None or amount <= 0:
        return pose
    width, height = size
    points = pose[LEG_CHAINS]
    if (np.any(points[..., 2] < .80)
            or not np.all((points[..., 0] > 1) & (points[..., 0] < width - 2)
                          & (points[..., 1] > 1) & (points[..., 1] < height - 2))):
        return pose
    missing = [side for side, (knee, ankle, *foot) in enumerate(LEG_CHAINS)
               if ground_anchor(mask, pose, knee, ankle, foot) is None]
    if len(missing) != 1:
        return pose

    observations = []
    for frame in (index - 1, index + 1):
        row = db.execute("SELECT seconds, shot, ambiguous FROM frames WHERE frame = ?", (frame,)).fetchone()
        if row is None:
            return pose
        time, observed_shot, ambiguous = row
        if observed_shot != shot or ambiguous or abs(time - seconds) > .085:
            return pose
        state = stabilized_person(db, frame, shot, track, time, size, amount)
        if state is None:
            return pose
        foreground, _, _, observed = state
        if observed is None or np.any(observed[LEG_CHAINS, 2] < .80):
            return pose
        x, y = observed[LEG_CHAINS, :2].transpose(2, 0, 1)
        if not np.all((x > 1) & (x < width - 2) & (y > 1) & (y < height - 2)):
            return pose
        observations.append((time, (observed, foreground)))
    (first, before), (last, after) = observations
    return recover_leg_sample(pose, mask, missing[0], before, after, (seconds - first) / (last - first))


def arm_observations(db, shot, track, seconds, size, amount, neighbors):
    observations = []
    for frame, time, image in neighbors:
        if not 0 < abs(time - seconds) <= .105:
            continue
        observed = db.execute("SELECT shot, ambiguous FROM frames WHERE frame = ?", (frame,)).fetchone()
        if observed != (shot, 0):
            continue
        state = stabilized_person(db, frame, shot, track, time, size, amount)
        if state is not None:
            foreground, parts, _, pose = state
            observations.append((time < seconds, image, foreground, parts, pose))
    return observations


def head_observations(db, index, shot, track, seconds, size, amount):
    """Collect bounded, same-track silhouettes for a missed head observation."""
    width, height = size
    scale = min(1.0, 960 / max(width, height))
    dims = (round(width * scale), round(height * scale))
    rows = db.execute("""
        SELECT frame, seconds FROM frames WHERE shot = ? AND ambiguous = 0
        AND frame BETWEEN ? AND ? AND frame != ? AND seconds BETWEEN ? AND ?
        ORDER BY abs(seconds - ?), frame
    """, (shot, index - 12, index + 12, index, seconds - .25, seconds + .25, seconds))
    observations = []
    for frame, when in rows:
        person = stabilized_person(db, frame, shot, track, when, dims, amount)
        if person is None:
            continue
        mask, _, _, pose = person
        head = pose_head_contour(mask, pose)
        if head is None:
            continue
        region, component = head[-2:]
        offset = np.array([region[1].start, region[0].start], np.float32)
        span = np.linalg.norm(pose[11, :2] - pose[12, :2])
        to_source = max(width / dims[0], height / dims[1])
        observations.append((component.astype(np.uint8), offset, pose[0, :2], span, to_source))
        if len(observations) == 3:
            break
    return observations


class Report:
    def __init__(self, response=None):
        self.stats = {}
        self.response = response
        self.reconstruction = {}
        self.metrics = {"temporalPixels": 0, "spatialPixels": 0, "changedPixels": 0, "changedFrames": 0}
        self.limited = False
        self.valid_geometry = False

    def add(self, effect, name, requested, outcome, index, start, end, measurement=None):
        effective, reason = outcome
        status = "bypassed" if not effective else "attenuated" if reason or abs(effective - requested) > 1e-5 else "applied"
        if status != "applied":
            self.limited = True
        if self.response is not None:
            self.response.observe(effect, name, requested, effective, status, index, start, end, measurement)
        if effective and name in GEOMETRY:
            self.valid_geometry = True
        key = (effect["id"], name, status, reason)
        if key not in self.stats:
            self.stats[key] = {"effectId": effect["id"], "target": effect["target"], "parameter": name,
                               "status": status, "reason": reason, "requested": [requested, requested],
                               "effective": [effective, effective], "frames": 0, "intervals": []}
        report = self.stats[key]
        for field, value in (("requested", requested), ("effective", effective)):
            report[field][0] = min(report[field][0], value)
            report[field][1] = max(report[field][1], value)
        report["frames"] += 1
        if effective and measurement is not None:
            metric, measured = measurement[:2]
            observation = report.setdefault("measurement", {
                "metric": metric, "min": measured, "max": measured, "samples": 0,
            })
            observation["min"] = min(observation["min"], measured)
            observation["max"] = max(observation["max"], measured)
            observation["samples"] += 1
        add_interval(report["intervals"], index, start, end)


    def record_reconstruction(self, effect, frame, seconds, end, box, temporal, spatial):
        effect_id = effect["id"]
        record = self.reconstruction.setdefault(effect_id, {
            "effectId": effect_id, "target": effect["target"], "intervals": [],
            "temporalPixels": 0, "spatialPixels": 0, "sample": None,
        })
        add_interval(record["intervals"], frame, seconds, end)
        record["temporalPixels"] += temporal
        record["spatialPixels"] += spatial
        best = record["sample"]
        if best is None or temporal + spatial > best["temporalPixels"] + best["spatialPixels"]:
            record["sample"] = {"frame": frame, "seconds": seconds, "box": box,
                                "temporalPixels": temporal, "spatialPixels": spatial}


    def record_empty_intervals(self, effects):
        recorded = {(effect, name) for effect, name, _, _ in self.stats}
        for effect in effects:
            keyframes = effect.get("keyframes") or {}
            for name in sorted(effect["parameters"].keys() | keyframes.keys()):
                authored = ([point["value"] for point in keyframes[name]]
                            if name in keyframes else [effect["parameters"][name]])
                if not any(authored) or (effect["id"], name) in recorded:
                    continue
                self.limited = True
                reason = "no-source-sample-in-active-interval"
                self.stats[(effect["id"], name, "bypassed", reason)] = {
                    "effectId": effect["id"], "target": effect["target"], "parameter": name,
                    "status": "bypassed", "reason": reason, "requested": [min(authored), max(authored)],
                    "effective": [0, 0], "frames": 0, "intervals": [],
                    "activeRange": effect["timeRange"],
                }


def render(request):
    from analysis import unpack

    out = Path(request["output"])
    budget = Budget(request, out)
    step = request["step"]
    effects = [effect for effect in step["effects"] if effect["enabled"]]
    size = (request["width"], request["height"])
    visible_result = VisibleResult(size[0]) if step["acceptance"] == "visible-result" else None
    report = Report(visible_result)
    with av.open(request["source"]) as source, av.open(
        out, "w", format="mov", options={"video_track_timescale": str(request["timeScale"]),
                                        "movie_timescale": str(request["timeScale"]),
                                        "avoid_negative_ts": "disabled", "movflags": "+write_colr"},
    ) as output, open_read_only(request["analysis"]) as db:
        stream = stream_for(source, request["stream"])
        picture = output.add_stream("png", rate=stream.average_rate)
        picture.width, picture.height = size
        picture.pix_fmt = "rgb24"
        picture.time_base = stream.time_base
        codec = picture.codec_context
        codec.time_base = stream.time_base
        codec.thread_count = 1
        codec.color_range = 2
        codec.colorspace = 0
        codec.color_primaries = stream.codec_context.color_primaries
        codec.color_trc = stream.codec_context.color_trc
        it = iter(frames(source, stream, request))
        current = next(it, None)
        future = deque()
        # Stay within a small fraction of the declared memory budget. Large
        # rasters retain the existing adjacent-frame fallback.
        pixels = size[0] * size[1]
        memory_share = request["maxMemory"] // 20
        reserve = min(16 * 1024 * 1024, memory_share)
        primary_lookahead = max(1, min(16, reserve // (pixels * 3)))
        shape_shots = {
            effect["target"]["shotId"] for effect in effects
            if SHAPE_STRENGTH_CONTROLS <= effect["parameters"].keys() | (effect.get("keyframes") or {}).keys()
            and effect["failurePolicy"]["unreliableReconstruction"] == "attenuate"
            and effect["failurePolicy"]["invalidGeometry"] == "attenuate"
        } if pixels <= 1_000_000 else set()
        wider_context = bool(shape_shots)
        background_context = read_background_context(db, size, request["maxMemory"]) if pixels <= 1_000_000 else []
        witness_limit = min(24, min(32 * 1024 * 1024, memory_share) // (pixels * 4)) if wider_context else 0
        # High-resolution leg edits can use observations elsewhere in the
        # same shot without retaining another window of consecutive frames.
        high_res_leg_shots = {
            effect["target"]["shotId"] for effect in effects
            if GEOMETRY_SET.intersection(effect["parameters"].keys() | (effect.get("keyframes") or {}).keys()) == {"legLength"}
            and effect["failurePolicy"]["invalidGeometry"] == effect["failurePolicy"]["unreliableReconstruction"] == "attenuate"
        } if pixels >= 3_000_000 else set()
        high_res_witness_limit = min(7, request["maxMemory"] // (12 * pixels * 4))
        witness_shot = None
        shot_witnesses = []
        history_samples, history_seconds = (2 if pixels >= 4_000_000 else 3), .75
        lookahead = primary_lookahead
        if wider_context:
            # Include older same-shot observations without changing the
            # short-window observations used for contour or motion tracking.
            slots = min(40 * 1024 * 1024, memory_share) // (pixels * 4)
            extra = max(0, slots - primary_lookahead - history_samples)
            history_samples += min(5, extra // 3)
            history_seconds = 1.65 if history_samples > 3 else .75
            lookahead += min(36 - primary_lookahead, extra - (history_samples - 3))
        exhausted = False
        previous = None
        history = []
        arm_history = deque(maxlen=2)
        count = 0
        for row in db.execute("SELECT frame, pts, seconds, duration, shot, ambiguous, occupied FROM frames ORDER BY frame"):
            index, analysis_pts, analysis_time, duration, shot, ambiguous, raw = row
            while not exhausted and len(future) < lookahead:
                neighbor = next(it, None)
                if neighbor is None:
                    exhausted = True
                else:
                    future.append(neighbor)
            if current is None or current[0] != analysis_pts or abs(current[1] - analysis_time) > 1e-8:
                raise ValueError("Analysis timestamps do not match the source presentation clock.")
            pts, seconds, ticks, original = current
            rgba = original
            active = [(effect, sample_parameters(effect, seconds)) for effect in effects
                      if effect["target"]["shotId"] == shot and effect["timeRange"]["start"] <= seconds < effect["timeRange"]["end"]]
            if active:
                if shot != witness_shot:
                    limit = (high_res_witness_limit if shot in high_res_leg_shots
                             else witness_limit if shot in shape_shots else 0)
                    shot_witnesses = read_shot_witnesses(db, request, shot, index, limit) if limit >= 2 else []
                    witness_shot = shot
                witness_age = .75 if shot in high_res_leg_shots else 1.65
                shot_context = [(rgb, mask) for time, rgb, mask in shot_witnesses if abs(time - seconds) > witness_age]
                context = []
                distant_context = []
                candidates = [] if previous is None or seconds - previous[1] > .12 else [(index - 1, previous)]
                last_time = seconds - .11
                last_distant = seconds
                for offset, neighbor in enumerate(future, start=1):
                    age = neighbor[1] - seconds
                    if offset <= primary_lookahead and age <= .75:
                        if neighbor[1] - last_time >= .11:
                            last_time = neighbor[1]
                            candidates.append((index + offset, neighbor))
                    elif not wider_context or age > 1.65:
                        break
                    elif neighbor[1] - last_distant >= .16:
                        last_distant = neighbor[1]
                        observation = read_occupancy(db, index + offset, size)
                        if observation and observation[0] == shot:
                            distant_context.append((neighbor[3], observation[2]))
                for frame_id, neighbor in candidates:
                    observation = read_occupancy(db, frame_id, size)
                    if observation and observation[0] == shot:
                        context.append((neighbor[3], observation[2]))
                for rank, (before_time, before_shot, before_image, before_mask) in enumerate(reversed(history)):
                    age = seconds - before_time
                    if before_shot != shot or age <= .12:
                        continue
                    if rank < 3 and age <= .75:
                        context.append((before_image, before_mask))
                    elif age <= history_seconds:
                        distant_context.append((before_image, before_mask))
                occupied = unpack(raw)
                changed = np.zeros(original.shape[:2], bool)
                for effect, values in active:
                    if not values:
                        continue
                    target = effect["target"]["trackId"]
                    person = None if ambiguous else stabilized_person(
                        db, index, shot, target, seconds, size, effect["temporal"]["strength"],
                    )
                    policy = effect["failurePolicy"]
                    if person is None:
                        reason = "ambiguous-association" if ambiguous else "track-not-visible"
                        if policy["trackingUncertain"] == "fail":
                            raise ValueError(f'{effect["id"]} {target} at {seconds:.6f}s: {reason}.')
                        for name, value in values.items():
                            report.add(effect, name, value, (0, reason), index, seconds, seconds + duration)
                        continue
                    alpha, parts, face, pose = person
                    if shot in high_res_leg_shots and GEOMETRY_SET.intersection(values) == {"legLength"}:
                        pose = corroborate_leg_pose(
                            db, index, shot, target, seconds, size, effect["temporal"]["strength"], alpha, pose,
                        )
                    other = np.zeros_like(occupied)
                    for (mask,) in db.execute("SELECT mask FROM people WHERE frame = ? AND track != ?", (index, target)):
                        other = np.maximum(other, unpack(mask))
                    other = cv2.resize(other, size, interpolation=cv2.INTER_LINEAR) > 70
                    protect = protection(alpha.shape, effect["protectedRegions"], seconds)
                    # Protect foreground skin or accessories covering the estimated face.
                    if face is not None:
                        oval = polygon(alpha.shape, face[list(FACE_OVAL)]) > 0
                        protect |= oval & np.isin(parts, (2, 4, 5))
                    protect |= cv2.dilate(other.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
                    protect |= changed
                    skin, skin_report = skin_edit(rgba, alpha, parts, face, protect, effect, values)
                    strength = effect["temporal"]["strength"]

                    def neighboring_heads():
                        return head_observations(db, index, shot, target, seconds, size, strength)

                    def neighboring_arms():
                        following = [(index + offset, frame[1], frame[3])
                                     for offset, frame in enumerate(islice(future, 2), start=1)]
                        return arm_observations(db, shot, target, seconds, size, strength, (*arm_history, *following))

                    result, geometry_report, metrics = geometry_edit(
                        skin, original, alpha, parts, face, pose, protect, context, values, policy,
                        neighboring_heads if strength > 0 else None,
                        distant_context=distant_context, shot_context=shot_context,
                        background_context=background_context,
                        arm_neighbors=neighboring_arms if background_context and strength > 0 else None,
                    )
                    if any(outcome[0] for outcome in geometry_report.values()) and np.array_equal(skin, result):
                        geometry_report = {
                            name: (0, "no-measurable-pixel-change") if outcome[0] else outcome
                            for name, outcome in geometry_report.items()
                        }
                    changed |= np.any(rgba != result, axis=2)
                    rgba = result
                    del result, skin
                    measurements = metrics.pop("measurements", {})
                    reconstruction = metrics.pop("reconstructionBox", None)
                    if reconstruction is not None:
                        report.record_reconstruction(effect, index, seconds, seconds + duration, reconstruction,
                                                     metrics["temporalPixels"], metrics["spatialPixels"])
                    outcomes = skin_report | geometry_report
                    for name, value in values.items():
                        report.add(effect, name, value, outcomes[name], index, seconds, seconds + duration,
                                   measurements.get(name) if outcomes[name][0] else None)
                    for name, value in metrics.items():
                        report.metrics[name] += value
                pixels = int(np.count_nonzero(changed))
                report.metrics["changedFrames"] += int(pixels > 0)
                report.metrics["changedPixels"] += pixels
            encoded_frame = av.VideoFrame.from_ndarray(rgba, format="rgb24")
            encoded_frame.pts, encoded_frame.time_base = pts, stream.time_base
            for packet in picture.encode(encoded_frame):
                packet.duration = ticks
                output.mux(packet)
            del encoded_frame, rgba
            if not history or seconds - history[-1][0] >= .22 or history[-1][1] != shot:
                occupied_at = cv2.resize(unpack(raw), size, interpolation=cv2.INTER_LINEAR) > 26
                history = [item for item in history if item[1] == shot
                           and seconds - item[0] < history_seconds][-(history_samples - 1):]
                history.append((seconds, shot, original, occupied_at))
            if background_context:
                arm_history.append((index, seconds, original))
            previous, current = current, future.popleft() if future else None
            count += 1
            budget.check(seconds)
        if current is not None or not count:
            raise ValueError("Analysis and render have different decoded frame counts.")
        for packet in picture.encode(None):
            raise ValueError(f"Beauty encoder returned an unexpected delayed packet at {packet.pts}.")
    report.record_empty_intervals(effects)
    result = {"version": 1, "profile": "cpu-beauty-v1", "analysisRef": step["analysisRef"],
              "status": "completed-with-limitations" if report.limited else "completed",
              "intervals": list(report.stats.values()), "metrics": report.metrics,
              "quality": {"geometryBounds": "passed" if report.valid_geometry else "not-evaluated", "sourceTiming": "not-evaluated",
                          "visualAcceptance": "not-evaluated"},
              "frames": count, "resources": budget.finish()}
    if report.reconstruction:
        result["reconstruction"] = list(report.reconstruction.values())
    if visible_result is not None:
        empty = [(item["effectId"], item["parameter"]) for item in report.stats.values() if not item["frames"]]
        result["visibleResult"] = visible_result.result(empty)
    emit({"event": "result", "result": result})
    if (report.limited and step["acceptance"] == "complete-coverage"
            or visible_result is not None and result["visibleResult"]["status"] == "failed"):
        raise ValueError("Beauty coverage policy failed. Inspect the reported strength and intervals.")


def audio_spans(container, stream, tolerance):
    """Group contiguous decoded samples without relying on packet boundaries."""
    start = None
    count = rate = 0
    end = None
    if stream.start_time is not None and stream.duration is not None:
        end = (stream.start_time + stream.duration) * stream.time_base
    for frame in container.decode(stream):
        if frame.pts is None or frame.time_base is None or frame.sample_rate <= 0:
            raise ValueError("Beauty audio verification found a missing sample timestamp or rate.")
        time = frame.pts * frame.time_base
        if start is not None:
            expected = start + Fraction(count, rate)
            if frame.sample_rate != rate or abs(time - expected) > tolerance:
                yield start, count, rate
                start = None
        if start is None:
            start, count, rate = time, 0, frame.sample_rate
        samples = frame.samples
        if end is not None:
            # Some decoders emit a full final block after the presented
            # samples end. Count only samples inside the stream duration.
            remaining = round((end - start) * rate) - count
            samples = min(samples, remaining)
        if samples <= 0:
            break
        count += samples
    if start is not None and count:
        yield start, count, rate


def verify_audio(source_path, source_index, result_path):
    with av.open(source_path) as original, av.open(result_path) as result:
        source = original.streams[source_index]
        if not result.streams.audio:
            raise ValueError("Beauty recipe dropped the source audio stream.")
        output = result.streams.audio[0]
        tolerance = max(source.time_base, output.time_base)
        checked = 0
        spans = zip_longest(audio_spans(original, source, tolerance), audio_spans(result, output, tolerance))
        for before, after in spans:
            if (before is None or after is None or before[1:] != after[1:]
                    or abs(before[0] - after[0]) > tolerance):
                raise ValueError("Beauty recipe changed the source audio sample timing.")
            checked += before[1]
        if not checked:
            raise ValueError("Beauty recipe could not verify any source audio samples.")



def verify(request):
    count = 0
    with av.open(request["source"]) as original, av.open(request["output"]) as result:
        source = stream_for(original, request["stream"])
        processed = stream_for(result, 0)
        tolerance = max(source.time_base, processed.time_base) / 2
        for first, second in zip_longest(original.decode(source), result.decode(processed)):
            if first is None or second is None or first.pts is None or second.pts is None:
                raise ValueError("Beauty recipe changed the source frame count or produced a missing timestamp.")
            if abs(first.pts * first.time_base - second.pts * second.time_base) > tolerance:
                raise ValueError(f"Beauty recipe changed the source timestamp at frame {count}.")
            count += 1
        if source.duration is not None and processed.duration is not None:
            if abs(source.duration * source.time_base - processed.duration * processed.time_base) > tolerance:
                raise ValueError("Beauty recipe changed the end of the video presentation interval.")
    if count != request["count"]:
        raise ValueError("Beauty recipe frame count differs from its analysis.")
    if request.get("audioStream") is not None:
        verify_audio(request["source"], request["audioStream"], request["output"])
    emit({"event": "result", "result": {"checkedFrames": count}})


def samples(request):
    destination = Path(request["output"])
    paths = []
    with open_read_only(request["analysis"]) as db:
        for shot, track, frame, image in db.execute("SELECT * FROM samples ORDER BY frame, track"):
            filename = destination / f"{shot}-{track}-frame-{frame}.jpg"
            with filename.open("xb") as handle:
                handle.write(image)
            paths.append({"shotId": shot, "trackId": track, "frame": frame, "path": str(filename)})
    emit({"event": "result", "result": paths})


def runtime_versions():
    from importlib.metadata import version
    return {
        "python": ".".join(map(str, sys.version_info[:3])),
        "av": av.__version__, "opencv": cv2.__version__, "numpy": np.__version__,
        "mediapipe": version("mediapipe"),
    }


if __name__ == "__main__":
    command = sys.argv[1]
    try:
        if command == "preflight":
            emit({"event": "result", "result": runtime_versions()})
        else:
            request = json.loads(Path(sys.argv[2]).read_text())
            if command in {"analyze", "render"} and runtime_versions() != request["runtime"]:
                raise ValueError("Beauty runtime differs from the analysis runtime. Restore the recorded Python and package versions or analyze again.")
            {"analyze": analyze, "render": render, "samples": samples, "verify": verify}[command](request)
    except (ImportError, ValueError, OSError, sqlite3.Error) as error:
        print(f"Beauty {command}: {error}", file=sys.stderr)
        sys.exit(1)
