"""Observed and spatially verified background reconstruction."""

import cv2
import numpy as np


def align_background(image, occupied, other_image, other_occupied):
    """Estimate a translation using only tracked background features."""
    available = ~(occupied | other_occupied)
    h, w = image.shape
    scale = np.ones(2, np.float32)
    if max(h, w) > 1280:
        divisor = max(h, w) / 1280
        size = (round(w / divisor), round(h / divisor))
        scale = np.array([w / size[0], h / size[1]], np.float32)
        image = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
        other_image = cv2.resize(other_image, size, interpolation=cv2.INTER_AREA)
        available = cv2.resize(available.astype(np.uint8) * 255, size, interpolation=cv2.INTER_AREA) == 255
    points = cv2.goodFeaturesToTrack(image, 80, .035, 6, mask=available.astype(np.uint8))
    if points is None:
        return None
    tracked, valid, _ = cv2.calcOpticalFlowPyrLK(image, other_image, points, None)
    if valid is None or np.count_nonzero(valid) < 6:
        return None
    deltas = (points - tracked)[valid.astype(bool)] * scale
    x, y = np.median(deltas, axis=0)
    if (not np.isfinite([x, y]).all() or abs(x) > .04 * w or abs(y) > .04 * h
            or np.percentile(np.linalg.norm(deltas - [x, y], axis=1), 75) > 1.4):
        return None
    return np.float32([[1, 0, x], [0, 1, y]])


def reject_patch_joins(recovered, resolved, tiles, step):
    # Independently fitted surfaces must agree where tiles meet.
    for row in np.unique(tiles[:, 0]) * step:
        if row > 0:
            difference = np.abs(recovered[row].astype(np.int16) - recovered[row - 1]).max(axis=1)
            seam = resolved[row] & resolved[row - 1] & (difference > 6)
            resolved[row] &= ~seam
            resolved[row - 1] &= ~seam
    for col in np.unique(tiles[:, 1]) * step:
        if col > 0:
            difference = np.abs(recovered[:, col].astype(np.int16) - recovered[:, col - 1]).max(axis=1)
            seam = resolved[:, col] & resolved[:, col - 1] & (difference > 6)
            resolved[:, col] &= ~seam
            resolved[:, col - 1] &= ~seam


