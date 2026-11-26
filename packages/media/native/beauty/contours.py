"""Foreground matte refinement and transfer of soft moving edges."""

import warnings

import cv2
import numpy as np

from controls import (
    ramp,
    unit,
)
from deformation import (
    pose_head_contour,
)
from background import (
    corroborated_background,
    matching_background,
    verified_background_area,
)


def limb_tips(person, pose):
    """Locate observed foreground near reliable wrists, hands, ankles and feet."""
    support = np.zeros(person.shape, np.uint8)
    if pose is None:
        return support
    for joint, previous, tips in ((15, 13, (17, 19, 21)), (16, 14, (18, 20, 22)),
                                  (27, 25, (29, 31)), (28, 26, (30, 32))):
        if min(pose[joint, 2], pose[previous, 2]) < .55:
            continue
        length = np.linalg.norm(pose[joint, :2] - pose[previous, :2])
        radius = max(3, round(length * .20))
        for index in (joint, *tips):
            if pose[index, 2] >= .55:
                cv2.circle(support, tuple(np.rint(pose[index, :2]).astype(int)), radius, 1, -1)
    return support


def guided_contour(image, alpha, tile=640):
    radius = 3
    if alpha.size <= tile * tile:
        return cv2.ximgproc.guidedFilter(image.astype(np.float32) / 255, alpha, radius, .0016)
    # The two box-filter passes together depend only on a 2-radius halo.
    halo = 2 * radius + 1
    height, width = alpha.shape
    result = np.empty_like(alpha)
    for top in range(0, height, tile):
        for left in range(0, width, tile):
            bottom, right = min(height, top + tile), min(width, left + tile)
            y, x = max(0, top - halo), max(0, left - halo)
            patch = np.s_[y:min(height, bottom + halo), x:min(width, right + halo)]
            output = cv2.ximgproc.guidedFilter(image[patch].astype(np.float32) / 255, alpha[patch], radius, .0016)
            result[top:bottom, left:right] = output[top-y:bottom-y, left-x:right-x]
    return result


