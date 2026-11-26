"""Local MediaPipe observations and conservative shot-local track association."""

from contextlib import ExitStack
import math
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np

from controls import FACE_OVAL, polygon
from deformation import pose_head_contour

ANALYSIS_SIDE = 512
MODEL_FILES = ("face.task", "pose.task", "parts.tflite")
TRACK_GAP = .22
MAX_PEOPLE = 4


def pack(image):
    ok, result = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("Could not compress a beauty analysis mask.")
    return result.tobytes()


def unpack(data):
    if data is None:
        return None
    result = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if result is None:
        raise ValueError("Invalid beauty analysis mask.")
    return result


def clipped_box(points, width, height):
    return np.r_[np.maximum(0, points.min(axis=0)),
                 np.minimum((width - 1, height - 1), points.max(axis=0))]


def mask_box(mask):
    points = cv2.findNonZero((mask >= 128).astype(np.uint8))
    if points is None:
        return None
    x, y, w, h = cv2.boundingRect(points)
    return np.array([x, y, x + w - 1, y + h - 1], np.float32)


def overlap(a, b):
    wh = np.maximum(np.minimum(a[2:], b[2:]) - np.maximum(a[:2], b[:2]), 0)
    union = np.prod(a[2:] - a[:2]) + np.prod(b[2:] - b[:2]) - np.prod(wh)
    return float(np.prod(wh) / max(1, union))


def histogram(rgb, mask):
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    counts = cv2.calcHist([hsv], [0, 1], (mask > 175).astype(np.uint8), [16, 8], [0, 180, 0, 256])
    return cv2.normalize(counts, counts, alpha=1, norm_type=cv2.NORM_L1)


def mp_image(rgb):
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))


def face_mask_owner(face, people, shape):
    """Recover a face association only when one visible silhouette owns it."""
    oval = polygon(shape, face[list(FACE_OVAL)]) != 0
    if np.count_nonzero(oval) < 24:
        return None
    coverage = [float(np.mean(person["mask"][oval] > 150)) for person in people]
    if not coverage:
        return None
    owner = int(np.argmax(coverage))
    if coverage[owner] < .80 or any(score > .35 for i, score in enumerate(coverage) if i != owner):
        return None
    person = people[owner]
    if person["face"] is not None:
        return None
    nose = person["body"][0]
    span = max(12, np.linalg.norm(face[234] - face[454]))
    if nose[2] >= .45 and np.linalg.norm(nose[:2] - face[1]) > span * 1.1:
        return None
    return owner


