"""Plan, validate, and composite source-space beauty edits."""

import cv2
import numpy as np

from controls import (
    FACE_GEOMETRY,
    GEOMETRY,
    GEOMETRY_SET,
    ramp,
    unit,
)
from deformation import (
    Field,
    build_geometry,
    cropped_head_boundary,
    head_geometry,
)
from background import (
    continue_context_background,
    reconstruct_background,
    register_portrait_background,
)
from contours import (
    clear_false_accessories,
    infer_head_contour,
    observed_head_background,
    refine_context_hands,
    refine_contour,
    restore_vacated_limb_edges,
    temporal_arm_skin,
    transfer_limb_edges,
    transfer_portrait_hair_edges,
    transfer_smooth_portrait_edges,
)


def destination_points(field, points):
    """Invert the accepted sampling map at a small set of source landmarks."""
    points = np.asarray(points, np.float32)
    candidate = points.copy()
    for _ in range(10):
        x = candidate[:, 0, None]
        y = candidate[:, 1, None]
        dx = cv2.remap(field.dx, x, y, cv2.INTER_LINEAR).ravel()
        dy = cv2.remap(field.dy, x, y, cv2.INTER_LINEAR).ravel()
        candidate = points - np.column_stack((dx, dy))
    return candidate


def shape_measurements(field, alpha, head, face, pose, effective):
    """Measure the accepted geometric map relative to its source silhouette."""
    result = {}
    if effective.get("headReduce", (0, None))[0]:
        mask = None
        offset = np.zeros(2, int)
        if head is not None and head[-1] is not None:
            patch, component = head[-1]
            mask = alpha[patch] * component
            offset = np.array([patch[1].start, patch[0].start])
        elif face is not None:
            across = unit(face[454] - face[234])
            width = np.linalg.norm(face[454] - face[234])
            height = np.linalg.norm(face[152] - face[10])
            u, v = field.coordinates(face[152], across)
            mask = alpha * ((np.abs(u) < width * 1.06) & (v <= 0) & (v >= -2 * height))
        outlines = () if mask is None else cv2.findContours(
            (mask >= .5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE,
        )[0]
        # Measure the boundary through the validated inverse field. Counting
        # resampled mask pixels makes subpixel changes depend on the position
        # of the head against the raster, especially in wide shots.
        if outlines:
            outline = max(outlines, key=cv2.contourArea)
            area = cv2.contourArea(outline)
            if area > 0 and len(outline) < 32_767:
                transformed = destination_points(field, outline.reshape(-1, 2) + offset)
                deformed_area = cv2.contourArea(transformed)
                diameter_change = 2 * (np.sqrt(area) - np.sqrt(deformed_area)) / np.sqrt(np.pi)
                result["headReduce"] = ("head-silhouette-area-reduction-percent",
                                        100 * (area - deformed_area) / area, float(diameter_change))
    if effective.get("faceSlim", (0, None))[0] and face is not None:
        cheeks = face[[132, 361, 172, 397, 58, 288]].reshape(-1, 2, 2)
        warped = destination_points(field, cheeks.reshape(-1, 2)).reshape(-1, 2, 2)
        before = np.linalg.norm(cheeks[:, 1] - cheeks[:, 0], axis=1)
        after = np.linalg.norm(warped[:, 1] - warped[:, 0], axis=1)
        supported = before >= 8
        if np.any(supported):
            contraction = 100 * (before[supported] - after[supported]) / before[supported]
            result["faceSlim"] = ("mean-cheek-width-reduction-percent", float(np.mean(contraction)),
                                  float(np.mean(before[supported] - after[supported])))
    if effective.get("armLength", (0, None))[0] and pose is not None:
        source = pose[:, :2]
        chains = [(11, 13, 15), (12, 14, 16)]
        lengths = []
        for chain in chains:
            ids = list(chain)
            if (pose[ids, 2] < .55).any():
                continue
            points = source[ids]
            after = destination_points(field, points)
            old_length = np.linalg.norm(np.diff(points, axis=0), axis=1).sum()
            if old_length < 16:
                continue
            new_length = np.linalg.norm(np.diff(after, axis=0), axis=1).sum()
            lengths.append((100 * (new_length - old_length) / old_length, new_length - old_length))
        if lengths:
            percent, pixels = map(float, np.mean(lengths, axis=0))
            result["armLength"] = ("mean-arm-chain-extension-percent", percent, pixels)
    if effective.get("legLength", (0, None))[0] and pose is not None:
        points = pose[[23, 24, 27, 28], :2]
        after = destination_points(field, points)
        old_height = np.mean(points[2:, 1] - points[:2, 1])
        if old_height > 0:
            new_height = np.mean(after[2:, 1] - after[:2, 1])
            pixels = float(new_height - old_height)
            result["legLength"] = ("mean-hip-to-ankle-extension-percent", 100 * pixels / float(old_height), pixels)
    return result


def composite_geometry(image, plate, original_alpha, alpha, delta, moved, x, y):
    """Composite the output patch from only the pixels its map can sample."""
    edit = moved & ((alpha > .025) | delta)
    left, top, width, height = cv2.boundingRect(edit.astype(np.uint8))
    if not width:
        return image
    destination = np.s_[top:top + height, left:left + width]
    map_x, map_y = x[destination], y[destination]
    sample_left, sample_top = int(map_x.min()), int(map_y.min())
    sample_right = min(image.shape[1], int(map_x.max()) + 2)
    sample_bottom = min(image.shape[0], int(map_y.max()) + 2)
    source = np.s_[sample_top:sample_bottom, sample_left:sample_right]
    opacity = original_alpha[source][..., None]
    premultiplied = image[source].astype(np.float32) * opacity
    # Remove the old background in verified soft samples before resampling.
    restored = delta[source] & (opacity[..., 0] > 0) & (opacity[..., 0] < 1)
    if np.any(restored):
        weight = opacity[restored]
        unmixed = image[source][restored] - plate[source][restored] * (1 - weight)
        premultiplied[restored] = np.clip(unmixed, 0, 255 * weight)
    warped = cv2.remap(premultiplied, map_x - sample_left, map_y - sample_top, cv2.INTER_LINEAR)
    mask = edit[destination]
    weight = alpha[destination][mask, None]
    result = image.copy()
    result[destination][mask] = np.rint(warped[mask] + plate[destination][mask] * (1 - weight)).clip(0, 255).astype(np.uint8)
    return result


def body_geometry_window(person, values):
    """Keep a high-resolution body map near the person and its possible motion."""
    height, width = person.shape
    x, y, subject_width, subject_height = cv2.boundingRect((person > 26).astype(np.uint8))
    if not subject_width:
        return None
    # Leg lift, arm reach, and head contraction can all expose pixels outside
    # the old bounds. Leave space for their combined travel and background fit.
    travel = (.13 * values.get("legLength", 0) + .18 * values.get("armLength", 0)
              + .15 * max((values.get(name, 0) for name in GEOMETRY_SET - {"legLength", "armLength"}), default=0))
    margin = max(128, round(max(subject_width, subject_height) * travel + min(height, width) * .035))
    left, top = max(0, x - margin), max(0, y - margin)
    right = min(width, x + subject_width + margin)
    bottom = min(height, y + subject_height + margin)
    if (right - left) * (bottom - top) >= .82 * person.size:
        return None
    return np.s_[top:bottom, left:right]


def geometry_edit(image, original, person, parts, face, pose, protected, context, values, policy, head_neighbors=None,
                  *, distant_context=(), shot_context=(), background_context=(), arm_neighbors=None):
    inputs = (image, original, person, parts, face, pose, protected, context)
    requested = GEOMETRY_SET.intersection(values)
    if background_context and requested and requested <= {"headReduce", "armLength", "legLength"}:
        with_context = remap_geometry(
            *inputs[:-1], (*context, *background_context), values, policy, head_neighbors,
            use_background_support=True, wrist_anchor=True, background_context=background_context,
        )
        effective = with_context[1]
        if all(effective[name] == (values[name], None) for name in requested):
            return with_context
        if effective.get("armLength", (0, None))[1] in {"partial-arm-coverage", "wrist-protected-elbow-extension"}:
            labels = (temporal_arm_skin(original, person, parts, pose, protected, arm_neighbors())
                      if arm_neighbors is not None else parts)
            corrected, labels = refine_context_hands(original, person, labels, pose, protected, background_context)
            candidate = remap_geometry(
                image, original, corrected, labels, face, pose, protected, (*context, *background_context),
                values, policy, head_neighbors, use_background_support=True, wrist_anchor=True,
                background_context=background_context,
            )
            if all(candidate[1][name] == (values[name], None) for name in requested):
                return candidate
    hair_context = background_context if {"headReduce", "faceSlim"} <= requested else ()
    baseline = geometry_at_source_resolution(
        *inputs, values, policy, head_neighbors, distant_context, shot_context, hair_context=hair_context,
    )
    if (background_context and {"headReduce"} < requested <= FACE_GEOMETRY
            and baseline[1]["headReduce"] != (values["headReduce"], None)
            and policy["invalidGeometry"] == policy["unreliableReconstruction"] == "attenuate"):
        # Both retries use the same frame and reference footage. Reuse its
        # alignment only when their occupied pixels also match.
        registered = None
        previous_mask = None

        def register_once(image, occupied, references):
            nonlocal registered, previous_mask
            if registered is None or not np.array_equal(previous_mask, occupied):
                registered = register_portrait_background(image, occupied, references)
                previous_mask = occupied.copy()
            return registered

        candidate = remap_geometry(
            *inputs[:-1], (*context, *background_context), values, policy, head_neighbors,
            use_background_support=True, background_context=background_context, register_background=register_once,
        )
        previous = baseline[2].get("measurements", {}).get("headReduce", (None, 0))[1]
        recovered = candidate[2].get("measurements", {}).get("headReduce", (None, 0))[1]
        if recovered > previous and all(candidate[1][name][0] >= baseline[1][name][0] for name in requested):
            baseline = candidate
        if "faceSlim" in requested and any(baseline[1][name] != (values[name], None) for name in requested):
            candidate = remap_geometry(
                *inputs[:-1], (*context, *background_context), values, policy, head_neighbors,
                separate_pins=True, use_background_support=True, background_context=background_context, register_background=register_once,
            )
            measured = ("faceSlim", "headReduce")
            before = [baseline[2].get("measurements", {}).get(name, (None, 0))[1] for name in measured]
            after = [candidate[2].get("measurements", {}).get(name, (None, 0))[1] for name in measured]
            if (all(candidate[1][name][0] >= baseline[1][name][0] for name in requested - set(measured))
                    and all(b > 0 and b >= a for a, b in zip(before, after))
                    and any(b > a for a, b in zip(before, after))):
                baseline = candidate
    shapes = ("headReduce", "armLength", "legLength")
    if (person.size < 4_000_000 or not requested <= set(shapes) or len(requested) < 2
            or any(strength for strength, _ in baseline[1].values())
            or policy["invalidGeometry"] != "attenuate" or policy["unreliableReconstruction"] != "attenuate"):
        return baseline

    # A combined deformation can fail even where individual contours are
    # supported. Try upper-body edits without the lift before isolating one
    # control. Each candidate goes through the same geometry and plate checks.
    unobserved = {"head-contour-unreliable", "arm-chain-occluded-or-unreliable", "region-not-visible"}
    visible = [name for name in shapes if name in requested and baseline[1][name][1] not in unobserved]
    candidates = [(name,) for name in visible]
    if len(requested) == 3 and all(name in visible for name in shapes[:2]):
        candidates.insert(0, shapes[:2])
    for candidate in candidates:
        if set(candidate) == requested:
            continue
        fitted = {name: values[name] for name in candidate}
        edited, outcomes, metrics = geometry_at_source_resolution(*inputs, fitted, policy, head_neighbors, (), ())
        if not any(strength for strength, _ in outcomes.values()):
            continue
        omitted = {name: (0, "combined-shape-conflict" if name in visible else detail)
                   for name, (_, detail) in baseline[1].items() if name not in outcomes}
        return edited, omitted | outcomes, metrics
    return baseline


def geometry_at_source_resolution(image, original, person, parts, face, pose, protected, context, values, policy,
                                  head_neighbors, distant_context, shot_context, *, hair_context=()):
    requested = GEOMETRY_SET.intersection(values)
    if face is not None and person.size >= 4_000_000 and requested and requested <= FACE_GEOMETRY:
        height, width = person.shape
        across = unit(face[454] - face[234])
        down = np.array([-across[1], across[0]], np.float32)
        span = np.linalg.norm(face[454] - face[234])
        face_height = np.linalg.norm(face[152] - face[10])
        bounds = [face]
        if "headReduce" in requested:
            # Match the support of the actual head field, using the observed
            # hair boundary. An arbitrary face-height box includes most of
            # the torso at high resolution.
            neck = .97 * face[152] + .03 * face[10]
            ys, xs = np.nonzero((parts == 1) & (person > 128))
            hair_x, hair_y = xs.astype(np.float32) - neck[0], ys.astype(np.float32) - neck[1]
            u = hair_x * across[0] + hair_y * across[1]
            v = hair_x * down[0] + hair_y * down[1]
            hair = (np.abs(u) < span) & (v < 0) & (v > -1.9 * face_height)
            if np.any(hair):
                reach_x = max(span * .66, float(np.max(np.abs(u[hair]))) * 1.22)
                reach_y = max(face_height * 1.22, float(-np.min(v[hair])) * 1.18)
                bounds.append(np.array([neck + across * reach_x * x + down * y
                                        for x in (-1.16, 1.16)
                                        for y in (-1.12 * reach_y, .13 * face_height)]))
        if "faceSlim" in requested:
            center = (face[1] + face[152]) * .5
            bounds.append(np.array([center + across * span * u + down * face_height * v
                                    for u in (-.70, .70) for v in (-.46, .46)]))
        if "eyeEnlarge" in requested:
            for first, last in ((33, 133), (362, 263)):
                a, b = face[[first, last]]
                center = (a + b) * .5
                radius = np.linalg.norm(a - b) * 1.35
                bounds.append(np.array([center - radius, center + radius]))
        envelope = np.concatenate(bounds)
        lower, upper = envelope.min(axis=0), envelope.max(axis=0)
        margin = max(128, round(min(height, width) * .05))
        left, top = np.maximum(0, np.floor(lower).astype(int) - margin)
        right, bottom = np.minimum((width, height), np.ceil(upper).astype(int) + margin)
        if 32 <= right-left and 32 <= bottom-top and (right-left) * (bottom-top) < .82 * person.size:
            window = np.s_[top:bottom, left:right]
            neighbors = [(rgb[window], mask[window]) for rgb, mask in context]
            patch, effective, metrics = remap_geometry(
                image[window], original[window], person[window], parts[window],
                face - np.array([left, top], np.float32), None, protected[window],
                neighbors, values, policy,
                hair_context=[(rgb[window], mask[window]) for rgb, mask in hair_context],
            )
            if not any(item[0] for item in effective.values()):
                return image, effective, {}
            result = image.copy()
            result[window] = patch
            if "reconstructionBox" in metrics:
                metrics["reconstructionBox"][0] += window[1].start
                metrics["reconstructionBox"][1] += window[0].start
            return result, effective, metrics
    if person.size >= 3_000_000 and requested:
        window = body_geometry_window(person, values)
        if window is not None:
            height, width = person.shape
            offset = np.array([window[1].start, window[0].start], np.float32)
            local_pose = None if pose is None else pose.copy()
            if local_pose is not None:
                local_pose[:, :2] -= offset
            local_face = None if face is None else face - offset
            neighbors = [(rgb[window], mask[window]) for rgb, mask in context]
            references = [(rgb[window], mask[window]) for rgb, mask in shot_context]
            patch, effective, metrics = recover_combined_geometry(
                image[window], original[window], person[window], parts[window], local_face, local_pose,
                protected[window], neighbors, values, policy, head_neighbors, (), references,
                frame_edge=max(9, min(height, width) * .035),
                hair_context=[(rgb[window], mask[window]) for rgb, mask in hair_context],
            )
            if not any(item[0] for item in effective.values()):
                return image, effective, {}
            result = image.copy()
            result[window] = patch
            if "reconstructionBox" in metrics:
                metrics["reconstructionBox"][0] += window[1].start
                metrics["reconstructionBox"][1] += window[0].start
            return result, effective, metrics
    return recover_combined_geometry(
        image, original, person, parts, face, pose, protected, context, values, policy, head_neighbors,
        distant_context, shot_context, hair_context=hair_context,
    )


def recover_combined_geometry(image, original, person, parts, face, pose, protected, context, values, policy,
                              head_neighbors, distant_context, shot_context, *, frame_edge=None, hair_context=()):
    inputs = (image, original, person, parts, face, pose, protected, context)
    current = remap_geometry(*inputs, values, policy, head_neighbors, frame_edge=frame_edge, hair_context=hair_context)
    if (frame_edge is not None and pose is not None and GEOMETRY_SET.intersection(values) == {"legLength"}
            and policy["invalidGeometry"] == policy["unreliableReconstruction"] == "attenuate"
            and current[1]["legLength"] != (values["legLength"], None)
            and current[1]["legLength"][1] != "unsupported-stance-for-ground-anchor"):
        candidate = remap_geometry(
            *inputs[:-1], (*context, *shot_context), values, policy, head_neighbors,
            separate_pins=True, use_background_support=True, background_context=shot_context,
            frame_edge=frame_edge,
        )
        if shape_strength_improves(("legLength",), current, candidate, image, None):
            return candidate
    if (not values.get("legLength") or pose is None or person.size > 2_000_000
            or policy["invalidGeometry"] != "attenuate"
            or policy["unreliableReconstruction"] != "attenuate"):
        return current

    missing = {name for name in ("headReduce", "armLength")
               if current[1].get(name) == (0, "requested-shape-change-unmeasurable")}
    recovered_head = "headReduce" in missing
    alternatives = [(1.0, True)] if recovered_head else []
    if "armLength" in missing or (recovered_head and values.get("armLength")):
        alternatives.extend((lift, recovered_head) for lift in (.65, .40))

    for lift, even_head in alternatives:
        pending = {name for name in missing if not current[1][name][0]}
        if not pending:
            break
        candidate_values = values if lift == 1 else values | {"legLength": values["legLength"] * lift}
        attempt = remap_geometry(
            *inputs, candidate_values, policy, head_neighbors, even_head=even_head, frame_edge=frame_edge,
        )
        old = {name for name, (amount, _) in current[1].items() if amount > 0}
        new = {name for name, (amount, _) in attempt[1].items() if amount > 0}
        if old <= new and pending & new:
            if lift < 1 and attempt[1]["legLength"][0]:
                attempt[1]["legLength"] = (attempt[1]["legLength"][0], "combined-shape-conflict")
            current = attempt
    return recover_shape_strength(
        inputs, values, policy, head_neighbors, current, distant_context, shot_context, frame_edge,
    )


def recover_shape_strength(inputs, values, policy, head_neighbors, baseline, distant_context, shot_context, frame_edge):
    shapes = {"headReduce", "armLength", "legLength"}
    image, original, person, parts, face, pose, protected, context = inputs
    if (values.keys() != shapes or person.size > 1_000_000 or frame_edge is not None
            or all(baseline[1][name] == (values[name], None) for name in shapes)):
        return baseline
    background = observed_head_background(original, person, pose, face, protected, context)
    stationary = None
    if background is not None:
        region, observed = background
        gray = cv2.cvtColor(original[region], cv2.COLOR_RGB2GRAY)
        edges = cv2.dilate(cv2.Canny(gray, 45, 95), np.ones((3, 3), np.uint8)) != 0
        stationary = region, observed & edges
    if len(shot_context) >= 2:
        candidate = remap_geometry(
            *inputs[:-1], (*context, *shot_context), values, policy, head_neighbors,
            use_background_support=True, frame_edge=frame_edge,
        )
        if shape_strength_improves(values, baseline, candidate, image, stationary):
            baseline = candidate
            if all(baseline[1][name] == (values[name], None) for name in shapes):
                return baseline
    if not all(baseline[1][name][0] for name in shapes):
        return baseline
    for use_background_support in (False, True):
        candidate = remap_geometry(
            *inputs, values, policy, head_neighbors, separate_pins=True,
            stationary_edges=stationary, distant_context=distant_context,
            use_background_support=use_background_support, frame_edge=frame_edge,
        )
        if shape_strength_improves(values, baseline, candidate, image, stationary):
            baseline = candidate
    if stationary is not None:
        previous = stationary_edge_error(image, baseline[0], stationary)
        candidate = remap_geometry(
            *inputs, values, policy, head_neighbors, separate_pins=True,
            distant_context=distant_context, use_background_support=True,
            edge_reference=(*stationary, previous), frame_edge=frame_edge,
        )
        if shape_strength_improves(values, baseline, candidate, image, stationary):
            baseline = candidate
    return baseline


def stationary_edge_error(image, result, stationary):
    region, verified = stationary
    return np.abs(result[region][verified].astype(np.int16) - image[region][verified]).max(axis=1)


def worsens_stationary_edges(before, after):
    return np.count_nonzero(after > 4) > np.count_nonzero(before > 4) or after.sum() > before.sum()


def shape_strength_improves(values, baseline, candidate, image, stationary):
    before, after = baseline[2].get("measurements", {}), candidate[2].get("measurements", {})
    for name in values:
        prior, strength = baseline[1][name][0], candidate[1][name][0]
        prior_shape = before.get(name, (None, 0))[1]
        new_shape = after.get(name, (None, 0))[1]
        if strength < prior or (strength and (new_shape <= 0 or new_shape < prior_shape)):
            return False
    if not any(candidate[1][name][0] > baseline[1][name][0] for name in values):
        return False
    if stationary is not None:
        previous = stationary_edge_error(image, baseline[0], stationary)
        current = stationary_edge_error(image, candidate[0], stationary)
        if worsens_stationary_edges(previous, current):
            return False
    return True


def head_lift_clearance(head, clearance):
    """Keep a protected head moving evenly rather than stretching it around pins."""
    region, component = head[-1]
    mask = np.zeros(clearance.shape, np.uint8)
    mask[region] = component
    radius = max(3, round(head[4] * .10))
    footprint = cv2.dilate(mask, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8))
    minimum = float(np.min(clearance, where=footprint != 0, initial=1))
    if minimum == 1:
        return clearance
    distance = cv2.distanceTransform(1 - footprint, cv2.DIST_L2, 3)
    fade = ramp(distance / max(8, head[4] * .64))
    return np.minimum(clearance, minimum + (1 - minimum) * fade)