def refine_contour(image, person, protected, pose=None, known_background=None):
    """Use the detected silhouette as a trimap for a bounded RGB edge fit."""
    matte = cv2.morphologyEx(person, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    support = cv2.findNonZero((matte >= 128).astype(np.uint8))
    if support is None:
        return np.zeros(person.shape, np.float32)
    h, w = person.shape
    x, y, width, height = cv2.boundingRect(support)
    margin = max(12, min(28, round(min(h, w) * .035)))
    left, top, right, bottom = max(0, x-margin), max(0, y-margin), min(w, x+width+margin), min(h, y+height+margin)
    crop = image[top:bottom, left:right]
    prior = matte[top:bottom, left:right]
    scale = min(1, 620 / max(prior.shape))
    size = (round(prior.shape[1] * scale), round(prior.shape[0] * scale))
    rgb = cv2.resize(crop, size, interpolation=cv2.INTER_AREA)
    sampled = cv2.resize(prior, size, interpolation=cv2.INTER_LINEAR)
    outer = cv2.distanceTransform((sampled < 128).astype(np.uint8), cv2.DIST_L2, 5)
    core = cv2.distanceTransform((sampled >= 128).astype(np.uint8), cv2.DIST_L2, 5)
    labels = np.where(sampled >= 128, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
    labels[outer > max(5, margin * scale * .64)] = cv2.GC_BGD
    labels[(core > max(4, margin * scale * .45)) & (sampled > 225)] = cv2.GC_FGD
    # These thin structures can lack a deep trimap interior. Keep the
    # independently observed mask core at the joints rather than allowing the
    # color model to remove a hand or foot that differs from the torso.
    if pose is not None:
        tips = limb_tips(person, pose)[top:bottom, left:right]
        at_tip = cv2.resize(tips, size, interpolation=cv2.INTER_NEAREST) != 0
        labels[at_tip & (core >= 2) & (sampled > 225)] = cv2.GC_FGD
    if known_background is not None:
        known_region, clear = known_background
        background = np.zeros_like(person)
        background[known_region] = clear
        known = cv2.resize(background[top:bottom, left:right], size, interpolation=cv2.INTER_AREA)
        labels[known == 1] = cv2.GC_BGD
    original = prior.astype(np.float32) / 255
    if np.count_nonzero(labels == cv2.GC_FGD) >= 30 and np.count_nonzero(labels == cv2.GC_BGD) >= 30:
        cv2.setRNGSeed(17)
        cv2.grabCut(rgb, labels, None, np.zeros((1,65), np.float64), np.zeros((1,65), np.float64), 1, cv2.GC_INIT_WITH_MASK)
        fit = cv2.resize((labels % 2).astype(np.float32), (prior.shape[1], prior.shape[0]), interpolation=cv2.INTER_LINEAR)
        # Keep model evidence on the edge and preserve the high-confidence
        # trimap interiors. The color fit resolves where the edge actually lies.
        original = .85 * cv2.GaussianBlur(fit, (0,0), .78) + .15 * original
    soft = guided_contour(crop, original)
    fit = ramp((soft - .15) / .70)
    if pose is not None:
        interior = cv2.distanceTransform(tips, cv2.DIST_L2, 3)
        support = ramp(interior / 3) * (prior.astype(np.float32) / 255) ** 2
        np.maximum(fit, support, out=fit)
    alpha = np.zeros(person.shape, np.float32)
    alpha[top:bottom, left:right] = fit
    if known_background is not None:
        alpha[known_region][clear] = 0
    alpha[protected] = 0
    return alpha


def clear_false_accessories(image, person, parts, protected, context):
    """Remove accessory labels when two source frames show the same background."""
    candidates = (parts == 5) & (person > 26) & ~protected
    if len(context) < 2 or not np.any(candidates) or person.size > 2_000_000:
        return person, parts
    collar = cv2.dilate((person > 26).astype(np.uint8), np.ones((7, 7), np.uint8)) == 0
    collar &= ~protected
    votes = np.zeros(person.shape, np.uint8)
    for rgb, occupied in context:
        clear = cv2.dilate(occupied.astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
        usable = candidates & clear
        if not np.any(usable):
            continue
        matching = np.zeros(person.shape, bool)
        matching[usable] = np.abs(image[usable].astype(np.int16) - rgb[usable]).max(axis=1) <= 4
        votes += verified_background_area(image, rgb, matching, collar & clear)
    proven = votes >= 2
    if not np.any(proven):
        return person, parts
    silhouette, labels = person.copy(), parts.copy()
    silhouette[proven] = 0
    labels[proven] = 0
    return silhouette, labels


def context_wrist_background(image, person, protected, references, region):
    samples = np.stack([image[region] for image, _ in references]).astype(np.float32)
    unobstructed = np.stack([
        cv2.dilate(occupied[region].astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
        for _, occupied in references
    ])
    samples[~unobstructed] = np.nan
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="All-NaN slice encountered", category=RuntimeWarning)
        median = np.nanmedian(samples, axis=0)
    agreeing = np.count_nonzero(np.max(np.abs(samples - median), axis=3) <= 4, axis=0) >= 3
    background = np.nan_to_num(median).round().astype(np.uint8)
    collar = cv2.dilate((person[region] > 26).astype(np.uint8), np.ones((7, 7), np.uint8)) == 0
    verified = verified_background_area(
        image[region], background, agreeing & ~protected[region], collar & agreeing,
        search=65, minimum=35,
    )
    return background, verified


def context_skin_opacity(image, backdrop, skin_seed):
    origin_delta = image.astype(np.float32) - backdrop
    swatches = np.quantile(image[skin_seed], (.1, .5, .9), axis=0)
    opacity = np.zeros(skin_seed.shape, np.float32)
    for swatch in swatches:
        contrast = swatch.astype(np.float32) - backdrop
        covered = (origin_delta * contrast).sum(axis=2) / np.maximum(np.square(contrast).sum(axis=2), 1)
        covered = covered.clip(0, 1)
        residual = np.max(np.abs(origin_delta - covered[..., None] * contrast), axis=2)
        supported = (residual <= 13) & (np.max(np.abs(contrast), axis=2) >= 21)
        np.maximum(opacity, covered * supported, out=opacity)
    return opacity


def temporal_arm_skin(image, person, parts, pose, protected, observations):
    """Resolve an unknown arm label only when both surrounding poses agree."""
    labels = parts.copy()
    rows, cols = np.nonzero((parts == 5) & (person >= 150) & ~protected)
    if pose is None or not len(rows):
        return labels
    pixels = np.column_stack((cols, rows))
    h, w = person.shape
    for start, end in ((11, 13), (13, 15), (12, 14), (14, 16)):
        chain = [start, end]
        first, final = pose[chain, :2]
        length = float(np.linalg.norm(final - first))
        if length < 8 or np.any(pose[chain, 2] < .8):
            continue
        along = (final - first) / length
        normal = np.array([-along[1], along[0]])
        axial = (pixels - first) @ along
        lateral = (pixels - first) @ normal
        inside = (axial >= 0) & (axial <= length) & (np.abs(lateral) <= max(4, .23 * length))
        if not np.any(inside):
            continue
        yy, xx = rows[inside], cols[inside]
        color = image[yy, xx].astype(np.int16)
        agreement = np.zeros((2, len(yy)), bool)
        for preceding, reference, mask, semantic, other in observations:
            if other is None or np.any(other[chain, 2] < .8):
                continue
            origin, finish = other[chain, :2]
            axis = (finish - origin) / length
            if not .70 <= np.linalg.norm(axis) <= 1.43 or np.dot(along, axis) < .38:
                continue
            side = np.array([-axis[1], axis[0]])
            coord = origin + axial[inside, None] * axis + lateral[inside, None] * side
            rx, ry = np.rint(coord).astype(int).T
            valid = (rx >= 0) & (rx < w) & (ry >= 0) & (ry < h)
            retained = np.flatnonzero(valid)
            rx, ry = rx[valid], ry[valid]
            delta = color[retained] - reference[ry, rx].astype(np.int16)
            same_skin = (np.abs(delta).max(axis=1) <= 26) & (np.ptp(delta, axis=1) <= 13)
            observed = (mask[ry, rx] >= 180) & (semantic[ry, rx] == 2) & same_skin
            agreement[int(preceding), retained] |= observed
        confirmed = agreement.all(axis=0)
        labels[yy[confirmed], xx[confirmed]] = 2
    return labels


def refine_context_hands(image, person, parts, pose, protected, references):
    """Confirm a blurred hand by its attachment, color, and independent backdrop."""
    if pose is None:
        return person, parts
    silhouette, semantic = person.copy(), parts.copy()
    height, width = person.shape
    for indices in ((11, 13, 15), (12, 14, 16)):
        joints = pose[list(indices)]
        if np.any(joints[:, 2] < .80):
            continue
        elbow, wrist = joints[1:, :2]
        length = float(np.linalg.norm(wrist - elbow))
        if length < 8:
            continue
        x, y = np.rint(wrist).astype(int)
        if not (0 <= x < width and 0 <= y < height):
            continue
        radius = max(6, round(.55 * length))
        top, left = max(0, y - radius), max(0, x - radius)
        region = np.s_[top:min(height, y + radius + 1), left:min(width, x + radius + 1)]
        labels = semantic[region]
        if not np.any(labels == 5):
            continue
        backdrop, usable = context_wrist_background(image, person, protected, references, region)
        origin_delta = image[region].astype(np.float32) - backdrop
        direction = unit(wrist - elbow)
        rows, cols = np.indices(usable.shape, dtype=np.float32)
        cols += left - wrist[0]
        rows += top - wrist[1]
        axial = cols * direction[0] + rows * direction[1]
        lateral = np.abs(rows * direction[0] - cols * direction[1])
        usable &= lateral <= max(4., .22 * length)
        prior = silhouette[region]
        clear = usable & (np.max(np.abs(origin_delta), axis=2) <= 4)
        prior[clear], labels[clear] = 0, 0
        skin_seed = (labels == 2) & (prior >= 180) & (axial <= -.18 * length) & (axial >= -.60 * length)
        skin_seed &= lateral <= max(3., .13 * length)
        if np.count_nonzero(skin_seed) < 8:
            continue
        opacity = context_skin_opacity(image[region], backdrop, skin_seed)
        hand = usable & (axial >= -.32 * length) & (axial <= .48 * length) & (opacity >= .47)
        _, components = cv2.connectedComponents(hand.astype(np.uint8))
        forearm = (axial <= -.15 * length) & (prior >= 140) & (labels == 2)
        attachment = np.unique(components[forearm & (components > 0)])
        hand &= np.isin(components, attachment)
        labels[hand] = 2
        prior[hand] = np.maximum(prior[hand], np.rint(opacity[hand] * 255).astype(np.uint8))
    return silhouette, semantic


def observed_head_background(image, person, pose, face, protected, context):
    """Keep stable wall details out of the moving head matte."""
    if len(context) < 2:
        return None
    if pose is not None and pose[0, 2] >= .80:
        center = pose[0, :2]
        span = np.linalg.norm(pose[11, :2] - pose[12, :2])
    elif face is not None:
        center = face[1]
        span = np.linalg.norm(face[454] - face[234]) * 1.6
    else:
        return None
    radius = max(12, round(span * .95))
    x, y = np.rint(center).astype(int)
    height, width = person.shape
    if not (0 <= x < width and 0 <= y < height):
        return None
    region = np.s_[max(0, y-radius):min(height, y+radius+1),
                   max(0, x-radius):min(width, x+radius+1)]
    current = image[region]
    collar = cv2.dilate((person[region] > 26).astype(np.uint8), np.ones((7, 7), np.uint8)) == 0
    collar &= ~protected[region]
    votes = np.zeros(collar.shape, np.uint8)
    current_rgb = current.astype(np.int16)
    for rgb, occupancy in context:
        reference = rgb[region]
        clear = cv2.dilate(occupancy[region].astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
        if matching_background(current, reference, collar & clear):
            error = np.abs(current_rgb - reference).max(axis=2)
            votes += clear & (error <= 4)
    observed = (votes >= 2) & ~protected[region]
    return (region, observed) if np.any(observed) else None


def infer_head_contour(image, person, pose, protected, neighbors):
    """Use nearby masks to seed a new, image-checked head segmentation."""
    if pose is None or pose[0, 2] < .80 or len(neighbors) < 2:
        return None
    height, width = person.shape
    nose = pose[0, :2]
    span = np.linalg.norm(pose[11, :2] - pose[12, :2])
    radius = round(span * .80)
    x, y = np.rint(nose).astype(int)
    if radius < 8 or not (0 <= x < width and 0 <= y < height):
        return None
    left, top = max(0, x - radius), max(0, y - radius)
    right, bottom = min(width, x + radius + 1), min(height, y + radius + 1)
    region = np.s_[top:bottom, left:right]
    dim = (right - left, bottom - top)
    aligned = []
    for mask, origin, anchor, old_span, to_source in neighbors:
        scale = span / old_span
        # The saved guide may use a smaller raster than the rendered source.
        if not .80 <= scale / to_source <= 1.24:
            continue
        offset = nose + (origin - anchor) * scale - [left, top]
        transform = np.float32([[scale, 0, offset[0]], [0, scale, offset[1]]])
        aligned.append(cv2.warpAffine(mask, transform, dim, flags=cv2.INTER_NEAREST) != 0)
    if len(aligned) < 2:
        return None
    votes = np.count_nonzero(aligned, axis=0)
    common = (votes >= 2).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    envelope = cv2.dilate((votes > 0).astype(np.uint8), kernel) > 0
    marked = person[region]
    forbidden = protected[region]
    foreground = (cv2.erode(common, np.ones((5, 5), np.uint8)) != 0) & (marked > 175) & ~forbidden
    if np.count_nonzero(foreground) < 40 or np.count_nonzero(~envelope) < 40:
        return None
    labels = np.where(envelope, cv2.GC_PR_BGD, cv2.GC_BGD).astype(np.uint8)
    labels[common != 0] = cv2.GC_PR_FGD
    labels[foreground] = cv2.GC_FGD
    labels[forbidden] = cv2.GC_BGD
    crop = np.ascontiguousarray(image[region])
    cv2.setRNGSeed(17)
    cv2.grabCut(crop, labels, None, np.zeros((1, 65)), np.zeros((1, 65)), 2, cv2.GC_INIT_WITH_MASK)
    observed = (labels % 2 != 0) & (marked > 150)
    agreement = np.count_nonzero(observed & (common != 0)) / max(1, np.count_nonzero(observed | (common != 0)))
    if agreement < .62:
        return None
    boundary = cv2.morphologyEx(observed.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    gradient = np.abs(cv2.Sobel(gray, cv2.CV_16S, 1, 0)) + np.abs(cv2.Sobel(gray, cv2.CV_16S, 0, 1))
    if not np.any(boundary) or np.percentile(gradient[boundary], 40) < 24:
        return None
    silhouette = np.zeros_like(person)
    silhouette[region] = observed * 255
    return pose_head_contour(silhouette, pose)


def transfer_limb_edges(image, result, person, pose, alpha, moved, x, y, context):
    """Transfer observed motion blur where source and destination backing agree."""
    tips = limb_tips(person, pose)
    if not np.any(tips & moved):
        return result
    radius = max(4, min(14, round(min(person.shape) * .014)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    tips = cv2.dilate(tips, kernel)
    left, top, wide, high = cv2.boundingRect(tips)
    margin = radius + 12
    h, w = person.shape
    left, top, right, bottom = max(0, left-margin), max(0, top-margin), min(w, left+wide+margin), min(h, top+high+margin)
    if (right - left) * (bottom - top) > 1_000_000:
        return result
    region = np.s_[top:bottom, left:right]
    tip = tips[region]
    candidate = (tip != 0) & moved[region]
    if not np.any(candidate):
        return result
    current = image[region]
    map_x, map_y = x[region] - left, y[region] - top
    sampled = cv2.remap(current, map_x, map_y, cv2.INTER_LINEAR).astype(np.float32)
    local = cv2.dilate(candidate.astype(np.uint8), np.ones((19, 19), np.uint8)) != 0
    local &= cv2.dilate((person[region] > 26).astype(np.uint8), np.ones((9, 9), np.uint8)) == 0
    tip_weight = ramp(cv2.distanceTransform(tip, cv2.DIST_L2, 3) / 4)
    patch = result[region].copy()
    applied = False
    for rgb, occupancy in context:
        reference = rgb[region]
        clear = cv2.dilate(occupancy[region].astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
        if not matching_background(current, reference, local & clear):
            continue
        mapped_clear = cv2.remap(clear.astype(np.float32), map_x, map_y, cv2.INTER_LINEAR) > .999
        target = candidate & clear & mapped_clear
        if not np.any(target):
            continue
        mapped_background = cv2.remap(reference, map_x, map_y, cv2.INTER_LINEAR).astype(np.float32)
        background_change = reference.astype(np.float32) - mapped_background
        changed = ((np.abs(current.astype(np.int16) - reference).max(axis=2) > 7)
                   | (np.abs(sampled - mapped_background).max(axis=2) > 7))
        target &= changed & (np.abs(background_change).max(axis=2) <= 12)
        if not np.any(target):
            continue
        weight = (tip_weight * ramp(cv2.distanceTransform(target.astype(np.uint8), cv2.DIST_L2, 3) / 2))[target, None]
        transferred = sampled[target] + (1 - alpha[region][target, None]) * background_change[target]
        patch[target] = np.rint(patch[target] * (1 - weight) + transferred * weight).clip(0, 255).astype(np.uint8)
        candidate &= ~target
        applied = True
        if not np.any(candidate):
            break
    if not applied:
        return result
    edited = result.copy()
    edited[region] = patch
    return edited


def restore_vacated_limb_edges(result, image, person, alpha, pose, protected, lift, references):
    """Recover source fringes left behind a lifted limb on a confirmed smooth backdrop."""
    h, w = person.shape
    restored = result
    for chain in ((11, 13, 15, 17, 19, 21), (12, 14, 16, 18, 20, 22),
                  (23, 25, 27), (24, 26, 28)):
        upper, middle, lower = chain[:3]
        if min(pose[middle, 2], pose[lower, 2]) < .65:
            continue
        joints = np.rint([pose[i, :2] for i in chain if pose[i, 2] >= .65]).astype(int)
        proximal = np.linalg.norm(pose[upper, :2] - pose[middle, :2]) if pose[upper, 2] >= .65 else 0.
        distal = np.linalg.norm(pose[middle, :2] - pose[lower, :2])
        radius = max(8, round(.55 * max(proximal, distal)))
        left, top = np.maximum(0, joints.min(axis=0) - radius)
        right, bottom = np.minimum((w, h), joints.max(axis=0) + radius + 1)
        if right <= left or bottom <= top:
            continue
        region = np.s_[top:bottom, left:right]
        inside = person[region] > 100
        near = cv2.distanceTransform((~inside).astype(np.uint8), cv2.DIST_L2, 3) <= radius * .65
        row, col = np.indices(inside.shape, dtype=np.float32)
        source_y = row + lift[region]
        src = cv2.remap(image[region], col, source_y, cv2.INTER_LINEAR)
        source_clear = cv2.remap(person[region], col, source_y, cv2.INTER_LINEAR) < 100
        source_clear &= cv2.remap(protected[region].astype(np.float32), col, source_y, cv2.INTER_LINEAR) == 0
        allowed = near & (alpha[region] < .12) & source_clear & ~protected[region] & (source_y < inside.shape[0]-1)
        if not np.any(allowed):
            continue
        backing = np.zeros_like(src)
        seen = np.zeros_like(allowed)
        agreed = np.zeros_like(allowed)
        for rgb, mask in references:
            ref = rgb[region].astype(np.int16)
            clear = cv2.dilate(mask[region].astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
            mapped = cv2.remap(ref, col, source_y, cv2.INTER_LINEAR)
            smooth = np.abs(mapped - ref).max(axis=2) <= 4
            valid = (allowed & ~agreed & clear & smooth
                     & (np.abs(mapped - src).max(axis=2) <= 5)
                     & (cv2.remap(clear.astype(np.float32), col, source_y, cv2.INTER_LINEAR) > .999))
            corroborated = valid & seen & (np.abs(ref-backing).max(axis=2) <= 4)
            agreed |= corroborated & (np.abs(ref - result[region]).max(axis=2) > 5)
            backing[valid] = rgb[region][valid]
            seen |= valid
        if np.any(agreed):
            if restored is result:
                restored = result.copy()
            restored[region][agreed] = backing[agreed]
    return restored


def transfer_smooth_portrait_edges(image, result, person, protected, alpha, x, y, head):
    """Move the optical edge intact when the visible backdrop is locally uniform."""
    neck, across, reach_x, reach_y = head[:4]
    down = np.array([-across[1], across[0]])
    corners = np.array([neck + across * side * reach_x + down * level * reach_y
                        for side in (-1.2, 1.2) for level in (-1.2, .15)])
    h, w = person.shape
    left, top = np.maximum(0, np.floor(corners.min(axis=0)).astype(int) - 20)
    right, bottom = np.minimum((w, h), np.ceil(corners.max(axis=0)).astype(int) + 21)
    if left >= right or top >= bottom:
        return result
    region = np.s_[top:bottom, left:right]
    mask = person[region]
    clear = cv2.erode(((mask < 8) & ~protected[region]).astype(np.uint8), np.ones((13, 13), np.uint8))
    rgb = image[region].astype(np.float32)
    # Compare the first two color moments over an observed collar. Reject
    # bricks, clothing edges and shadows whose local color varies appreciably.
    size = (41, 41)
    count = cv2.boxFilter(clear.astype(np.float32), -1, size, normalize=False)
    weights = clear[..., None].astype(np.float32)
    mean = cv2.boxFilter(rgb * weights, -1, size, normalize=False) / np.maximum(1, count[..., None])
    second = cv2.boxFilter(rgb * rgb * weights, -1, size, normalize=False) / np.maximum(1, count[..., None])
    smooth = (count >= 64) & (np.max(second - mean * mean, axis=2) <= 9)
    mx, my = x[region] - int(left), y[region] - int(top)
    source_ok = cv2.remap((smooth & ~protected[region]).astype(np.float32), mx, my, cv2.INTER_LINEAR) > .999
    source_back = cv2.remap(mean, mx, my, cv2.INTER_LINEAR)
    shift = mean - source_back
    valid = smooth & source_ok & (np.max(np.abs(shift), axis=2) <= 5) & ~protected[region]
    near = cv2.distanceTransform((mask < 70).astype(np.uint8), cv2.DIST_L2, 3) <= 10
    valid &= near & ((mask < 230) | (alpha[region] < .9))
    if not np.any(valid):
        return result
    sample = cv2.remap(rgb, mx, my, cv2.INTER_LINEAR)
    moved = sample + shift * (1-alpha[region][..., None])
    edit = valid & (np.maximum(np.max(np.abs(rgb - mean), axis=2),
                               np.max(np.abs(sample - source_back), axis=2)) > 6)
    out = result.copy()
    out[region][edit] = np.rint(moved[edit]).clip(0, 255).astype(np.uint8)
    return out


def transfer_portrait_hair_edges(image, result, original_alpha, alpha, parts, protected, head, moved, x, y, references,
                                *, registered=False):
    """Move a fine hair edge only where both positions have a verified backdrop."""
    neck, across, reach_x, reach_y, *_ = head
    down = np.array([-across[1], across[0]])
    corners = np.array([neck + across * side * reach_x + down * v * reach_y
                        for side in (-1, 1) for v in (-1.15, -.05)])
    height, width = moved.shape
    left, top = map(int, np.maximum(0, np.floor(corners.min(axis=0)) - 8))
    right, bottom = map(int, np.minimum((width, height), np.ceil(corners.max(axis=0)) + 9))
    region = np.s_[top:bottom, left:right]
    opacity = original_alpha[region]
    hair_core = (parts[region] == 1) & (opacity >= .88)
    if (bottom - top) * (right - left) > 180_000 or not np.any(hair_core):
        return result
    seeds = cv2.distanceTransform(hair_core.astype(np.uint8), cv2.DIST_L2, 3) > 2
    if not np.any(seeds):
        return result
    distance = cv2.distanceTransform((~seeds).astype(np.uint8), cv2.DIST_L2, 5)
    forbidden = protected[region]
    fringe = (distance > 0) & (distance <= (20 if registered else 12)) & (opacity < .88) & ~forbidden
    if registered:
        fringe = (distance <= 20) & (np.minimum(opacity, alpha[region]) < .98) & ~forbidden
    known = (distance > (20 if registered else 13)) & (opacity < .015) & ~forbidden
    if not np.any(fringe & moved[region]) or np.count_nonzero(known) < 20:
        return result
    neighborhood = cv2.dilate(fringe.astype(np.uint8), np.ones((31, 31), np.uint8)) != 0
    witnesses = [(rgb[region], occupied[region]) for rgb, occupied in references]
    backdrop, verified = corroborated_background(
        image[region], neighborhood, known, witnesses, search=65, minimum=20, include_collar=registered,
    )
    verified &= ~forbidden
    map_x, map_y = x[region] - left, y[region] - top
    source_verified = cv2.remap(verified.astype(np.float32), map_x, map_y, cv2.INTER_LINEAR) > .99
    covered = moved[region] & fringe & verified & source_verified
    if not np.any(covered):
        return result
    scene = backdrop.astype(np.float32)
    pixels = image[region].astype(np.float32)
    source_background = cv2.remap(scene, map_x, map_y, cv2.INTER_LINEAR)
    source_pixels = cv2.remap(pixels, map_x, map_y, cv2.INTER_LINEAR)
    background_difference = scene - source_background
    original_contrast = np.max(np.abs(pixels - scene), axis=2)
    moved_contrast = np.max(np.abs(source_pixels - source_background), axis=2)
    covered &= np.maximum(original_contrast, moved_contrast) > 6
    if not registered:
        covered &= np.max(np.abs(background_difference), axis=2) <= 10
    if not np.any(covered):
        return result
    weight = (1 - ramp((np.maximum(opacity, alpha[region]) - .28) / .56))[covered, None]
    transmission = (1 - alpha[region][..., None]) if registered else 1.
    if registered:
        weight = (1 - ramp((np.minimum(opacity, alpha[region]) - .80) / .18))[covered, None]
    transferred = (source_pixels + transmission * background_difference)[covered]
    patch = result[region].copy()
    patch[covered] = np.rint(patch[covered] * (1 - weight) + transferred * weight).clip(0, 255).astype(np.uint8)
    corrected = result.copy()
    corrected[region] = patch
    return corrected