class Detector:
    def __init__(self, models, stack: ExitStack):
        directory = Path(models)
        options = [mp.tasks.BaseOptions(model_asset_path=str(directory / name),
                                        delegate=mp.tasks.BaseOptions.Delegate.CPU)
                   for name in MODEL_FILES]
        vision = mp.tasks.vision
        self.face = stack.enter_context(vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(base_options=options[0], num_faces=MAX_PEOPLE,
                                         min_face_detection_confidence=.56,
                                         min_face_presence_confidence=.56)))
        self.pose = stack.enter_context(vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(base_options=options[1], num_poses=MAX_PEOPLE,
                                         output_segmentation_masks=True,
                                         min_pose_detection_confidence=.54,
                                         min_pose_presence_confidence=.54)))
        self.parts = stack.enter_context(vision.ImageSegmenter.create_from_options(
            vision.ImageSegmenterOptions(base_options=options[2], output_category_mask=True,
                                         output_confidence_masks=False)))

    def labels(self, rgb):
        result = self.parts.segment(mp_image(rgb)).category_mask.numpy_view().copy()
        if result.ndim == 3:
            result = result[:, :, 0]
        return result

    def detect(self, rgb):
        height, width = rgb.shape[:2]
        image = mp_image(rgb)
        faces = [np.array([(landmark.x * width, landmark.y * height) for landmark in points], np.float32)
                 for points in self.face.detect(image).face_landmarks]
        pose = self.pose.detect(image)
        masks = [np.rint(mask.numpy_view().squeeze().clip(0, 1) * 255).astype(np.uint8)
                 for mask in (pose.segmentation_masks or [])]
        people = []
        for points, mask in zip(pose.pose_landmarks, masks, strict=True):
            body = np.array([(p.x * width, p.y * height, min(p.visibility or 0, p.presence or 0))
                             for p in points], np.float32)
            if mask.shape != (height, width):
                mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
            box = mask_box(mask)
            if box is None or np.prod(box[2:] - box[:2]) < 450:
                continue
            # Restrict a pose's mask to its largest connected visible component.
            # Secondary nearby pose masks remain separate and are protected at render time.
            count, components, stats, _ = cv2.connectedComponentsWithStats((mask > 75).astype(np.uint8))
            if count > 2:
                major = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
                support = cv2.dilate((components == major).astype(np.uint8), np.ones((5, 5), np.uint8))
                mask *= support
            people.append({"box": box, "body": body, "face": None, "mask": mask})

        orphan_faces = []
        for face in faces:
            center = face[1]
            x, y = np.rint(center).astype(int)
            if not (0 <= x < width and 0 <= y < height):
                continue
            candidates = []
            for index, person in enumerate(people):
                nose = person["body"][0]
                span = max(12, np.linalg.norm(face[234] - face[454]))
                distance = np.linalg.norm(nose[:2] - center) / span
                if nose[2] >= .45 and distance < .65 and person["mask"][y, x] > 100:
                    candidates.append((distance, index))
            candidates.sort()
            if len(candidates) == 1 or (len(candidates) > 1 and candidates[1][0] - candidates[0][0] > .28):
                person = people[candidates[0][1]]
                if person["face"] is None:
                    person["face"] = face
                    continue
            owner = face_mask_owner(face, people, (height, width))
            if owner is not None:
                people[owner]["face"] = face
                continue
            orphan_faces.append(face)

        if not people and len(orphan_faces) == 1:
            full_labels = self.labels(rgb)
            face = orphan_faces[0]
            # Face-only framing is safe when the semantic model supplies a single
            # connected person and there is only one face detection.
            count, components = cv2.connectedComponents((full_labels != 0).astype(np.uint8))
            x, y = np.rint(face[1]).astype(int)
            component = int(components[y, x])
            if count > 1 and component:
                mask = (components == component).astype(np.uint8) * 255
                box = mask_box(mask)
                if box is not None:
                    people.append({"box": box, "body": None, "face": face, "mask": mask})
                    orphan_faces.pop()
        unresolved = np.zeros((height, width), np.uint8)
        for face in orphan_faces:
            unresolved |= cv2.dilate(polygon((height, width), face[list(FACE_OVAL)]), np.ones((7, 7), np.uint8))
        for person in people:
            box = person["box"]
            padding = np.round(.10 * (box[2:] - box[:2])).astype(int)
            x, y = np.maximum(0, box[:2].astype(int) - padding)
            right, bottom = np.minimum((width, height), box[2:].astype(int) + 1 + padding)
            labels = np.zeros((height, width), np.uint8)
            crop = np.ascontiguousarray(rgb[y:bottom, x:right])
            region = self.labels(crop)
            labels[y:bottom, x:right] = cv2.resize(region, (right - x, bottom - y), interpolation=cv2.INTER_NEAREST)
            labels[person["mask"] < 80] = 0
            person["parts"] = labels
            person["appearance"] = histogram(rgb, person["mask"])
        return people, unresolved


