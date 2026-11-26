"""Source-space displacement fields for face and body controls."""

import cv2
import numpy as np

from controls import (
    FACE_OVAL,
    GEOMETRY,
    polygon,
    ramp,
    unit,
)


class Field:
    """An inverse displacement field in source pixels."""

    def __init__(self, shape):
        self.y = np.broadcast_to(np.arange(shape[0], dtype=np.float32)[:, None], shape)
        self.x = np.broadcast_to(np.arange(shape[1], dtype=np.float32)[None, :], shape)
        self.dx = np.zeros(shape, np.float32)
        self.dy = np.zeros(shape, np.float32)
        self.lift = None

    def coordinates(self, center, direction, region=np.s_[:, :]):
        x = self.x[region][:1, :] - center[0]
        y = self.y[region][:, :1] - center[1]
        return x * direction[0] + y * direction[1], -x * direction[1] + y * direction[0]

    def ellipse(self, center, direction, radii):
        u, v = self.coordinates(center, direction)
        weight = ramp(1 - ((u / radii[0]) ** 2 + (v / radii[1]) ** 2))
        return u, v, weight

    def vector(self, horizontal, vertical, direction, weight):
        self.dx += (horizontal * direction[0] - vertical * direction[1]) * weight
        self.dy += (horizontal * direction[1] + vertical * direction[0]) * weight

    def narrow_segment(self, a, b, width, strength):
        length = np.linalg.norm(b - a)
        direction = unit(b - a)
        u, v = self.coordinates((a + b) / 2, direction)
        weight = ramp(1 - (u / max(1, .54 * length)) ** 4) * ramp(1 - (v / width) ** 4)
        self.vector(0, v * strength, direction, weight)

    def compose_lift(self, lift):
        """Evaluate existing local edits at the source coordinates of the lift."""
        self.lift = lift
        if self.dx.any() or self.dy.any():
            height, width = self.dx.shape
            if self.dx.size <= 1_000_000:
                target_y = self.y + lift
                self.dx = cv2.remap(self.dx, self.x, target_y, cv2.INTER_LINEAR)
                self.dy = cv2.remap(self.dy, self.x, target_y, cv2.INTER_LINEAR)
            else:
                dx, dy = np.empty_like(self.dx), np.empty_like(self.dy)
                rows = max(1, 1_000_000 // width)
                for top in range(0, height, rows):
                    region = np.s_[top:min(height, top + rows), :]
                    target_y = self.y[region] + lift[region]
                    dx[region] = cv2.remap(self.dx, self.x[region], target_y, cv2.INTER_LINEAR)
                    dy[region] = cv2.remap(self.dy, self.x[region], target_y, cv2.INTER_LINEAR)
                self.dx, self.dy = dx, dy
        self.dy += lift

    def valid(self, scale):
        height, width = self.dx.shape
        left, top, region_w, region_h = cv2.boundingRect(((self.dx != 0) | (self.dy != 0)).astype(np.uint8))
        if not region_w or not scale:
            return True
        # Include adjacent cells and overlap by one row between bands so that
        # every triangle crossing a working boundary is checked.
        first, last = max(0, top - 1), min(height, top + region_h + 1)
        left, right = max(0, left - 1), min(width, left + region_w + 1)
        rows = max(1, 1_000_000 // (right - left) - 1)
        for start in range(first, last - 1, rows):
            region = np.s_[start:min(last, start + rows + 1), left:right]
            dx, dy = self.dx[region], self.dy[region]
            dx_x = np.diff(dx, axis=1) * scale
            dx_y = np.diff(dx, axis=0) * scale
            dy_x = np.diff(dy, axis=1) * scale
            dy_y = np.diff(dy, axis=0) * scale
            top_left = (1 + dx_x[:-1]) * (1 + dy_y[:, :-1]) - dx_y[:, :-1] * dy_x[:-1]
            bottom_right = (1 + dx_x[1:]) * (1 + dy_y[:, 1:]) - dx_y[:, 1:] * dy_x[1:]
            x, y = self.x[region] + dx * scale, self.y[region] + dy * scale
            if (not all(np.isfinite(det).all() and float(det.min()) >= .55
                        and float(det.max()) <= 1.65 for det in (top_left, bottom_right))
                    or max(float(np.abs(difference).max()) for difference in (dx_x, dx_y, dy_x, dy_y)) > .62
                    or not (x.min() >= 0 and x.max() < width and y.min() >= 0 and y.max() < height)):
                return False
        return True


def stretch_arm(field, joints, hand, gain, width, stationary):
    """Extend each bone from the shoulder, sharing transforms at the elbow."""
    shoulder = joints[0]
    segments = []
    for index, (start, end) in enumerate(zip(joints[:-1], joints[1:])):
        direction = unit(end - start)
        length = np.linalg.norm(end - start)
        pad = max(4, length * (.35 if index else .24))
        reach = 0.0
        if index and len(hand):
            # Keep translation constant through the fingers.
            reach = float(np.clip(np.max((hand - end) @ direction), 0, length * .65))
        segments.append((start, direction, length, pad, reach, -gain * (start - shoulder)))

    height, columns = field.dx.shape
    rows = max(1, 1_000_000 // columns)
    for top in range(0, height, rows):
        region = np.s_[top:min(height, top + rows), :]
        total_weight = np.zeros_like(field.dx[region])
        dx = np.zeros_like(total_weight)
        dy = np.zeros_like(total_weight)
        for start, direction, length, pad, reach, shift in segments:
            along, across = field.coordinates(start, direction, region)
            radial = ramp((width - np.abs(across)) / (width * .45))
            weight = ramp((along + pad) / pad) * ramp((length + reach + pad - along) / pad) * radial
            along_shift = -gain * np.clip(along, 0, length)
            dx += (shift[0] + along_shift * direction[0]) * weight
            dy += (shift[1] + along_shift * direction[1]) * weight
            total_weight += weight
        blend = stationary[region] / np.maximum(1, total_weight)
        field.dx[region] += dx * blend
        field.dy[region] += dy * blend


def observed_arm_chain(person, joints, torso):
    x, y = np.rint(joints[1:]).astype(int).T
    if torso[y, x].any():
        return False
    if np.all(person[y, x] >= 150):
        return True
    # A motion-blurred endpoint can straddle two pixels or sit beside the
    # mask core. Require continuous observed support along the forearm too.
    elbow, wrist = joints[1:]
    distance = np.linalg.norm(wrist - elbow)
    radius = max(2, min(6, round(distance * .16)))
    height, width = person.shape
    for col, row in np.rint(elbow + (wrist - elbow) * np.linspace(0, 1, 7)[:, None]).astype(int):
        sample = person[max(0, row - radius):min(height, row + radius + 1),
                        max(0, col - radius):min(width, col + radius + 1)]
        if np.count_nonzero(sample >= 150) < radius:
            return False
    return True


def extend_with_fixed_wrist(field, joints, person, parts, stationary, value, *, full_length=False):
    """Open a supported elbow bend while leaving a difficult wrist in place."""
    shoulder, elbow, wrist = joints
    lengths = np.linalg.norm(np.diff(joints, axis=0), axis=1)
    direction = unit(elbow - shoulder) + unit(elbow - wrist)
    if np.linalg.norm(direction) < .50:
        return False
    h, w = person.shape
    x, y = np.rint(elbow).astype(int)
    if (not (1 <= x < w - 1 and 1 <= y < h - 1)
            or person[y, x] < 150 or parts[y, x] == 5 or stationary[y, x] < .8):
        return False
    # A projected centerline can fall beside a narrow, foreshortened arm.
    # Check contiguous visible material across both links near the elbow.
    for endpoint, length in zip((shoulder, wrist), lengths):
        link = endpoint - elbow
        tangent = unit(link)
        normal = np.array([-tangent[1], tangent[0]], np.float32)
        radius = max(2, min(5, round(float(length) * .15)))
        offsets = np.arange(-radius, radius + 1)[:, None] * normal
        for fraction in (.20, .35):
            xx, yy = np.rint(elbow + fraction * link + offsets).astype(int).T
            inside = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
            visible = np.zeros(inside.shape, bool)
            visible[inside] = (person[yy[inside], xx[inside]] >= 150) & (parts[yy[inside], xx[inside]] != 5)
            if not np.any(visible[:-1] & visible[1:]):
                return False
    axis = unit(direction)
    radius = float(lengths.min()) * .62
    distance, across = field.coordinates(elbow, axis)
    if full_length:
        # Keep the shoulder and wrist in place while moving the elbow enough
        # to achieve the same chain extension as the free-wrist control.
        target = float(lengths.sum()) * (1 + .12 * value)
        low, high = 0., radius * .29
        ends = joints[[0, 2]]
        if np.linalg.norm(ends - elbow - high * axis, axis=1).sum() < target:
            return False
        for _ in range(13):
            middle = (low + high) * .5
            if np.linalg.norm(ends - elbow - middle * axis, axis=1).sum() < target:
                low = middle
            else:
                high = middle
        shift = -(low + high) * .5
        reach = np.hypot(distance, across) / radius
        weight = ramp((1 - reach) / .66) * stationary
    else:
        weight = ramp(1 - (distance ** 2 + across ** 2) / radius ** 2) * stationary
        shift = -.12 * value * float(lengths.min())
    field.vector(shift, 0, axis, weight)
    return True


def arm_lengthening(field, points, visible, person, parts, value, *, wrist_anchor=False):
    if not visible[[11, 12, 23, 24]].all():
        return 0, "arm-attachment-unreliable"
    height, width = person.shape
    torso = polygon(person.shape, points[[11, 12, 24, 23]]) > 0
    stationary = ramp(cv2.distanceTransform((~torso).astype(np.uint8), cv2.DIST_L2, 3) / 5)
    used = []
    wrist_limited = []
    reason = None
    for chain, tips in [((11, 13, 15), (17, 19, 21)), ((12, 14, 16), (18, 20, 22))]:
        if not visible[list(chain)].all():
            continue
        joints = points[list(chain)]
        lengths = np.linalg.norm(np.diff(joints, axis=0), axis=1)
        if lengths.min() < 8:
            continue
        endpoints = np.rint(joints[1:]).astype(int)
        if not observed_arm_chain(person, joints, torso):
            wrist_limited.append(joints)
            continue
        radial = min(float(lengths.min()) * .53, max(8, np.linalg.norm(points[11] - points[12]) * .28))
        wrist_x, wrist_y = endpoints[-1]
        inset = max(4, round(radial))
        region = np.s_[max(0, wrist_y-inset):wrist_y+inset+1, max(0, wrist_x-inset):wrist_x+inset+1]
        contact = parts[region] == 5
        hand = points[list(tips)][visible[list(tips)]]
        supported = stationary
        if np.mean(contact) > .12:
            if wrist_anchor:
                wrist_limited.append(joints)
                continue
            # A nearby label is not necessarily over the wrist. Keep that
            # material still only if the wrist and two hand points are
            # independently labeled as visible skin.
            xx, yy = np.rint(hand).astype(int).T
            if parts[wrist_y, wrist_x] != 2 or np.count_nonzero(parts[yy, xx] == 2) < 2:
                wrist_limited.append(joints)
                continue
            accessory = np.zeros(person.shape, np.uint8)
            accessory[region] = contact
            distance = cv2.distanceTransform(1 - accessory, cv2.DIST_L2, 3)
            supported = stationary * ramp(distance / max(4, radial * .45))
            reason = "arm-contact-protected"
        shift = (joints[2] - joints[0]) * (.12 * value)
        frame_space = np.array([width - 1 - wrist_x if shift[0] > 0 else wrist_x,
                                height - 1 - wrist_y if shift[1] > 0 else wrist_y])
        room = np.minimum(1, np.maximum(0, frame_space - inset) / np.maximum(np.abs(shift), 1e-5))
        ratio = float(room.min())
        if ratio <= 0:
            continue
        stretch_arm(field, joints, hand, .12 * value * ratio, radial, supported)
        used.append(ratio)
        if ratio < .999:
            reason = "insufficient-arm-clearance"
    if wrist_anchor:
        for joints in wrist_limited:
            if extend_with_fixed_wrist(field, joints, person, parts, stationary, value, full_length=True):
                used.append(1.)
    if not used:
        recovered = False
        for joints in wrist_limited:
            recovered |= extend_with_fixed_wrist(field, joints, person, parts, stationary, value * .60)
        if recovered:
            return value * .60, "wrist-protected-elbow-extension"
        return 0, "arm-chain-occluded-or-unreliable"
    return value * min(used), "partial-arm-coverage" if len(used) != 2 else reason


def face_basis(person, parts, face):
    if face is None:
        return None
    height, width = person.shape
    span = np.linalg.norm(face[454] - face[234])
    depth = np.linalg.norm(face[152] - face[10])
    if not (22 < span < width * .96 and depth > 20
            and np.all(face.min(axis=0) >= 0) and np.all(face.max(axis=0) < [width, height])):
        return None
    outline = polygon(person.shape, face[list(FACE_OVAL)]) > 0
    if not np.any(outline) or np.mean((parts[outline] == 3) & (person[outline] > 128)) <= .65:
        return None
    return unit(face[454] - face[234]), span, depth


def frontal_head_contour(person, pose):
    """Find a bounded head silhouette joined to the neck of a reliable pose."""
    if pose is None or np.any(pose[[0, 2, 5, 7, 8, 11, 12], 2] < .80):
        return None
    nose = pose[0, :2]
    ears = pose[[7, 8], :2]
    shoulders = pose[[11, 12], :2]
    across = unit(shoulders[0] - shoulders[1])
    down = np.array([-across[1], across[0]], np.float32)
    shoulder_center = shoulders.mean(axis=0)
    if np.dot(shoulder_center - nose, down) < 0:
        across, down = -across, -down
    shoulder_span = np.linalg.norm(shoulders[0] - shoulders[1])
    # Inner landmarks can move closer together in a turn without the
    # silhouette shrinking. Size the search for the full head, then require
    # its component to end inside that search independently of the landmarks.
    width = max(np.linalg.norm(ears[0] - ears[1]), shoulder_span * .42)
    depth = np.dot(shoulder_center - nose, down)
    if width < 8 or depth < width * .65 or depth > width * 2.5:
        return None
    neck = nose + down * depth * .58
    bounds = np.array([neck + across * width * side + down * height
                       for side in (-1.18, 1.18) for height in (-depth * 1.85, 0)])
    h, w = person.shape
    left, top = np.maximum(0, np.floor(bounds.min(axis=0)).astype(int))
    right, bottom = np.minimum((w, h), np.ceil(bounds.max(axis=0)).astype(int) + 1)
    x, y = np.rint(nose).astype(int)
    if not (left <= x < right and top <= y < bottom):
        return None
    patch = np.s_[top:bottom, left:right]
    yy, xx = np.ogrid[top:bottom, left:right]
    u = (xx - neck[0]) * across[0] + (yy - neck[1]) * across[1]
    v = (xx - neck[0]) * down[0] + (yy - neck[1]) * down[1]
    silhouette = (person[patch] > 175) & (np.abs(u) <= width * 1.18) & (v <= 0) & (v >= -depth * 1.85)
    _, components = cv2.connectedComponents(silhouette.astype(np.uint8))
    label = components[y - top, x - left]
    if not label:
        return None
    head = components == label
    if ((top == 0 and head[0].any()) or (left == 0 and head[:, 0].any())
            or (bottom == h and head[-1].any()) or (right == w and head[:, -1].any())):
        return None
    side = float(np.abs(u[head]).max())
    height = float(-v[head].min())
    # A contour truncated by the search window may include a raised arm or
    # lack an observable crown. Only the lower neck is deliberately cut.
    if (side >= width * 1.10 or not depth * .75 <= height <= depth * 1.75
            or np.count_nonzero(head) < width * height * .55):
        return None
    return neck, across, side, height, patch, head


def profile_head_contour(person, pose):
    """Trace a visible side profile and its attached hair above the neck."""
    if pose is None or np.any(pose[[0, 2, 5, 7, 8, 11, 12, 23, 24], 2] < .80):
        return None
    nose = pose[0, :2]
    shoulders = pose[[11, 12], :2].mean(axis=0)
    down = unit(pose[[23, 24], :2].mean(axis=0) - shoulders)
    across = np.array([down[1], -down[0]], np.float32)
    ears = (pose[[7, 8], :2] - nose) @ across
    span = float(np.max(np.abs(ears)))
    depth = float((shoulders - nose) @ down)
    # A side profile places the nose ahead of both ears along the head axis.
    if (span < 7 or np.prod(ears) <= 0 or np.min(np.abs(ears)) < .24 * span
            or not .80 * span <= depth <= 3.1 * span):
        return None
    origin = nose + down * (.67 * depth) + across * (1.08 * float(ears.mean()))
    extent, reach = max(12, 3.15 * span), 1.92 * depth
    envelope = np.array([origin + across * u + down * v
                         for u in (-extent, extent) for v in (-reach, .03 * depth)])
    height, width = person.shape
    left, top = np.maximum(0, np.floor(envelope.min(axis=0)).astype(int))
    right, bottom = np.minimum((width, height), np.ceil(envelope.max(axis=0)).astype(int) + 1)
    if right <= left or bottom <= top:
        return None
    patch = np.s_[top:bottom, left:right]
    yy, xx = np.ogrid[top:bottom, left:right]
    u = (xx - origin[0]) * across[0] + (yy - origin[1]) * across[1]
    v = (xx - origin[0]) * down[0] + (yy - origin[1]) * down[1]
    # Use the connected soft silhouette so fine hair can follow the head.
    observed = (person[patch] > 85) & (np.abs(u) <= extent) & (v <= 0) & (v >= -reach)
    _, labels = cv2.connectedComponents(observed.astype(np.uint8))
    anchors = [
        labels[y - top, x - left] if left <= x < right and top <= y < bottom else 0
        for x, y in np.rint(pose[[2, 5, 7, 8], :2]).astype(int)
    ]
    shared = set(anchors[:2]).intersection(anchors[2:]) - {0}
    if len(shared) != 1:
        return None
    head = labels == shared.pop()
    head_u = u[head]
    crown = float(-v[head].min())
    collar = head & (v >= -.12 * depth) & (np.abs(u) < .65 * span)
    margin = max(2, .05 * depth)
    if (head_u.size < .46 * span * depth
            or not depth <= crown <= min(1.84 * depth, reach - margin)
            or np.max(np.abs(head_u)) >= extent - margin
            or np.ptp(head_u) > 4.40 * span
            or np.count_nonzero(collar) < max(4, .30 * depth)
            or (top == 0 and head[0].any()) or (left == 0 and head[:, 0].any())
            or (right == width and head[:, -1].any()) or (bottom == height and head[-1].any())):
        return None
    offset = float(np.median(u[collar]))
    neck = origin + across * offset
    return neck, across, float(np.max(np.abs(head_u - offset))), crown, patch, head


def pose_head_contour(person, pose):
    return frontal_head_contour(person, pose) or profile_head_contour(person, pose)


def cropped_head_boundary(person, parts, face):
    """Distinguish a known cropped head from a weak contour observation."""
    if face is None:
        return False
    height, width = person.shape
    x = np.r_[np.arange(width), np.arange(width), np.zeros(height - 2, int), np.full(height - 2, width - 1)]
    y = np.r_[np.zeros(width, int), np.full(width, height - 1), np.arange(1, height - 1), np.arange(1, height - 1)]
    border = (person[y, x] > 128) & np.isin(parts[y, x], (1, 3))
    x, y = x[border], y[border]
    if len(x) < 4:
        return False
    across = unit(face[454] - face[234])
    span = float(np.linalg.norm(face[454] - face[234]))
    depth = float(np.linalg.norm(face[152] - face[10]))
    offsets = np.column_stack((x, y)) - face[152]
    lateral = offsets @ across
    vertical = offsets @ np.array([-across[1], across[0]])
    close = (np.abs(lateral) <= span * .92) & (vertical <= 0) & (vertical >= -1.9 * depth)
    return np.count_nonzero(close) >= 4


def head_geometry(person, parts, face, pose, observed_head=None):
    if cropped_head_boundary(person, parts, face):
        return None
    basis = face_basis(person, parts, face)
    if basis is not None:
        across, span, depth = basis
        neck = .97 * face[152] + .03 * face[10]
        yy, xx = np.nonzero((parts == 1) & (person > 128))
        dx, dy = xx - neck[0], yy - neck[1]
        along = dx * across[0] + dy * across[1]
        vertical = -dx * across[1] + dy * across[0]
        hair = (np.abs(along) < span) & (vertical < 0) & (vertical > -1.9 * depth)
        if np.count_nonzero(hair) > span * depth * .035:
            reach_x = max(span * .66, float(np.max(np.abs(along[hair]))) * 1.22)
            reach_y = max(depth * 1.22, float(-np.min(vertical[hair])) * 1.18)
            return neck, across, reach_x, reach_y, depth, .49, None
    contour = observed_head if observed_head is not None else pose_head_contour(person, pose)
    if contour is None:
        return None
    neck, across, half_width, height, patch, component = contour
    return neck, across, half_width * 1.35, height * 1.22, height, .39, (patch, component)


def ground_anchor(person, pose, knee, ankle, foot):
    """Resolve slight ankle drift only against the same observed shoe."""
    point = pose[ankle, :2]
    x, y = np.rint(point).astype(int)
    if person[y, x] >= 128:
        return point[1]
    if min(pose[knee, 2], pose[ankle, 2]) < .80:
        return None
    shin = np.linalg.norm(point - pose[knee, :2])
    radius = int(np.ceil(shin * .055))
    height, width = person.shape
    left, top = max(0, x - radius), max(0, y - radius)
    patch = person[top:min(height, y + radius + 1), left:min(width, x + radius + 1)]
    rows, cols = np.nonzero(patch >= 150)
    if not len(rows):
        return None
    candidates = np.column_stack((cols + left, rows + top))
    distances = np.linalg.norm(candidates - point, axis=1)
    tips = pose[[tip for tip in foot if pose[tip, 2] >= .80], :2]

    def connects_to_shoe(position, dense):
        for tip in tips:
            # A further correction needs pixel-by-pixel support so it
            # cannot cross a shadow or latch onto a disconnected edge.
            steps = max(7, int(np.ceil(np.linalg.norm(position - tip))) + 1) if dense else 7
            chain = np.rint(np.linspace(position, tip, steps)).astype(int)
            if np.all(person[chain[:, 1], chain[:, 0]] >= 128):
                return True
        return False

    closest = int(np.argmin(distances))
    if distances[closest] <= np.ceil(shin * .035) and connects_to_shoe(candidates[closest], False):
        return float(candidates[closest, 1])
    for picked in np.argsort(distances, kind="stable")[:64]:
        if distances[picked] > radius:
            break
        if connects_to_shoe(candidates[picked], True):
            return float(candidates[picked, 1])
    return None


def build_geometry(field, person, parts, face, pose, values, head=None, *, wrist_anchor=False):
    height, width = person.shape
    diagnostics = {name: (0, "region-not-visible") for name in GEOMETRY if name in values}

    def value(name):
        return values.get(name, 0)

    def accept(name):
        if name in diagnostics:
            diagnostics[name] = (value(name), None)

    # Face detail retains the same resolution and semantic requirements.
    # Whole-head geometry can use a separately observed head silhouette.
    face_names = ("faceSlim", "eyeEnlarge")
    if any(value(name) for name in face_names):
        basis = face_basis(person, parts, face)
        if basis is None:
            for name in face_names:
                if face is not None and value(name):
                    diagnostics[name] = (0, "face-visible-but-unreliable")
        else:
            across, span, face_height = basis
            if value("faceSlim"):
                center = (face[1] + face[152]) / 2
                u, v, weight = field.ellipse(center, across, (span * .70, face_height * .46))
                # Nose, mouth and the center of the chin are the fixed core.
                sides = ramp((np.abs(u) / span - .16) * 6)
                field.vector(.18 * value("faceSlim") * u, 0, across, weight * sides)
                accept("faceSlim")
            if value("eyeEnlarge"):
                for corners, lid, base in [((33, 133), (159, 145), 33), ((362, 263), (386, 374), 263)]:
                    a, b = face[list(corners)]
                    eye_width = np.linalg.norm(b - a)
                    openness = np.linalg.norm(face[lid[0]] - face[lid[1]]) / max(1, eye_width)
                    if openness < .13 or eye_width < 7 or not (0 <= face[base, 0] < width and 0 <= face[base, 1] < height):
                        continue
                    u, v, weight = field.ellipse((a + b) / 2, unit(b - a), (eye_width * 1.1, eye_width * .74))
                    gain = -.23 * value("eyeEnlarge") * ramp((openness - .13) / .14)
                    field.vector(gain * u, gain * v, unit(b - a), weight)
                    accept("eyeEnlarge")
                if not diagnostics["eyeEnlarge"][0]:
                    diagnostics["eyeEnlarge"] = (0, "eyes-closed-or-unreliable")

    if value("headReduce"):
        head = head or head_geometry(person, parts, face, pose)
        if head is not None:
            neck, across, reach_x, reach_y, depth, taper, contour = head
            u, v = field.coordinates(neck, across)
            weight = ramp((1.16 - np.abs(u) / reach_x) * 3) * ramp((1.12 + v / reach_y) * 3)
            weight *= ramp((-v + .13 * depth) / (taper * depth))
            if contour is not None:
                region, component = contour
                # Nearby arms can be close even when the head boundary is
                # distinct. Keep the warp localized to the observed head.
                support = np.zeros_like(person)
                support[region] = component
                distance = cv2.distanceTransform(1 - support, cv2.DIST_L2, 3)
                weight *= ramp(1 - distance / max(4, depth * .32))
            field.vector(.15 * value("headReduce") * u, .12 * value("headReduce") * v, across, weight)
            accept("headReduce")
        elif cropped_head_boundary(person, parts, face):
            diagnostics["headReduce"] = (0, "head-contour-outside-frame")
        elif face is not None or (pose is not None and pose[0, 2] >= .80):
            diagnostics["headReduce"] = (0, "head-contour-unreliable")

    if pose is None:
        return diagnostics
    points = pose[:, :2]
    visible = (pose[:, 2] >= .55) & (points[:, 0] > 1) & (points[:, 0] < width - 2) & (points[:, 1] > 1) & (points[:, 1] < height - 2)
    shoulders, hips = points[[11, 12]].mean(axis=0), points[[23, 24]].mean(axis=0)
    span = np.linalg.norm(points[11] - points[12])
    length = np.linalg.norm(hips - shoulders)
    torso = visible[[11, 12, 23, 24]].all() and span > 12 and length > 16
    if torso and (value("bodySlim") or value("waistSlim")):
        sideways = unit(np.array([hips[1] - shoulders[1], shoulders[0] - hips[0]]))
        waist = .37 * shoulders + .63 * hips
        u, v = field.coordinates(waist, sideways)
        body_weight = ramp(1 - (u / (span * 1.02)) ** 4) * ramp(1 - ((v + .04 * length) / (.87 * length)) ** 4)
        waist_weight = ramp(1 - (u / (span * .84)) ** 4) * ramp(1 - (v / (.31 * length)) ** 2)
        arms = np.zeros(person.shape, np.uint8)
        for a, b in [(11, 13), (13, 15), (12, 14), (14, 16)]:
            if visible[[a, b]].all():
                cv2.line(arms, tuple(points[a].astype(int)), tuple(points[b].astype(int)), 255, max(3, round(span * .18)))
        arm_weight = 1 - cv2.GaussianBlur(arms.astype(np.float32) / 255, (0, 0), 3)
        strength = .15 * value("bodySlim") * body_weight
        strength += (1 - strength / .26) * .19 * value("waistSlim") * waist_weight
        field.vector(u * strength, 0, sideways, arm_weight)
        accept("bodySlim")
        accept("waistSlim")
    for name, chains, proportion in [
        ("armSlim", [(11, 13, 15), (12, 14, 16)], .25),
        ("legSlim", [(23, 25, 27), (24, 26, 28)], .32),
    ]:
        if not value(name) and not value("bodySlim"):
            continue
        for chain in chains:
            for a, b in zip(chain, chain[1:]):
                if visible[[a, b]].all():
                    limb_width = max(9, min(.48 * span, np.linalg.norm(points[b] - points[a]) * proportion))
                    whole = .065 * value("bodySlim")
                    local = .21 * value(name)
                    field.narrow_segment(points[a], points[b], limb_width, whole + local * (1 - whole / .24))
                    accept(name)

    if value("armLength"):
        diagnostics["armLength"] = arm_lengthening(field, points, visible, person, parts, value("armLength"), wrist_anchor=wrist_anchor)

    feet = [[index for index in pair if visible[index]] for pair in ((29, 31), (30, 32))]
    if value("legLength") and torso and visible[[25, 26, 27, 28]].all() and all(feet):
        # Ground is the lowest observed foot; tibia/femur stretch progressively
        # toward the hips and the upper body moves up by the same displacement.
        ankles = [ground_anchor(person, pose, knee, ankle, foot)
                  for knee, ankle, foot in ((25, 27, feet[0]), (26, 28, feet[1]))]
        contacts = [*points[feet[0] + feet[1], 1], *(y for y in ankles if y is not None)]
        ground = float(max(contacts))
        available = np.flatnonzero(np.any(person > 127, axis=1))
        leg_height = ground - hips[1]
        desired = float(leg_height * .115 * value("legLength"))
        if leg_height < length * .65 or None in ankles:
            diagnostics["legLength"] = (0, "unsupported-stance-for-ground-anchor")
        elif len(available) and (space := float(available[0]) - 5) > 1:
            actual = min(desired, space * .8)
            bounds = np.flatnonzero(np.any(person > 127, axis=0))
            # Fade outside the observed silhouette over enough pixels for
            # the requested lift. A narrow fixed fade can invalidate an
            # otherwise smooth full-strength map beside an extended hand.
            edge = max(8, span * .23, actual * 5.5)
            feather = ramp((bounds[-1] + edge - field.x) / edge) * ramp((field.x - bounds[0] + edge) / edge)
            # Fade out at both feet, preserving their placement and contacts.
            ankle = float(min(contacts))
            progress = np.clip((ankle - field.y) / max(1, ankle - hips[1]), 0, 1)
            field.compose_lift((actual * progress * feather).astype(np.float32))
            ratio = actual / max(desired, 1e-6)
            diagnostics["legLength"] = (value("legLength") * ratio, "insufficient-headroom" if ratio < .999 else None)
        else:
            diagnostics["legLength"] = (0, "insufficient-headroom")
    return diagnostics
