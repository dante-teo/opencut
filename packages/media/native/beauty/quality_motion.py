"""Source-motion diagnostics for constant, applied beauty controls."""

import cv2
import numpy as np

from analysis import unpack


def constant_controls(intervals, start, end):
    by_frame = [[] for _ in range(end - start)]
    for effect in intervals:
        amount = effect["effective"]
        fixed = (effect["status"] == "applied" and amount[0] == amount[1]
                 and effect["requested"][0] == effect["requested"][1])
        target = effect["target"]
        state = (effect["effectId"], effect["parameter"], target["shotId"], target["trackId"], amount[0])
        for interval in effect["intervals"]:
            for frame in range(max(start, interval["startFrame"]), min(end, interval["endFrame"])):
                by_frame[frame - start].append(state if fixed else None)
    return [tuple(sorted(values)) if values and None not in values else None for values in by_frame]


def motion_input(db, frame, shot, targets, original, edited, occupied):
    """Use a bounded raster to retain point correspondences over long clips."""
    height, width = occupied.shape
    scale = min(1., 384 / max(height, width))
    size = (max(4, round(width * scale)), max(4, round(height * scale)))
    source = cv2.resize(original, size, interpolation=cv2.INTER_AREA)
    output = cv2.resize(edited, size, interpolation=cv2.INTER_AREA)
    core = np.zeros(size[::-1], np.uint8)
    skin = np.zeros_like(core)
    for track, mask, parts in db.execute("SELECT track, mask, parts FROM people WHERE frame = ?", (frame,)):
        if (shot, track) in targets:
            person = cv2.resize(unpack(mask), size, interpolation=cv2.INTER_LINEAR) >= 128
            labels = cv2.resize(unpack(parts), size, interpolation=cv2.INTER_NEAREST)
            core |= person
            skin |= person & ((labels == 2) | (labels == 3))
    kernel = np.ones((5, 5), np.uint8)
    padded = cv2.dilate(core, kernel) != 0
    interior = cv2.erode(core, kernel) != 0
    scene = cv2.resize(occupied.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) == 0
    adjacent = (cv2.dilate(core, np.ones((19, 19), np.uint8)) != 0) & scene
    return (cv2.cvtColor(source, cv2.COLOR_RGB2GRAY), output.astype(np.int16) - source,
            {"skin": skin, "contour": (padded & ~interior).astype(np.uint8),
             "adjacentBackground": adjacent.astype(np.uint8)})


def aligned_residual(previous, current, region):
    prior, before, regions = previous
    source, after, masks = current
    anchors = cv2.goodFeaturesToTrack(prior, 100, .025, 4, mask=regions[region])
    if anchors is None:
        return np.empty(0, dtype=np.int16)
    following, forward, errors = cv2.calcOpticalFlowPyrLK(prior, source, anchors, None)
    if following is None:
        return np.empty(0, dtype=np.int16)
    roundtrip, backward, _ = cv2.calcOpticalFlowPyrLK(source, prior, following, None)
    if roundtrip is None:
        return np.empty(0, dtype=np.int16)
    accepted = (forward.ravel() != 0) & (backward.ravel() != 0) & (errors.ravel() <= 15)
    accepted &= np.linalg.norm(roundtrip[:, 0] - anchors[:, 0], axis=1) <= 1.
    if not np.any(accepted):
        return np.empty(0, dtype=np.int16)
    x0, y0 = np.rint(anchors[accepted, 0]).astype(int).T
    x1, y1 = np.rint(following[accepted, 0]).astype(int).T
    height, width = source.shape
    inside = (x1 >= 0) & (x1 < width) & (y1 >= 0) & (y1 < height)
    x0, y0, x1, y1 = x0[inside], y0[inside], x1[inside], y1[inside]
    kept = masks[region][y1, x1] != 0
    return np.abs(after[y1[kept], x1[kept]] - before[y0[kept], x0[kept]]).max(axis=1)


class MotionResidual:
    def __init__(self):
        self.last = None
        self.statistics = {}

    def observe(self, frame, shot, seconds, state, data):
        if self.last is not None and data is not None:
            last_shot, last_time, last_state, previous = self.last
            if last_shot == shot and 0 < seconds - last_time <= .12 and last_state == state:
                for name in data[2]:
                    values = aligned_residual(previous, data, name)
                    if not len(values):
                        continue
                    entry = self.statistics.setdefault(name, {
                        "transitions": 0, "histogram": np.zeros(511, np.int64), "worst": None,
                    })
                    entry["transitions"] += 1
                    entry["histogram"] += np.bincount(values, minlength=511)
                    peak = int(values.max())
                    if entry["worst"] is None or peak > entry["worst"]["channelDelta"]:
                        entry["worst"] = {"frame": frame, "seconds": seconds, "channelDelta": peak}
        self.last = (shot, seconds, state, data) if data is not None else None

    def result(self):
        regions = {}
        for name, entry in self.statistics.items():
            cumulative = np.cumsum(entry["histogram"])
            total = int(cumulative[-1])
            regions[name] = {"samples": total, "transitions": entry["transitions"],
                             "p95ChannelDelta": int(np.searchsorted(cumulative, .95 * total)),
                             "worst": entry["worst"]}
        return {"version": 1, "regions": regions}