def active_picture(rgb):
    """Identify symmetrical black padding around a visible image."""
    height, width = rgb.shape[:2]
    bright = np.max(rgb, axis=2) > 9

    def bounds(nonblack, size):
        visible = np.flatnonzero(nonblack)
        if not len(visible):
            return 0, size
        first, last = int(visible[0]), int(visible[-1]) + 1
        far = size - last
        if not (.02 * size <= min(first, far) <= max(first, far) <= .24 * size
                and abs(first - far) <= max(2, .02 * size)):
            return 0, size
        return first, last

    left, right = bounds(np.any(bright, axis=0), width)
    top, bottom = bounds(np.any(bright, axis=1), height)
    if (left, top, right, bottom) == (0, 0, width, height):
        return None
    active = rgb[top:bottom, left:right]
    if np.count_nonzero(np.max(active, axis=2) > 24) < active.shape[0] * active.shape[1] * .25:
        return None
    return left, top, right, bottom


def detect_active_picture(detector, source, rgb, bounds):
    """Retry detection inside confirmed black padding."""
    if active_picture(rgb) != bounds:
        return None
    return detect_picture_region(detector, source, rgb.shape[:2], bounds)


def detect_picture_region(detector, source, shape, bounds):
    """Map regional detections onto the full analysis grid."""
    left, top, right, bottom = bounds
    height, width = shape
    source_h, source_w = source.shape[:2]
    x, y = left * source_w // width, top * source_h // height
    end_x = math.ceil(right * source_w / width)
    end_y = math.ceil(bottom * source_h / height)
    crop_size = analysis_size(end_x - x, end_y - y)
    crop = cv2.resize(source[y:end_y, x:end_x], crop_size, interpolation=cv2.INTER_AREA)
    people, unresolved = detector.detect(crop)
    size = (right - left, bottom - top)
    scale = np.array([size[0] / crop_size[0], size[1] / crop_size[1]], np.float32)
    origin = np.array([left, top], np.float32)

    def place(mask, interpolation):
        result = np.zeros((height, width), np.uint8)
        result[top:bottom, left:right] = cv2.resize(mask, size, interpolation=interpolation)
        return result

    for person in people:
        person["mask"] = place(person["mask"], cv2.INTER_LINEAR)
        person["parts"] = place(person["parts"], cv2.INTER_NEAREST)
        person["box"] = person["box"] * np.tile(scale, 2) + np.tile(origin, 2)
        for name in ("face", "body"):
            if person[name] is not None:
                person[name][:, :2] = person[name][:, :2] * scale + origin
    return people, place(unresolved, cv2.INTER_NEAREST)


def supplement_wide_people(detector, source, shape, people):
    """Look for a missed person across a wide frame while keeping primary detections."""
    height, width = shape
    split = width // 2
    overlap_pixels = round(width * .055)
    primary_left = center(people[0])[0] < split
    left, right = (split - overlap_pixels, width) if primary_left else (0, split + overlap_pixels)
    candidates, _ = detect_picture_region(detector, source, shape, (left, 0, right, height))
    for person in candidates:
        body, box = person["body"], person["box"]
        if body is None or not np.all(body[[11, 12, 23, 24], 2] >= .55):
            continue
        on_left = center(person)[0] < split
        if on_left == primary_left:
            continue
        if (left and box[0] <= left + 3) or (right < width and box[2] >= right - 4):
            continue
        if any(overlap(person["box"], other["box"]) >= .18 for other in people):
            continue
        people.append(person)
        if len(people) >= MAX_PEOPLE:
            break


def center(person):
    body = person["body"]
    if body is not None and np.all(body[[11, 12, 23, 24], 2] > .5):
        return np.mean(body[[11, 12, 23, 24], :2], axis=0)
    if person["face"] is not None:
        return person["face"][1]
    box = person["box"]
    return (box[:2] + box[2:]) * .5


def merged_person_masks(people):
    """Overlapping pose masks may be duplicate observations of one person."""
    cores = [person["mask"] > 150 for person in people if "mask" in person]
    amounts = [int(np.count_nonzero(core)) for core in cores]
    return any(
        min(amounts[i], amounts[j]) > 0
        and np.count_nonzero(first & second) >= .65 * min(amounts[i], amounts[j])
        for i, first in enumerate(cores) for j, second in enumerate(cores[:i])
    )


