"""A visibility floor for requested, continuously measured reshape controls."""

import json
import math
from pathlib import Path

PROFILE = json.loads(Path(__file__).with_name("visible-result.json").read_text())


class VisibleResult:
    def __init__(self, source_width):
        self.scale = (min(PROFILE["previewWidth"], source_width) & ~1) / source_width
        self.controls = {}
        self.unmeasured_limits = set()

    def observe(self, effect, name, requested, effective, status, index, start, end, measurement):
        key = effect["id"], name
        floor = PROFILE["controls"].get(name)
        if floor is None:
            if status != "applied":
                self.unmeasured_limits.add(key)
            return
        control = self.controls.setdefault(key, {
            "effectId": effect["id"], "parameter": name, "frames": 0, "visibleFrames": 0,
            "missingFrames": 0, "activeSeconds": 0., "visibleSeconds": 0.,
            "longestBelowFloorSeconds": 0., "firstBelowFloorFrame": None,
        })
        control["frames"] += 1
        control["activeSeconds"] += end - start
        pixels = measurement[2] * self.scale if measurement and len(measurement) >= 3 else 0.
        percent = measurement[1] if measurement else 0.
        retained = abs(effective / requested) if requested else 0.
        strong_start = PROFILE["strongSettingStartsAt"]
        strong_fraction = max(0., (abs(requested) - strong_start) / (1 - strong_start))
        multiplier = 1 + strong_fraction * (PROFILE["maximumSettingFloorMultiplier"] - 1)
        percent_floor = floor["percent"] * multiplier
        pixel_floor = floor["previewPixels"] * multiplier
        continuous = PROFILE["minimumContinuousEffectFraction"]
        measurable = (math.isfinite(percent) and math.isfinite(pixels)
                      and percent > percent_floor * continuous
                      and pixels > pixel_floor * continuous and retained >= continuous)
        visible = (measurable and percent >= percent_floor and pixels >= pixel_floor)
        if visible:
            control["visibleFrames"] += 1
            control["visibleSeconds"] += end - start
            control.pop("_belowStart", None)
            control.pop("_belowFrame", None)
        else:
            if control.get("_belowFrame") != index - 1:
                control["_belowStart"] = start
            control["_belowFrame"] = index
            control["longestBelowFloorSeconds"] = max(
                control["longestBelowFloorSeconds"], end - control["_belowStart"],
            )
            if control["firstBelowFloorFrame"] is None:
                control["firstBelowFloorFrame"] = index
        if not measurable:
            control["missingFrames"] += 1

    def result(self, empty_controls):
        controls = []
        for entry in self.controls.values():
            record = {key: value for key, value in entry.items() if not key.startswith("_")}
            duration = record["activeSeconds"]
            fraction = record["visibleSeconds"] / duration if duration else 0.
            record["status"] = "passed" if (
                not record["missingFrames"]
                and fraction + 1e-9 >= PROFILE["minimumVisibleDurationFraction"]
                and record["longestBelowFloorSeconds"] <= PROFILE["maximumBelowFloorSeconds"] + 1e-9
            ) else "failed"
            controls.append(record)
        unavailable = sorted(self.unmeasured_limits | set(empty_controls))
        passed = bool(controls) and not unavailable and all(item["status"] == "passed" for item in controls)
        return {
            "profile": PROFILE["version"], "status": "passed" if passed else "failed",
            "controls": controls,
            "unavailableControls": [{"effectId": effect, "parameter": name} for effect, name in unavailable],
        }