def retained_shape_strength(name, value, person, parts, face, pose, head, clearance, lift):
    """Measure how much of one control's field survived local contour pins."""
    if person.size > 2_000_000:
        return large_shape_strength(name, value, person, parts, face, pose, head, clearance, lift)
    contribution = Field(person.shape)
    build_geometry(contribution, person, parts, face, pose, {name: value}, head)
    sampled_person = person
    if lift is not None and name != "legLength":
        contribution.compose_lift(lift)
        contribution.dy -= lift
        sampled_person = cv2.remap(
            person, contribution.x, contribution.y + lift, cv2.INTER_LINEAR,
        )
    magnitude = np.abs(contribution.dx) + np.abs(contribution.dy)
    visible = (magnitude > .08) & ((sampled_person > 50) | (person > 50))
    if not np.any(visible):
        return 1.0, False
    local = clearance[visible]
    portion = float(np.average(local, weights=magnitude[visible]))
    return portion, bool(np.any(local < 1 - 1e-6))


def large_shape_strength(name, value, person, parts, face, pose, head, clearance, lift):
    """Measure only a control's visible displacement and bound the sampling buffers."""
    shifted = lift is not None and name != "legLength"
    contribution = None
    if name != "legLength" or lift is None:
        contribution = Field(person.shape)
        build_geometry(contribution, person, parts, face, pose, {name: value}, head)
        if shifted:
            contribution.compose_lift(lift)
            contribution.dy -= lift
    total = retained = 0.
    pinned = False
    height, width = person.shape
    rows = max(1, 1_000_000 // width)
    for top in range(0, height, rows):
        region = np.s_[top:min(height, top + rows), :]
        if contribution is None:
            magnitude = np.abs(lift[region])
        else:
            magnitude = np.abs(contribution.dx[region]) + np.abs(contribution.dy[region])
        visible = person[region] > 50
        if shifted:
            sampled = cv2.remap(
                person, contribution.x[region], contribution.y[region] + lift[region], cv2.INTER_LINEAR,
            )
            visible |= sampled > 50
        visible &= magnitude > .08
        weights, current = magnitude[visible], clearance[region][visible]
        total += float(weights.sum(dtype=np.float64))
        retained += float(np.sum(weights * current, dtype=np.float64))
        pinned |= bool(np.any(current < 1 - 1e-6))
    return (retained / total, pinned) if total else (1., False)


def shape_contributions(person, parts, face, pose, values, head, lift, feather):
    """Keep independent contour controls in the same composed coordinates."""
    result = {}
    for name in ("headReduce", "armLength", "legLength", "faceSlim"):
        if name not in values:
            continue
        value = values[name]
        component = Field(person.shape)
        build_geometry(component, person, parts, face, pose, {name: value}, head)
        if lift is not None and name != "legLength":
            component.compose_lift(lift)
            component.dy -= lift
        component.dx *= feather
        component.dy *= feather
        result[name] = component
    return result


def choose_shape_pins(alpha, coordinates, vectors, *, keep_background=False, priority=None):
    """Pin only the motions that would uncover or cover protected background."""
    total = vectors.sum(axis=0)
    loss = np.full(len(coordinates), np.inf)
    all_controls = (1 << len(vectors)) - 1
    chosen = np.full(len(coordinates), all_controls, np.uint8)
    for subset in range(1, all_controls + 1):
        selection = [bool(subset & (1 << index)) for index in range(len(vectors))]
        selected = vectors[selection]
        remaining = total - selected.sum(axis=0)
        x, y = (coordinates + remaining).T
        opacity = cv2.remap(alpha, x[:, None], y[:, None], cv2.INTER_LINEAR).ravel()
        safe_opacity = opacity <= .025 if keep_background else opacity >= .975
        covered = safe_opacity | (np.abs(remaining).sum(axis=1) <= .08)
        loss_vectors = np.abs(selected)
        if priority is not None:
            loss_vectors *= priority[selection, None, None]
        cost = loss_vectors.sum(axis=(0, 2)) + .015 * subset.bit_count()
        accepted = covered & (cost < loss)
        loss[accepted] = cost[accepted]
        chosen[accepted] = subset
    return chosen


def apply_shape_pins(alpha, pixels, components, weights, pins, strength, *, keep_background=False):
    row, col = np.nonzero(pixels)
    if len(row) >= 32_767:
        return False
    coordinates = np.column_stack((col, row)).astype(np.float32)
    vectors = np.stack([
        np.column_stack((field.dx[row, col], field.dy[row, col])) * weights[name][row, col, None] * strength
        for name, field in components.items()
    ])
    # Preserve the cheek edit when pinning the outer head motion alone can
    # cover the same uncertain background.
    priority = np.array([4. if name == "faceSlim" else 1. for name in components]) if "faceSlim" in components else None
    chosen = choose_shape_pins(alpha, coordinates, vectors, keep_background=keep_background, priority=priority)
    added = False
    for index, name in enumerate(components):
        affected = (chosen & (1 << index)) != 0
        yy, xx = row[affected], col[affected]
        added |= bool(np.any(~pins[name][yy, xx]))
        pins[name][yy, xx] = True
    return added


def assemble_shape_pins(field, components, pins, strength, head, edge, transition=1):
    weights = {}
    field.dx = np.zeros_like(field.dx)
    field.dy = np.zeros_like(field.dy)
    kernel = np.ones((7, 7), np.uint8)
    for name, component in components.items():
        clearance = cv2.distanceTransform((~pins[name]).astype(np.uint8), cv2.DIST_L2, 3)
        displacement = cv2.dilate(np.maximum(np.abs(component.dx), np.abs(component.dy)), kernel)
        reach = np.clip(3.5 * strength * displacement + 2, 6, max(7, edge))
        weight = ramp((clearance - 2) / (reach * transition))
        if name == "legLength" and head is not None and head[-1] is not None:
            weight = head_lift_clearance(head, weight)
        field.dx += component.dx * weight * strength
        field.dy += component.dy * weight * strength
        weights[name] = weight
    return weights


def retained_component_strength(component, weight, person):
    magnitude = np.abs(component.dx) + np.abs(component.dy)
    support = (magnitude > .08) & (person > 50)
    if not np.any(support):
        return 1., False
    current = weight[support]
    return float(np.average(current, weights=magnitude[support])), bool(np.any(current < 1 - 1e-6))


def portrait_backoff(field, eye_dx, eye_dy):
    """Find a stronger valid contour scale while preserving the eye field."""
    dx, dy = field.dx, field.dy
    contour_x, contour_y = dx - eye_dx, dy - eye_dy
    low, high = 0., 1.
    for _ in range(5):
        candidate = (low + high) / 2
        field.dx = contour_x * candidate + eye_dx
        field.dy = contour_y * candidate + eye_dy
        if field.valid(1):
            low = candidate
        else:
            high = candidate
    field.dx, field.dy = dx, dy
    return low or .60


def remap_geometry(image, original, person, parts, face, pose, protected, context, values, policy, head_neighbors=None,
                   *, even_head=False, separate_pins=False, stationary_edges=None, distant_context=(),
                   use_background_support=False, frame_edge=None, edge_reference=None, wrist_anchor=False,
                   background_context=(), hair_context=(), register_background=register_portrait_background):
    if not any(name in values for name in GEOMETRY):
        return image, {}, {}
    field = Field(person.shape)
    if values.get("armLength"):
        person, parts = clear_false_accessories(original, person, parts, protected, context)
    contour_values = {name: value for name, value in values.items()
                      if name in GEOMETRY_SET and name != "eyeEnlarge"}
    known_background = None
    if {"headReduce", "legLength", "armLength"} & contour_values.keys():
        known_background = observed_head_background(original, person, pose, face, protected, context)
        if known_background is not None:
            region, observed = known_background
            if np.any(person[region][observed]):
                person = person.copy()
                person[region][observed] = 0
    head = head_geometry(person, parts, face, pose) if contour_values.get("headReduce") else None
    if (contour_values.get("headReduce") and head is None and pose is not None
            and head_neighbors is not None and not cropped_head_boundary(person, parts, face)):
        contour = infer_head_contour(original, person, pose, protected, head_neighbors())
        if contour is not None:
            head = head_geometry(person, parts, face, pose, contour)
    diagnostics = build_geometry(field, person, parts, face, pose, contour_values, head, wrist_anchor=wrist_anchor)
    # Feather displacement near protected pixels and frame edges.
    height, width = person.shape
    edge = frame_edge if frame_edge is not None else max(9, min(height, width) * .035)
    if contour_values.keys() == {"legLength"} and field.lift is not None:
        edge = max(edge, 5.5 * float(field.lift.max()))
    frame_distance = np.minimum(field.x, field.y)
    np.minimum(frame_distance, width - 1 - field.x, out=frame_distance)
    np.minimum(frame_distance, height - 1 - field.y, out=frame_distance)
    feather = ramp(frame_distance / edge)
    if np.any(protected):
        distance = cv2.distanceTransform((~protected).astype(np.uint8), cv2.DIST_L2, 3)
        conflict = np.any((np.abs(field.dx) + np.abs(field.dy) > .4) & (distance < 2))
        clearance_width = edge
        if {"headReduce", "faceSlim"} <= contour_values.keys():
            # Small cheek shifts need a shorter transition than the outer head.
            reach = np.maximum(np.abs(field.dx), np.abs(field.dy))
            reach = cv2.dilate(reach, np.ones((7, 7), np.uint8))
            clearance_width = np.clip(3.5 * reach + 2, 6, edge)
        feather *= ramp(distance / clearance_width)
    else:
        conflict = False
    field.dx *= feather
    field.dy *= feather
    eye_dx = eye_dy = 0
    if values.get("eyeEnlarge"):
        eyes = Field(person.shape)
        eye_values = {"eyeEnlarge": values["eyeEnlarge"]}
        diagnostics.update(build_geometry(eyes, person, parts, face, None, eye_values))
        if diagnostics["eyeEnlarge"][0]:
            face_interior = cv2.distanceTransform(((person > 225) & (parts == 3) & ~protected).astype(np.uint8), cv2.DIST_L2, 3)
            eye_weight = ramp(face_interior / max(4, edge * .32))
            eye_dx = eyes.dx * eye_weight
            eye_dy = eyes.dy * eye_weight
            if not np.any(np.abs(eye_dx) + np.abs(eye_dy) > .08):
                reason = ("eyes-closed-or-unreliable" if not np.any(np.abs(eyes.dx) + np.abs(eyes.dy) > .08)
                          else "eye-region-protected")
                diagnostics["eyeEnlarge"] = (0, reason)
                eye_dx = eye_dy = 0
    if not any(value for value, _ in diagnostics.values()):
        return image, diagnostics, {}
    contour_x, contour_y = field.dx, field.dy
    original_alpha = refine_contour(original, person, protected, pose, known_background)
    occupied = (original_alpha > .025) | protected
    strength, reason = 1, "protected-region-conflict" if conflict else None
    internal = None
    blocked = np.zeros(person.shape, bool)
    components = None
    if separate_pins:
        if any(not diagnostics[name][0] for name in contour_values):
            return image, diagnostics, {}
        components = shape_contributions(person, parts, face, pose, contour_values, head, field.lift, feather)
        pins = {name: np.zeros(person.shape, bool) for name in components}
        if stationary_edges is not None:
            region, verified = stationary_edges
            for pin in pins.values():
                pin[region] = verified
        context_for_reconstruction = (*context, *distant_context)
    else:
        context_for_reconstruction = context
    shape_names = {"headReduce", "legLength", "armLength"} & contour_values.keys()
    internal_names = {"faceSlim", "bodySlim", "waistSlim", "legSlim", "armSlim"}
    if policy["invalidGeometry"] == "fail" and any(r == "insufficient-headroom" for _, r in diagnostics.values()):
        raise ValueError("Insufficient headroom for ground-anchored leg lengthening.")
    combined_portrait = {"headReduce", "faceSlim"} <= contour_values.keys()
    hair_references = hair_context or background_context
    registered = None
    transition = 1
    for attempt in range(8):
        contour_strength = strength if separate_pins or attempt < 6 else 0
        if attempt == 6 and not separate_pins:
            # Keep a conservative interior change when the contour cannot be
            # reconstructed. Full-head and leg-length changes need a valid plate.
            eligible = {key: values[key] for key in internal_names if diagnostics.get(key, (0, None))[0]}
            if eligible:
                internal = Field(person.shape)
                build_geometry(internal, person, parts, face, pose, eligible)
                safe_core = cv2.distanceTransform((original_alpha > .999).astype(np.uint8), cv2.DIST_L2, 3)
                internal_weight = ramp((safe_core - max(4, edge * .28)) / max(5, edge * .55)) * .28 * feather
                internal.dx *= internal_weight
                internal.dy *= internal_weight
        safe = 1
        lift_safe = None
        if components is not None:
            weights = assemble_shape_pins(field, components, pins, strength, head, edge, transition)
            field.dx += eye_dx
            field.dy += eye_dy
        elif attempt == 6 and internal is not None:
            field.dx = internal.dx + eye_dx
            field.dy = internal.dy + eye_dy
        else:
            if np.any(blocked) and contour_strength:
                clearance = cv2.distanceTransform((~blocked).astype(np.uint8), cv2.DIST_L2, 3)
                safe = ramp((clearance - 2) / max(7, edge))
            field.dx = contour_x * contour_strength * safe + eye_dx
            field.dy = contour_y * contour_strength * safe + eye_dy
            if (even_head and isinstance(safe, np.ndarray) and field.lift is not None
                    and head is not None and head[-1] is not None):
                lift_safe = head_lift_clearance(head, safe)
                field.dy += field.lift * feather * contour_strength * (lift_safe - safe)
        if not field.valid(1):
            if policy["invalidGeometry"] == "fail":
                raise ValueError("Beauty deformation has invalid coordinates or excessive stretching.")
            # Broaden the protected portrait seam before scaling both
            # controls. The next attempt must pass the same validity check.
            if (components is not None and "faceSlim" in components and transition < 2
                    and any(np.any(pin) for pin in pins.values())):
                transition *= 1.5
                continue
            search_scale = components is None and (combined_portrait or contour_values.keys() == {"legLength"})
            strength *= portrait_backoff(field, eye_dx, eye_dy) if search_scale else .60
            reason = "geometry-constraint"
            continue
        x = field.x + field.dx
        y = field.y + field.dy
        moved = (np.abs(x - field.x) + np.abs(y - field.y) > .08) & ~protected
        if not np.any(moved & (person > 50)):
            if attempt < 6:
                continue
            break
        alpha = cv2.remap(original_alpha, x, y, cv2.INTER_LINEAR).clip(0, 1)
        alpha[protected] = 0
        # Whenever a moved soft edge exposes background at a formerly
        # occupied pixel, use a verified background estimate for the blend.
        # Reusing the original pixel would add the old edge underneath it.
        delta = moved & (original_alpha > .025) & (alpha < .975)
        plate, temporal, spatial, missing = reconstruct_background(
            original, delta, occupied, context_for_reconstruction,
            use_background_support=use_background_support, crop_to_gap=frame_edge is not None,
        )
        if background_context and np.any(missing):
            temporal += continue_context_background(original, plate, missing, occupied, background_context)
        if combined_portrait and separate_pins and background_context and np.any(missing):
            if registered is None:
                registered = register_background(original, occupied, background_context)
            temporal += continue_context_background(original, plate, missing, occupied, registered)
        if np.any(missing):
            if policy["unreliableReconstruction"] == "fail":
                raise ValueError("Newly revealed source background could not be reconstructed.")
            if components is not None:
                progressed = apply_shape_pins(original_alpha, missing, components, weights, pins, strength)
                if not progressed or attempt >= 6:
                    strength *= .78
                    reason = "background-reconstruction-unreliable"
            elif shape_names and attempt < 4:
                new_pins = combined_portrait and np.any(missing & ~blocked)
                blocked |= missing
                if not new_pins:
                    strength *= .85
            else:
                strength *= .60
                reason = "background-reconstruction-unreliable"
            continue
        result = composite_geometry(image, plate, original_alpha, alpha, delta, moved, x, y)
        if combined_portrait and head is not None and len(hair_references) >= 3:
            if registered is None and background_context:
                registered = register_background(original, occupied, background_context)
            result = transfer_portrait_hair_edges(
                image, result, original_alpha, alpha, parts, protected, head, moved, x, y,
                registered or hair_references, registered=bool(registered),
            )
            result = transfer_smooth_portrait_edges(image, result, person, protected, alpha, x, y, head)
        if pose is not None and context and shape_names & {"armLength", "legLength"}:
            result = transfer_limb_edges(image, result, person, pose, alpha, moved, x, y, context)
            if frame_edge is not None and shape_names == {"legLength"} and field.lift is not None:
                result = restore_vacated_limb_edges(result, original, person, alpha, pose, protected,
                                                   field.lift * contour_strength, context_for_reconstruction)
        if edge_reference is not None:
            region, verified, previous = edge_reference
            current = stationary_edge_error(image, result, (region, verified))
            if worsens_stationary_edges(previous, current):
                changed_edges = np.zeros(person.shape, bool)
                changed_edges[region][verified] = current > previous
                if not apply_shape_pins(original_alpha, changed_edges, components, weights, pins, strength,
                                        keep_background=True):
                    strength *= .78
                    reason = "partially-protected-contour"
                continue
        effective = {}
        for name, (value, detail) in diagnostics.items():
            if name == "eyeEnlarge" or not value:
                effective[name] = value, detail
            elif attempt == 6 and internal is not None and name in internal_names:
                effective[name] = value * .28, "interior-only-protection"
            else:
                used = contour_strength
                limitation = detail or reason
                if components is not None:
                    kept, pinned = retained_component_strength(components[name], weights[name], person)
                    used *= kept
                    if pinned:
                        limitation = limitation or "partially-protected-contour"
                elif isinstance(safe, np.ndarray):
                    if name in shape_names or (name == "faceSlim" and "headReduce" in values):
                        clearance = lift_safe if name == "legLength" and lift_safe is not None else safe
                        kept, pinned = retained_shape_strength(
                            name, contour_values[name], person, parts, face, pose, head, clearance, field.lift,
                        )
                        used *= kept
                    else:
                        pinned = True
                    if pinned:
                        limitation = limitation or "partially-protected-contour"
                effective[name] = value * used, limitation
        measurements = shape_measurements(field, original_alpha, head, face, pose, effective)
        unverified = {name for name in shape_names
                      if effective[name][0] and (name not in measurements or measurements[name][1] <= 0)}
        if unverified:
            if components is not None:
                return image, effective, {}
            if policy["invalidGeometry"] == "fail":
                raise ValueError("The accepted warp did not move the requested shape in the intended direction.")
            # Rebuild without the unverified effect so the report and pixels
            # agree, including when more than one shape control is active.
            remaining = {name: value for name, value in values.items() if name not in unverified}
            result, effective, metrics = remap_geometry(
                image, original, person, parts, face, pose, protected, context, remaining, policy, head_neighbors,
                even_head=even_head, frame_edge=frame_edge,
            )
            effective.update({name: (0, "requested-shape-change-unmeasurable") for name in sorted(unverified)})
            return result, effective, metrics
        metrics = {"temporalPixels": temporal, "spatialPixels": spatial, "measurements": measurements}
        if temporal or spatial:
            metrics["reconstructionBox"] = list(cv2.boundingRect(delta.astype(np.uint8)))
        return result, effective, metrics
    return image, {
        name: (0, detail or reason or "geometry-constraint") for name, (_, detail) in diagnostics.items()
    }, {}