class Tracker:
    def __init__(self, width, height):
        self.diagonal = math.hypot(width, height)
        self.size = np.array([width, height], np.float32)
        self.active = {}
        self.known = set()
        self.reassociated = set()
        self.next_id = 1

    def assign(self, people, seconds, corrections=(), *, unresolved=False):
        self.active = {key: track for key, track in self.active.items() if seconds - track["time"] <= TRACK_GAP}
        self.reassociated.clear()
        if unresolved or merged_person_masks(people):
            if corrections:
                raise ValueError("Track corrections require a frame with independently visible people.")
            for person in people:
                person["id"] = None
            return True
        costs = {}
        for j, person in enumerate(people):
            anchor = center(person)
            for track_id, previous in self.active.items():
                elapsed = seconds - previous["time"]
                predicted = previous["anchor"] + previous["velocity"] * elapsed
                distance = float(np.linalg.norm(anchor - predicted)) / self.diagonal
                appearance = cv2.compareHist(person["appearance"], previous["appearance"], cv2.HISTCMP_BHATTACHARYYA)
                shared = overlap(person["box"], previous["box"])
                if (distance < .11 + elapsed * .18 or shared > .32) and appearance < .63:
                    costs[j, track_id] = distance * 2.2 + appearance * .55 + (1 - shared) * .20
        rejected = set()
        assigned = {}
        used = set()
        for correction in corrections:
            matching = sorted((float(np.linalg.norm(center(person) / self.size - correction["anchor"])), i)
                              for i, person in enumerate(people))
            if not matching or matching[0][0] > .05 or (len(matching) > 1 and matching[1][0] - matching[0][0] < .018):
                raise ValueError("Track correction does not resolve to one detected subject.")
            index, track_id = matching[0][1], correction["trackId"]
            if track_id not in self.known or track_id in used or index in assigned:
                raise ValueError("Track correction must bind a previously observed, shot-local track.")
            if track_id not in self.active:
                self.reassociated.add(track_id)
            assigned[index] = track_id
            used.add(track_id)
        for (index, track_id), cost in sorted(costs.items(), key=lambda item: item[1]):
            if index in assigned or index in rejected or track_id in used:
                continue
            competing = [other for (row, col), other in costs.items()
                         if (row == index and col != track_id and col not in used)
                         or (col == track_id and row != index and row not in assigned)]
            if competing and min(competing) - cost < .085:
                rejected.add(index)
                continue
            assigned[index] = track_id
            used.add(track_id)
        for i, person in enumerate(people):
            if i in rejected or (i not in assigned and any(row == i for row, _ in costs)):
                person["id"] = None
                continue
            track_id = assigned.get(i)
            if track_id is None:
                track_id = "person-" + str(self.next_id)
                self.next_id += 1
            anchor = center(person)
            previous = self.active.get(track_id)
            velocity = np.zeros(2, np.float32)
            if previous and seconds > previous["time"]:
                velocity = (anchor - previous["anchor"]) / (seconds - previous["time"])
            person["id"] = track_id
            self.known.add(track_id)
            self.active[track_id] = {"time": seconds, "anchor": anchor, "velocity": velocity,
                                     "box": person["box"], "appearance": person["appearance"]}
        return bool(rejected) or any(person["id"] is None for person in people)


