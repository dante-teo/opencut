"""Beauty control values, protected regions, and skin processing."""

import cv2
import numpy as np


GEOMETRY = (
    "faceSlim", "headReduce", "eyeEnlarge", "bodySlim",
    "waistSlim", "legSlim", "legLength", "armSlim", "armLength",
)


GEOMETRY_SET = set(GEOMETRY)


FACE_GEOMETRY = set(GEOMETRY[:3])


SKIN = ("skinSmooth", "skinBrighten", "warmth", "tint", "saturation", "facialRedness")


FACE_OVAL = (
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
)


FEATURES = (
    (33, 160, 158, 133, 153, 144),
    (362, 385, 387, 263, 373, 380),
    (70, 63, 105, 66, 107, 55, 65, 52, 53, 46),
    (336, 296, 334, 293, 300, 276, 283, 282, 295, 285),
    (61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91),
    (48, 98, 97, 2, 326, 327, 278, 4),
)


def ramp(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def unit(vector):
    return vector / max(1e-5, float(np.linalg.norm(vector)))


def polygon(shape, points):
    mask = np.zeros(shape, np.uint8)
    cv2.fillPoly(mask, [np.rint(points).astype(np.int32)], 255)
    return mask


def sample_parameters(effect, time):
    values = dict(effect["parameters"])
    for name, points in (effect.get("keyframes") or {}).items():
        times = [point["time"] for point in points]
        index = int(np.searchsorted(times, time, side="right")) - 1
        value = points[max(0, index)]["value"]
        if effect["interpolation"] == "linear" and 0 <= index < len(points) - 1:
            weight = (time - times[index]) / (times[index + 1] - times[index])
            value += (points[index + 1]["value"] - value) * weight
        values[name] = value
    return {name: value for name, value in values.items() if value != 0}


def protection(shape, regions, time):
    height, width = shape
    result = np.zeros(shape, bool)
    for region in regions:
        interval = region.get("timeRange")
        if interval and not interval["start"] <= time < interval["end"]:
            continue
        x, y, w, h = (region[key] for key in ("x", "y", "width", "height"))
        result[int(y * height):int(np.ceil((y + h) * height)),
               int(x * width):int(np.ceil((x + w) * width))] = True
    return result


def skin_edit(image, person, parts, face, protected, effect, values):
    shape = person.shape
    active = {name: values[name] for name in SKIN if name in values}
    if not active:
        return image, {}
    face_outline = np.zeros(shape, np.uint8)
    if face is not None:
        face_outline = polygon(shape, face[list(FACE_OVAL)])
        face_mask = face_outline.copy()
        exclusion = np.zeros(shape, np.uint8)
        for indices in FEATURES:
            exclusion |= polygon(shape, face[list(indices)])
        feather = max(3, round(np.linalg.norm(face[454] - face[234]) * .052)) | 1
        exclusion = cv2.dilate(exclusion, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (feather, feather)))
        face_mask[exclusion > 0] = 0
    else:
        face_mask = face_outline
    visible_face = (parts == 3) & (face_mask > 0)
    skin = visible_face.copy()
    if effect["skinScope"] == "visible-target-skin":
        skin |= (parts == 2) & (face_outline == 0)
    confidence = ramp((person.astype(np.float32) - 150) / 95)
    mask = cv2.erode(skin.astype(np.uint8), np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 1.25) * skin * confidence * ~protected
    redness = alpha * visible_face
    # Redness correction is limited to the central forehead and perinasal region.
    # Outer cheek and lip regions may contain intentional blush or lipstick.
    if face is not None:
        zone = polygon(shape, face[[9, 107, 168, 48, 2, 278, 168, 336]])
        redness *= cv2.GaussianBlur(zone.astype(np.float32) / 255, (0, 0), 1.5)
    diagnostics = {}
    for name in list(active):
        weight = redness if name == "facialRedness" else alpha
        if np.count_nonzero(weight > 0.1) < 20:
            diagnostics[name] = (0, "protected-region-or-skin-unreliable")
            del active[name]
    if not active:
        return image, diagnostics

    original = image.astype(np.float32) / 255
    smoothed = original
    if "skinSmooth" in active:
        # Work in encoded RGB for the edge-aware filter and retain high-contrast features.
        sigma = np.clip((np.linalg.norm(face[454] - face[234]) if face is not None else 80) / 65, 1.1, 5)
        low = cv2.bilateralFilter(original, 0, .065, float(sigma), borderType=cv2.BORDER_REFLECT101)
        smoothed = original + (low - original) * (alpha * (.8 * active["skinSmooth"]))[..., None]
        del low

    output, redness_reason = paint_skin(image, smoothed, alpha, redness, visible_face, active)
    for name, value in active.items():
        if name == "facialRedness" and redness_reason:
            diagnostics[name] = (0, redness_reason)
            continue
        if len(active) == 1:
            without = image
        else:
            base = original if name == "skinSmooth" else smoothed
            remaining = {key: strength for key, strength in active.items() if key != name}
            without, _ = paint_skin(image, base, alpha, redness, visible_face, remaining)
        diagnostics[name] = ((0, "no-measurable-pixel-change") if np.array_equal(without, output)
                             else (value, None))
    return output, diagnostics


def paint_skin(image, srgb, alpha, redness, visible_face, active):
    redness_reason = None
    if any(name in active for name in SKIN[1:]):
        lab = cv2.cvtColor(srgb, cv2.COLOR_RGB2Lab)
        light, red, yellow = cv2.split(lab)
        if "skinBrighten" in active:
            # Midtone-weighted lightness lift with vanishing endpoints.
            light += 11 * active["skinBrighten"] * alpha * np.sin(np.pi * light / 100)
        if "facialRedness" in active:
            # Correct a bounded, local excess above a robust complexion baseline.
            sample = red[(alpha > .4) & visible_face]
            if sample.size:
                baseline = float(np.median(sample))
                correction = np.clip(red - baseline - 1.5, 0, 9) * redness * active["facialRedness"] * .65
                if np.any(correction):
                    red -= correction
                else:
                    redness_reason = "redness-not-present"
            else:
                redness_reason = "redness-baseline-unreliable"
        red += alpha * (4 * active.get("tint", 0) + 1.5 * active.get("warmth", 0))
        yellow += alpha * (6 * active.get("warmth", 0) - 1.5 * active.get("tint", 0))
        saturation = 1 + alpha * .35 * active.get("saturation", 0)
        adjusted = cv2.merge((light, red * saturation, yellow * saturation))
        paint = np.any(adjusted != lab, axis=2)
        if np.any(paint):
            converted = cv2.cvtColor(adjusted, cv2.COLOR_Lab2RGB)
            srgb = srgb.copy()
            srgb[paint] = converted[paint]
    output = np.where((alpha > 0)[..., None], np.rint(srgb * 255).clip(0, 255), image).astype(np.uint8)
    return output, redness_reason