def smooth_background_patch(image, missing, known, gradients, distance):
    """Fit and verify a low-frequency RGB surface around each exposed gap."""
    h, w = missing.shape
    step = 10
    search = 28
    y, x = np.nonzero(missing)
    tiles = np.unique(np.stack([y // step, x // step], axis=1), axis=0)
    recovered = image.copy()
    resolved = np.zeros(missing.shape, bool)
    for row, col in tiles:
        y0, x0 = row * step, col * step
        yd, xd = np.nonzero(missing[y0:y0 + step, x0:x0 + step])
        yd, xd = y0 + yd, x0 + xd
        if distance[yd, xd].max() > min(16, max(8, h * .045)):
            continue
        top, left = max(0, y0 - search), max(0, x0 - search)
        bottom, right = min(h, y0 + step + search), min(w, x0 + step + search)
        gap = np.ones((bottom - top, right - left), np.uint8)
        gap[yd - top, xd - left] = 0
        to_gap = cv2.distanceTransform(gap, cv2.DIST_L2, 5)
        observed = known[top:bottom, left:right] & (to_gap <= search)
        ya, xa = np.nonzero(observed)
        proximity = to_gap[ya, xa]
        ya, xa = ya + top, xa + left
        near = proximity <= 22
        if (len(ya) < 80 or np.count_nonzero(near) < 18
                or float(np.mean(gradients[ya[near], xa[near]])) > .025):
            continue
        # Use alternating samples for the fit and for its local validation.
        sample = np.arange(0, len(ya), max(2, len(ya) // 512))
        near[sample] = False
        if np.count_nonzero(near) < 9:
            continue
        design = surface_basis(xa - x0, ya - y0, search)
        query = surface_basis(xd - x0, yd - y0, search)
        observed_rgb = image[ya, xa]
        weight = np.exp(-(proximity[sample] / 22) ** 2)[:, None]
        prediction = None
        for columns in (3, 6):
            fitted = design[sample, :columns] * weight
            if np.linalg.cond(fitted) > 48:
                continue
            coefficients = np.linalg.lstsq(fitted, observed_rgb[sample] * weight, rcond=None)[0]
            error = np.max(np.abs(design[near, :columns] @ coefficients - observed_rgb[near]), axis=1)
            if np.percentile(error, 90) > 4 or np.max(np.abs(coefficients[1:])) > 36:
                continue
            estimate = query[:, :columns] @ coefficients
            local_samples = observed_rgb[near]
            lower = np.maximum(0, local_samples.min(axis=0).astype(np.float32) - 4)
            upper = np.minimum(255, local_samples.max(axis=0).astype(np.float32) + 4)
            if np.any(estimate < lower) or np.any(estimate > upper):
                continue
            prediction = estimate
            break
        if prediction is None:
            continue
        recovered[yd, xd] = np.rint(prediction).clip(0, 255).astype(np.uint8)
        resolved[yd, xd] = True
    reject_patch_joins(recovered, resolved, tiles, step)
    return recovered, resolved


def surface_basis(x, y, scale):
    x, y = x / scale, y / scale
    return np.column_stack((np.ones(len(x)), x, y, x * y, x ** 2, y ** 2))


def extend_background_edges(image, missing, known, distance, labels):
    """Continue a smooth background a short distance across a revealed edge."""
    recovered = np.zeros_like(image)
    resolved = np.zeros_like(missing)
    reach = max(5, min(9, image.shape[0] * .018))
    y, x = np.nonzero(missing & (distance <= reach))
    if not len(x):
        return recovered, resolved

    yy, xx = np.nonzero(known)
    anchors = np.zeros((int(labels.max()) + 1, 2), np.float32)
    anchors[labels[yy, xx]] = np.column_stack((xx, yy))
    point = np.column_stack((x, y)).astype(np.float32)
    start = anchors[labels[y, x]]
    offset = start - point
    length = np.linalg.norm(offset, axis=1)
    outward = offset / length[:, None]
    tangent = outward[:, ::-1] * [-1, 1]

    # An outward strip should predict withheld samples on the same line and
    # both sides of it. This rejects textured or crossing background edges.
    columns = np.array([1, 2, 3, 4, 5, 6], np.float32)
    known_pixels = known.astype(np.float32)
    # Keep coordinate arrays below OpenCV's signed 16-bit remapping limit.
    for first in range(0, len(x), 8_192):
        batch = slice(first, first + 8_192)
        ray = start[batch, None, :] + outward[batch, None, :] * columns[None, :, None]
        side = tangent[batch, None]
        samples = np.concatenate((ray, ray[:, 2:4] + side, ray[:, 2:4] - side), axis=1)
        px, py = (component.astype(np.float32) for component in samples.transpose(2, 0, 1))
        visible = cv2.remap(known_pixels, px, py, cv2.INTER_LINEAR)
        rgb = cv2.remap(image, px, py, cv2.INTER_LINEAR).astype(np.float32)
        slope = (rgb[:, 5] - rgb[:, 0]) / 5
        near = rgb[:, 0]
        expected = near[:, None] + slope[:, None] * np.array([1, 2, 3, 4, 2, 3, 2, 3])[None, :, None]
        measured = rgb[:, (1, 2, 3, 4, 6, 7, 8, 9)]
        prediction = near - slope * (length[batch, None] + 1)
        accepted = ((visible >= .999).all(axis=1)
                    & (np.abs(expected - measured).max(axis=(1, 2)) <= 4)
                    & (np.abs(prediction - near).max(axis=1) <= 10))
        rows, cols = y[batch][accepted], x[batch][accepted]
        recovered[rows, cols] = np.rint(prediction[accepted]).clip(0, 255).astype(np.uint8)
        resolved[rows, cols] = True
    return recovered, resolved


def continue_background_texture(image, missing, known, distance):
    """Use short-range texture continuation only when an observed collar is predictable."""
    h, w = missing.shape
    missing = missing & (distance <= max(4.3, min(7.0, h * .012)))
    step = 12
    y, x = np.nonzero(missing)
    tiles = np.unique(np.stack([y // step, x // step], axis=1), axis=0)
    recovered = image.copy()
    resolved = np.zeros(missing.shape, bool)
    for row, col in tiles:
        y0, x0 = row * step, col * step
        top, left = max(0, y0 - 12), max(0, x0 - 12)
        bottom, right = min(h, y0 + step + 12), min(w, x0 + step + 12)
        patch = image[top:bottom, left:right]
        clean = known[top:bottom, left:right]
        target = np.zeros(clean.shape, np.uint8)
        yd, xd = np.nonzero(missing[y0:y0+step, x0:x0+step])
        target[y0-top+yd, x0-left+xd] = 1
        band = cv2.dilate(target, np.ones((15, 15), np.uint8)).astype(bool)
        collar = clean & band & (cv2.distanceTransform(clean.astype(np.uint8), cv2.DIST_L2, 3) <= 1.5)
        if np.count_nonzero(collar) < 8 or np.count_nonzero(clean & ~collar) < 24:
            continue
        check = cv2.inpaint(patch, (~clean | collar).astype(np.uint8), 3, cv2.INPAINT_NS)
        error = np.max(np.abs(check[collar].astype(np.int16) - patch[collar]), axis=1)
        if np.percentile(error, 90) > 4:
            continue
        predicted = cv2.inpaint(patch, (~clean).astype(np.uint8), 3, cv2.INPAINT_NS)
        recovered[y0+yd, x0+xd] = predicted[y0-top+yd, x0-left+xd]
        resolved[y0+yd, x0+xd] = True
    return recovered, resolved


def verified_background_area(image, witness, usable, collar, *, search=31, minimum=12):
    """Validate a reference locally, including around visible scene changes."""
    if np.count_nonzero(collar) < minimum:
        return np.zeros_like(usable)
    error = np.zeros(collar.shape, np.float32)
    error[collar] = np.abs(image[collar].astype(np.int16) - witness[collar]).mean(axis=1)
    visible = cv2.boxFilter(collar.astype(np.float32), -1, (search, search), normalize=False)
    agreeing = cv2.boxFilter((collar & (error <= 10)).astype(np.float32), -1, (search, search), normalize=False)
    return usable & (visible >= minimum) & (agreeing >= .90 * visible)


def continue_deep_background(image, missing, known, distance):
    """Use two agreeing models for a deeper gap with an equivalent visible holdout."""
    recovered = image.copy()
    resolved = np.zeros_like(missing)
    step, reach = 12, 14
    h, w = missing.shape
    eligible = missing & (distance <= reach)
    rows, cols = np.nonzero(eligible)
    tiles = np.unique(np.column_stack((rows // step, cols // step)), axis=0)
    for row, col in tiles:
        top, left = max(0, row * step - 20), max(0, col * step - 20)
        bottom, right = min(h, (row + 1) * step + 20), min(w, (col + 1) * step + 20)
        region = np.s_[top:bottom, left:right]
        patch = image[region]
        clean = known[region]
        local = np.zeros(clean.shape, np.uint8)
        inner = np.s_[row * step:min(h, (row + 1) * step), col * step:min(w, (col + 1) * step)]
        y, x = np.nonzero(eligible[inner])
        y, x = y + row * step, x + col * step
        local[y - top, x - left] = 1
        depth = min(5, max(2, round(float(distance[y, x].max()) * .5)))
        width = depth + 6
        band = cv2.dilate(local, np.ones((2 * width + 1, 2 * width + 1), np.uint8)) != 0
        collar = clean & band & (cv2.distanceTransform(clean.astype(np.uint8), cv2.DIST_L2, 3) <= depth)
        if np.count_nonzero(collar) < 14 or np.count_nonzero(clean & ~collar) < 30:
            continue
        check_mask = (~clean | collar).astype(np.uint8)
        fill_mask = (~clean).astype(np.uint8)
        candidates = []
        for method in (cv2.INPAINT_NS, cv2.INPAINT_TELEA):
            predicted = cv2.inpaint(patch, check_mask, 3, method)
            error = np.abs(predicted[collar].astype(np.int16) - patch[collar]).max(axis=1)
            if np.percentile(error, 90) > 4:
                break
            candidates.append(cv2.inpaint(patch, fill_mask, 3, method)[local != 0].astype(np.int16))
        if len(candidates) != 2:
            continue
        first, second = candidates
        agrees = np.abs(first - second).max(axis=1) <= 4
        recovered[y[agrees], x[agrees]] = ((first[agrees] + second[agrees] + 1) // 2).astype(np.uint8)
        resolved[y[agrees], x[agrees]] = True
    reject_patch_joins(recovered, resolved, tiles, step)
    return recovered, resolved


def corroborated_background(image, neighborhood, known, context, *, search=31, minimum=12, include_collar=False):
    """Find background observed in two matching source frames."""
    support = np.zeros_like(known)
    background = image.copy()
    collar = neighborhood & known
    target = neighborhood if include_collar else neighborhood & ~known
    claims = []
    for witness, occupied in context:
        if not np.any(target & ~support):
            break
        clear = cv2.dilate(occupied.astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
        eligible = verified_background_area(
            image, witness, target & clear & ~support, collar & clear, search=search, minimum=minimum,
        )
        if not np.any(eligible):
            continue
        rgb = witness.astype(np.int16)
        for previous, observed in claims:
            shared = eligible & observed
            agrees = np.zeros_like(shared)
            agrees[shared] = np.abs(rgb[shared] - previous[shared]).max(axis=1) <= 4
            background[agrees] = ((rgb[agrees] + previous[agrees] + 1) // 2).astype(np.uint8)
            support |= agrees
            eligible &= ~agrees
        claims.append((rgb, eligible))
    return background, support


def register_portrait_background(image, occupied, references):
    """Register the observed backdrop across camera pan, rotation and zoom."""
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    features = cv2.goodFeaturesToTrack(gray, 160, .02, 7, mask=(~occupied).astype(np.uint8))
    if features is None or len(features) < 12:
        return []
    registered = []
    for rgb, mask in references:
        previous = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        points, found, _ = cv2.calcOpticalFlowPyrLK(gray, previous, features, None)
        if points is None:
            continue
        xy = points.reshape(-1, 2)
        col, row = np.rint(xy).astype(int).T
        valid = found.ravel().astype(bool) & (col >= 0) & (row >= 0) & (col < w) & (row < h)
        valid[valid] &= ~mask[row[valid], col[valid]].astype(bool)
        if valid.sum() < 12:
            continue
        matrix, inliers = cv2.findHomography(points[valid], features[valid], cv2.RANSAC, 1.)
        if matrix is None or inliers.sum() < max(12, .65 * valid.sum()):
            continue
        tracked = points[valid][inliers.ravel().astype(bool)]
        if cv2.contourArea(cv2.convexHull(tracked)) < .10 * h * w:
            continue
        observed = cv2.warpPerspective((~mask.astype(bool)).astype(np.float32), matrix, (w, h)) > .999
        aligned = cv2.warpPerspective(rgb, matrix, (w, h))
        # Estimate the local lighting difference only from visible background.
        collar = cv2.erode((observed & ~occupied).astype(np.uint8), np.ones((7, 7), np.uint8))
        samples = cv2.boxFilter(collar.astype(np.float32), -1, (41, 41), normalize=False)
        delta = (image.astype(np.float32) - aligned) * collar[..., None]
        correction = cv2.boxFilter(delta, -1, (41, 41), normalize=False) / np.maximum(samples[..., None], 1)
        supported = (samples >= 48) & (np.max(np.abs(correction), axis=2) <= 18)
        aligned[supported] = np.clip(np.rint(aligned[supported] + correction[supported]), 0, 255)
        registered.append((aligned, ~observed))
    return registered


def continue_context_background(image, plate, missing, occupied, references):
    """Corroborate a wider collar when the original shot exposes a deep gap."""
    x, y, width, height = cv2.boundingRect(missing.astype(np.uint8))
    h, w = missing.shape
    margin = 34
    region = np.s_[max(0, y - margin):min(h, y + height + margin),
                   max(0, x - margin):min(w, x + width + margin)]
    holes = missing[region]
    foreground = occupied[region]
    clear = cv2.dilate(foreground.astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
    neighborhood = cv2.dilate(holes.astype(np.uint8), np.ones((65, 65), np.uint8)) != 0
    witnesses = [(rgb[region], mask[region]) for rgb, mask in references]
    backing, observed = corroborated_background(
        image[region], neighborhood, clear, witnesses, search=65, minimum=35,
    )
    restored = holes & observed
    plate[region][restored] = backing[restored]
    missing[region] &= ~restored
    return int(np.count_nonzero(restored))


def reconstruct_patch(image, delta, occupied, context, *, use_background_support=False):
    """Use corroborated source background before extending a smooth edge."""
    if not np.any(delta):
        return image, 0, 0, delta
    recovered = image.copy()
    missing = delta.copy()
    h, w = delta.shape
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    temporal = 0
    nearby = cv2.dilate(delta.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
    for other_image, other_occupied in context:
        unavailable = cv2.dilate(other_occupied.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        if not np.any(missing & ~unavailable) and np.count_nonzero(missing) < 12:
            continue
        test = other_image
        for aligned in (False, True):
            forbidden = unavailable
            if aligned:
                other_gray = cv2.cvtColor(other_image, cv2.COLOR_RGB2GRAY)
                matrix = align_background(gray, occupied, other_gray, other_occupied)
                if matrix is None:
                    break
                test = cv2.warpAffine(other_image, matrix, (w, h))
                forbidden = cv2.warpAffine(
                    unavailable.astype(np.uint8), matrix, (w, h),
                    flags=cv2.INTER_NEAREST, borderValue=1,
                ).astype(bool)
            usable = missing & ~forbidden
            if not np.any(usable):
                continue
            ring = nearby & ~occupied & ~forbidden
            errors = np.abs(image[ring].astype(np.int16) - test[ring]).mean(axis=1)
            if len(errors) < 12 or np.percentile(errors, 90) > 10:
                usable = verified_background_area(image, test, usable, ring)
            if not np.any(usable):
                continue
            recovered[usable] = test[usable]
            missing[usable] = False
            temporal += int(np.count_nonzero(usable))
            if not np.any(missing & ~forbidden):
                break
        if not np.any(missing):
            return recovered, temporal, 0, missing

    # A narrow smooth gap can be extrapolated from known background alone.
    # Test background structure away from the old subject's edge.
    known = ~(cv2.dilate(occupied.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
    if use_background_support and len(context) >= 2:
        neighborhood = cv2.dilate(missing.astype(np.uint8), np.ones((39, 39), np.uint8)) != 0
        left, top, width, height = cv2.boundingRect(neighborhood.astype(np.uint8))
        region = np.s_[top:top + height, left:left + width]
        witnesses = [(rgb[region], mask[region]) for rgb, mask in context]
        backing, observed = corroborated_background(image[region], neighborhood[region], known[region], witnesses)
        restored = missing[region] & observed
        recovered[region][restored] = backing[restored]
        missing[region] &= ~restored
        temporal += int(np.count_nonzero(restored))
        if not np.any(missing):
            return recovered, temporal, 0, missing
        if np.any(observed):
            image = image.copy()
            image[region][observed] = backing[observed]
            known[region] |= observed
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    if not np.any(known):
        return recovered, temporal, 0, missing
    missing8 = missing.astype(np.uint8)
    ring = (cv2.dilate(missing8, np.ones((15, 15), np.uint8)) > 0) & known
    gradients = cv2.Canny(gray, 30, 75) > 0
    gradient_ring = ring & ~(cv2.dilate(occupied.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)
    if np.count_nonzero(ring) < 8:
        return recovered, temporal, 0, missing
    distance, labels = cv2.distanceTransformWithLabels(
        (~known).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL,
    )
    spatial = 0
    smooth = np.count_nonzero(gradients & gradient_ring) <= max(1, np.count_nonzero(gradient_ring) * .025)
    if smooth and distance[missing].max() <= max(4.3, min(7.0, h * .012)):
        colors = np.zeros((int(labels.max()) + 1, 3), np.uint8)
        colors[labels[known]] = image[known]
        recovered[missing] = colors[labels[missing]]
        return recovered, temporal, int(np.count_nonzero(missing)), np.zeros_like(missing)

    patch, resolved = extend_background_edges(image, missing, known, distance, labels)
    recovered[resolved] = patch[resolved]
    missing &= ~resolved
    spatial += int(np.count_nonzero(resolved))
    if not np.any(missing):
        return recovered, temporal, spatial, missing

    # Exclude the uncertain trimap around the subject when fitting the coarse
    # surface. Validate the fine-scale result separately on visible texture.
    patch_known = cv2.erode(known.astype(np.uint8), np.ones((9, 9), np.uint8)) != 0
    patch, resolved = smooth_background_patch(image, missing, patch_known, gradients, distance)
    recovered[resolved] = patch[resolved]
    missing &= ~resolved
    spatial += int(np.count_nonzero(resolved))
    if np.any(missing):
        patch, resolved = continue_background_texture(image, missing, known, distance)
        recovered[resolved] = patch[resolved]
        missing &= ~resolved
        spatial += int(np.count_nonzero(resolved))
    if np.any(missing):
        patch, resolved = continue_deep_background(image, missing, known, distance)
        recovered[resolved] = patch[resolved]
        missing &= ~resolved
        spatial += int(np.count_nonzero(resolved))
    return recovered, temporal, spatial, missing


def reconstruct_background(image, delta, occupied, context, *, use_background_support=False, crop_to_gap=False):
    """Limit large-frame reconstruction buffers to the affected neighborhood."""
    if (not crop_to_gap and delta.size < 4_000_000) or not np.any(delta):
        return reconstruct_patch(image, delta, occupied, context, use_background_support=use_background_support)
    height, width = delta.shape
    x, y, patch_w, patch_h = cv2.boundingRect(delta.astype(np.uint8))
    margin = 128
    window = np.s_[max(0, y - margin):min(height, y + patch_h + margin),
                   max(0, x - margin):min(width, x + patch_w + margin)]
    neighbors = [(pixels[window], mask[window]) for pixels, mask in context]
    plate, temporal, spatial, missing = reconstruct_patch(
        image[window], delta[window], occupied[window], neighbors, use_background_support=use_background_support,
    )
    result = image.copy()
    result[window] = plate
    unresolved = np.zeros(delta.shape, bool)
    unresolved[window] = missing
    return result, temporal, spatial, unresolved


def matching_background(image, witness, collar):
    if np.count_nonzero(collar) < 20:
        return False
    error = np.abs(image[collar].astype(np.int16) - witness[collar]).max(axis=1)
    return np.percentile(error, 90) <= 7