def region_observations(person):
    """Report availability independently for each anatomical region."""
    face, pose, parts = person["face"], person["body"], person["parts"]
    h, w = parts.shape

    def in_frame(points):
        return bool(np.all(points[:, 0] >= 0) and np.all(points[:, 0] < w)
                    and np.all(points[:, 1] >= 0) and np.all(points[:, 1] < h))

    face_skin = int(np.count_nonzero(parts == 3))
    body_skin = int(np.count_nonzero(parts == 2))
    if face is None:
        face_status = ("visible-unreliable", 0) if face_skin > 12 else ("not-visible", None)
    elif not in_frame(face[list(FACE_OVAL)]):
        face_status = ("visible-unreliable", None)
    else:
        outline = polygon(parts.shape, face[list(FACE_OVAL)]) > 0
        confidence = float(np.mean(parts[outline] == 3)) if np.any(outline) else 0
        face_status = ("supported" if confidence >= .65 else "visible-unreliable", confidence)
    result = {"face": face_status, "eyes": face_status}
    result["faceSkin"] = ("supported", None) if face_skin > 20 and face is not None else face_status
    result["bodySkin"] = ("supported", None) if body_skin > 20 else ("not-visible", None)
    result["head"] = face_status
    if face_status[0] == "supported" and np.count_nonzero(parts == 1) < 12:
        result["head"] = ("visible-unreliable", face_status[1])
    if result["head"][0] != "supported":
        head = pose_head_contour(person["mask"], pose)
        if head is not None:
            result["head"] = ("supported", None)
        elif pose is not None and pose[0, 2] >= .80 and in_frame(pose[[0], :2]):
            result["head"] = ("visible-unreliable", None)
    for region, ids in (
        ("torso", [11, 12, 23, 24]), ("leftArm", [11, 13, 15]),
        ("rightArm", [12, 14, 16]), ("leftLeg", [23, 25, 27]),
        ("rightLeg", [24, 26, 28]), ("groundContact", [27, 28, 29, 30, 31, 32]),
    ):
        if pose is None:
            result[region] = ("not-visible", None)
        else:
            points = pose[ids]
            confidence = float(np.clip(np.min(points[:, 2]), 0, 1))
            if not in_frame(points[:, :2]):
                result[region] = ("not-visible", None)
            else:
                result[region] = ("supported" if confidence >= .55 else "visible-unreliable", confidence)
    return result


def analysis_size(width, height):
    # MediaPipe's float pose masks need aligned dimensions for numpy_view.
    # Keep the published grid and subsequent source mappings on that raster.
    scale = min(1, ANALYSIS_SIDE / max(width, height))
    return tuple(max(4, 4 * round(dimension * scale / 4)) for dimension in (width, height))


def initialized_db(db):
    db.executescript("""
        PRAGMA journal_mode=DELETE;
        CREATE TABLE frames(
            frame INTEGER PRIMARY KEY, pts INTEGER NOT NULL, seconds REAL NOT NULL,
            duration REAL NOT NULL, shot TEXT NOT NULL, ambiguous INTEGER NOT NULL, occupied BLOB NOT NULL
        );
        CREATE TABLE people(
            frame INTEGER NOT NULL, track TEXT NOT NULL, box TEXT NOT NULL,
            face TEXT, body TEXT, mask BLOB NOT NULL, parts BLOB NOT NULL, regions TEXT NOT NULL,
            PRIMARY KEY(frame, track)
        ) WITHOUT ROWID;
        CREATE TABLE samples(shot TEXT NOT NULL, track TEXT NOT NULL, frame INTEGER NOT NULL,
                             jpeg BLOB NOT NULL, PRIMARY KEY(shot, track)) WITHOUT ROWID;
    """)


def shot_signature(image):
    gray = cv2.cvtColor(cv2.resize(image, (48, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)
    hist = cv2.calcHist([gray], [0], None, [32], [0, 256])
    return gray, cv2.normalize(hist, hist, alpha=1, norm_type=cv2.NORM_L1)


def is_cut(previous, current):
    return (previous is not None
            and np.mean(cv2.absdiff(previous[0], current[0])) > 32
            and cv2.compareHist(previous[1], current[1], cv2.HISTCMP_BHATTACHARYYA) > .25)


def jpeg(image):
    ok, content = cv2.imencode(".jpg", cv2.cvtColor(image, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise ValueError("Could not produce a representative frame.")
    return content.tobytes()
