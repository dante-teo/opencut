"""Synthetic beauty checks. Run through video-beauty.native.spec.ts."""

from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import av
import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/media/native/beauty"))
from analysis import Tracker, active_picture, analysis_size, detect_active_picture, face_mask_owner, supplement_wide_people
from analysis import initialized_db, pack
from worker import audio_spans, recover_leg_sample, recover_pose_sample
from evaluation import applied_targets, evaluate
from quality_motion import MotionResidual
from response import VisibleResult
from controls import (
    FACE_OVAL,
    FEATURES,
    polygon,
    protection,
    sample_parameters,
    skin_edit,
)
from deformation import (
    Field,
    build_geometry,
    extend_with_fixed_wrist,
    ground_anchor,
    pose_head_contour,
    profile_head_contour,
)
from background import (
    align_background,
    continue_deep_background,
    corroborated_background,
    reconstruct_background,
    register_portrait_background,
    verified_background_area,
)
from contours import (
    guided_contour,
    infer_head_contour,
    observed_head_background,
    refine_contour,
    restore_vacated_limb_edges,
    temporal_arm_skin,
    transfer_limb_edges,
    transfer_portrait_hair_edges,
    transfer_smooth_portrait_edges,
)
from effects import (
    assemble_shape_pins,
    body_geometry_window,
    choose_shape_pins,
    destination_points,
    geometry_at_source_resolution,
    geometry_edit,
    head_lift_clearance,
    portrait_backoff,
    remap_geometry,
    retained_shape_strength,
    shape_strength_improves,
)


def subject():
    height, width = 360, 320
    shape = (height, width)
    face = np.repeat([[160, 79]], 478, axis=0).astype(np.float32)
    for ordinal, index in enumerate(FACE_OVAL):
        angle = ordinal * np.pi * 2 / len(FACE_OVAL)
        face[index] = [160 + 33 * np.sin(angle), 80 - 37 * np.cos(angle)]
    points = {
        1: (160, 85),
        33: (135, 73), 133: (152, 74), 159: (143, 71), 145: (143, 76),
        362: (168, 74), 263: (185, 73), 386: (177, 71), 374: (177, 76),
        9: (160, 52), 107: (139, 59), 168: (160, 75),
        48: (149, 93), 2: (160, 98), 278: (171, 93), 336: (181, 59),
        61: (148, 100), 291: (172, 100), 17: (160, 109),
    }
    for index, location in points.items():
        face[index] = location
    pose = np.repeat([[160, 90, 1]], 33, axis=0).astype(np.float32)
    for index, xy in {
        11: (137, 122), 12: (183, 122), 13: (115, 166), 14: (205, 165),
        15: (101, 203), 16: (217, 196), 23: (138, 207), 24: (182, 207),
        25: (133, 260), 26: (184, 259), 27: (135, 318), 28: (188, 319),
        29: (135, 323), 30: (188, 323), 31: (131, 328), 32: (194, 327),
    }.items():
        pose[index, :2] = xy
    person = np.zeros(shape, np.uint8)
    cv2.ellipse(person, (160, 75), (38, 47), 0, 0, 360, 255, -1)
    cv2.fillConvexPoly(person, np.int32([[139, 106], [181, 106], [190, 207], [131, 207]]), 255)
    for a, b in [(11, 13), (12, 14), (13, 15), (14, 16), (23, 25),
                 (24, 26), (25, 27), (26, 28), (27, 31), (28, 32)]:
        cv2.line(person, tuple(pose[a, :2].astype(int)), tuple(pose[b, :2].astype(int)), 255, 17)
    parts = np.where(person, 4, 0).astype(np.uint8)
    parts[(person != 0) & (np.indices(shape)[0] < 115)] = 1
    parts[polygon(shape, face[list(FACE_OVAL)]) != 0] = 3
    person[parts == 3] = 255
    y, x = np.indices(shape)
    rgb = np.stack([171 + ((x + y) % 5), 118 + (x % 7), 104 + (y % 5)], axis=-1).astype(np.uint8)
    rgb[(y < 77) & (x > 146) & (x < 174) & (parts == 3), 0] += 24
    rgb[person == 0] = [41, 54, 61]
    rgb[:, 22] = [215, 221, 224]
    return rgb, person, parts, face, pose


class BeautyEffects(unittest.TestCase):
    def setUp(self):
        self.rgb, self.person, self.parts, self.face, self.pose = subject()
        self.protected = self.person < 0
        self.plate = self.rgb.copy()
        self.plate[self.person > 0] = [41, 54, 61]
        self.policy = {"invalidGeometry": "attenuate", "unreliableReconstruction": "attenuate"}

    def test_each_geometry_changes_pixels_and_preserves_background_line(self):
        samples = {
            "faceSlim": (99, 141),
            "headReduce": (48, 161),
            "eyeEnlarge": (74, 148),
            "bodySlim": (158, 175),
            "waistSlim": (175, 173),
            "legSlim": (284, 138),
            "legLength": (149, 160),
            "armSlim": (182, 117),
            "armLength": (182, 110),
        }
        for effect, coordinate in samples.items():
            with self.subTest(effect=effect):
                field = Field(self.person.shape)
                details = build_geometry(field, self.person, self.parts, self.face, self.pose, {effect: .45})
                self.assertGreater(details[effect][0], 0)
                midpoint = np.array(coordinate)
                region = tuple(slice(point - 5, point + 6) for point in midpoint)
                self.assertGreater(np.abs(field.dx[region]).max() + np.abs(field.dy[region]).max(), .04)
                output, diagnostics, metrics = geometry_edit(
                    self.rgb, self.rgb, self.person, self.parts, self.face, self.pose,
                    self.protected, [(self.plate, self.protected)], {effect: .45}, self.policy,
                )
                self.assertGreater(diagnostics[effect][0], 0, diagnostics[effect])
                self.assertGreater(np.count_nonzero(output != self.rgb), 8)
                np.testing.assert_array_equal(output[:, 22], self.rgb[:, 22])
                if effect in ("headReduce", "armLength", "legLength"):
                    self.assertGreater(metrics["measurements"][effect][1], 0)

    def test_combined_face_edits_keep_full_strength_with_verified_background(self):
        values = {"faceSlim": .32, "headReduce": .32, "eyeEnlarge": .32}
        output, diagnostics, metrics = geometry_edit(
            self.rgb, self.rgb, self.person, self.parts, self.face, self.pose,
            self.protected, [(self.plate, self.protected)], values, self.policy,
        )
        self.assertEqual(diagnostics, {name: (value, None) for name, value in values.items()})
        self.assertGreater(metrics["measurements"]["headReduce"][1], 0)
        self.assertGreater(metrics["temporalPixels"], 0)
        for region in (np.s_[63:83, 130:187], np.s_[88:112, 128:151]):
            self.assertGreater(np.count_nonzero(output[region] != self.rgb[region]), 8)
        np.testing.assert_array_equal(output[:, 22], self.rgb[:, 22])

    def test_combined_portrait_uses_original_context_only_if_the_edit_improves(self):
        values = {"faceSlim": .15, "headReduce": .12, "eyeEnlarge": .1}
        unchanged = {name: (value, None) for name, value in values.items()}
        limited = unchanged | {"headReduce": (.05, "partially-protected-contour")}
        edited = self.rgb.copy()
        baseline = (self.rgb, limited, {"measurements": {"headReduce": ("contraction", .02)}})
        for eye_strength, should_use in ((.10, True), (.07, False)):
            with self.subTest(eye_strength=eye_strength):
                candidate = (edited, unchanged | {"eyeEnlarge": (eye_strength, None)},
                             {"measurements": {"headReduce": ("contraction", 1.30)}})
                with patch("effects.geometry_at_source_resolution", return_value=baseline), \
                        patch("effects.remap_geometry", return_value=candidate):
                    result = geometry_edit(
                        self.rgb, self.rgb, self.person, self.parts, self.face, self.pose,
                        self.protected, [], values, self.policy, background_context=[(self.plate, self.protected)],
                    )
                self.assertIs(result, candidate if should_use else baseline)

    def test_portrait_retries_reuse_only_matching_occupancy(self):
        values = {"headReduce": .3, "faceSlim": .3}
        limited = self.rgb, {name: (.1, "geometry-constraint") for name in values}, {}
        references = [(self.plate, self.protected)]
        for changed in (False, True):
            masks = [self.protected.copy(), self.protected.copy()]
            masks[1][0, 0] ^= changed

            def retry(*args, register_background, **kwargs):
                register_background(self.rgb, masks.pop(0), references)
                return limited

            with self.subTest(changed=changed), patch("effects.geometry_at_source_resolution", return_value=limited), \
                    patch("effects.remap_geometry", side_effect=retry), \
                    patch("effects.register_portrait_background", return_value=[]) as registration:
                geometry_edit(self.rgb, self.rgb, self.person, self.parts, self.face, self.pose,
                              self.protected, [], values, self.policy, background_context=references)
                self.assertEqual(registration.call_count, 2 if changed else 1)

    def test_portrait_contour_retry_composes_with_preceding_skin_edits(self):
        strengths = {"faceSlim": .32, "headReduce": .32, "eyeEnlarge": .32}
        inputs = (self.rgb, self.rgb, self.person, self.parts, self.face, self.pose,
                  self.protected, [(self.plate, self.protected)])
        expected, outcomes, _ = remap_geometry(*inputs, strengths, self.policy, separate_pins=True)
        actual, combined, _ = remap_geometry(
            *inputs, strengths | {"skinSmooth": .2}, self.policy, separate_pins=True,
        )
        self.assertEqual(combined, outcomes)
        self.assertEqual(set(combined), set(strengths))
        np.testing.assert_array_equal(actual, expected)

    def test_near_blink_is_not_counted_as_eye_enlargement_in_a_combined_edit(self):
        face = self.face.copy()
        for upper, lower in ((159, 145), (386, 374)):
            center = (face[upper] + face[lower]) / 2
            face[upper], face[lower] = center - [0, 1.12], center + [0, 1.12]
        output, diagnostics, _ = geometry_edit(
            self.rgb, self.rgb, self.person, self.parts, face, self.pose,
            self.protected, [(self.plate, self.protected)], {"faceSlim": .32, "eyeEnlarge": .10},
            self.policy,
        )
        self.assertEqual(diagnostics["faceSlim"], (.32, None))
        self.assertEqual(diagnostics["eyeEnlarge"], (0, "eyes-closed-or-unreliable"))
        self.assertGreater(np.count_nonzero(output != self.rgb), 8)

    def test_pose_head_contour_without_face_detail_preserves_neck(self):
        shape = (160, 180)
        person = np.zeros(shape, np.uint8)
        cv2.ellipse(person, (90, 36), (14, 18), 0, 0, 360, 255, -1)
        cv2.rectangle(person, (84, 44), (96, 68), 255, -1)
        cv2.fillConvexPoly(person, np.int32([[68, 71], [84, 65], [96, 65], [112, 71],
                                             [109, 130], [71, 130]]), 255)
        pose = np.zeros((33, 3), np.float32)
        for index, x, y in ((0, 90, 38), (2, 95, 35), (5, 85, 35),
                            (7, 101, 39), (8, 79, 39), (11, 111, 71), (12, 69, 71)):
            pose[index] = [x, y, 1]
        self.assertIsNotNone(pose_head_contour(person, pose))
        field = Field(shape)
        parts = np.zeros(shape, np.uint8)
        result = build_geometry(field, person, parts, None, pose, {"headReduce": .40, "faceSlim": .40})
        self.assertEqual(result["headReduce"], (.40, None))
        self.assertEqual(result["faceSlim"], (0, "region-not-visible"))
        self.assertLess(field.dy[20, 90], 0)
        self.assertEqual(field.dy[65, 90], 0)
        # A connected foreground crossing the crown must not become part of
        # the whole-head warp.
        cv2.line(person, (90, 36), (90, 0), 255, 5)
        self.assertIsNone(pose_head_contour(person, pose))

    def test_profile_head_keeps_connected_hair_and_the_real_neck(self):
        person = np.zeros((150, 190), np.uint8)
        cv2.ellipse(person, (75, 45), (17, 22), 0, 0, 360, 255, -1)
        cv2.rectangle(person, (72, 56), (82, 84), 255, -1)
        cv2.rectangle(person, (64, 80), (104, 140), 255, -1)
        cv2.line(person, (86, 37), (107, 24), 108, 4)
        cv2.ellipse(person, (110, 24), (6, 7), 0, 0, 360, 120, -1)
        pose = np.zeros((33, 3), np.float32)
        for index, x, y in ((0, 60, 43), (2, 66, 39), (5, 68, 39),
                            (7, 75, 42), (8, 72, 42), (11, 77, 80),
                            (12, 91, 80), (23, 77, 122), (24, 91, 122)):
            pose[index] = [x, y, 1]
        contour = profile_head_contour(person, pose)
        self.assertIsNotNone(contour)
        neck, _, _, _, region, component = contour
        contour_mask = person < 0
        contour_mask[region] = component
        self.assertTrue(contour_mask[24, 110])
        self.assertFalse(contour_mask[90, 80])
        self.assertTrue(72 <= neck[0] <= 82)
        pose[0, 0] = 74
        self.assertIsNone(profile_head_contour(person, pose))

    def test_cropped_head_reports_visibility_independently_of_face_slimming(self):
        crop = np.s_[40:, :]
        person, parts = self.person[crop], self.parts[crop]
        face = self.face - np.array([0, 40], np.float32)
        field = Field(person.shape)
        diagnostics = build_geometry(field, person, parts, face, None, {"headReduce": .15, "faceSlim": .18})
        self.assertEqual(diagnostics["headReduce"], (0, "head-contour-outside-frame"))
        self.assertEqual(diagnostics["faceSlim"], (.18, None))

    def test_neighbor_head_guides_still_require_a_current_visible_edge(self):
        shape = (140, 160)
        person = np.zeros(shape, np.uint8)
        cv2.ellipse(person, (80, 44), (14, 16), 0, 0, 360, 255, -1)
        cv2.rectangle(person, (75, 51), (85, 73), 255, -1)
        cv2.rectangle(person, (60, 73), (100, 134), 255, -1)
        pose = np.zeros((33, 3), np.float32)
        for index, x, y in ((0, 80, 46), (2, 85, 43), (5, 75, 43), (7, 91, 44),
                            (8, 69, 44), (11, 100, 76), (12, 60, 76)):
            pose[index] = [x, y, 1]
        contour = pose_head_contour(person, pose)
        self.assertIsNotNone(contour)
        region, component = contour[-2:]
        origin = np.array([region[1].start, region[0].start], np.float32)
        guide = (component.astype(np.uint8), origin, pose[0, :2], 40, 1.)
        image = np.full((*shape, 3), 198, np.uint8)
        image[person > 0] = (85, 52, 43)
        joined_mask = person.copy()
        cv2.line(joined_mask, (80, 44), (80, 4), 255, 5)
        protected = np.zeros(shape, bool)
        self.assertIsNone(pose_head_contour(joined_mask, pose))
        self.assertIsNotNone(infer_head_contour(image, joined_mask, pose, protected, [guide, guide]))
        reduced = cv2.resize(component.astype(np.uint8), None, fx=.5, fy=.5, interpolation=cv2.INTER_NEAREST)
        small_guide = (reduced, origin * .5, pose[0, :2] * .5, 20, 2.)
        self.assertIsNotNone(infer_head_contour(image, joined_mask, pose, protected, [small_guide, small_guide]))
        ambiguous = np.full_like(image, 140)
        self.assertIsNone(infer_head_contour(ambiguous, joined_mask, pose, protected, [guide, guide]))
        self.assertIsNone(infer_head_contour(image, joined_mask, pose, protected, [guide]))

    def test_visible_logo_pixels_do_not_enter_the_head_matte(self):
        backing = np.full_like(self.rgb, 174)
        backing[40:110, 202:207] = (24, 39, 75)
        image = backing.copy()
        image[self.person != 0] = self.rgb[self.person != 0]
        leaked = self.person.copy()
        leaked[61:88, 203:207] = 255
        blocked = self.person != 0
        proof = observed_head_background(
            image, leaked, None, self.face, self.protected,
            [(backing, np.zeros_like(blocked)), (backing.copy(), np.zeros_like(blocked))],
        )
        self.assertIsNotNone(proof)
        alpha = refine_contour(image, leaked, self.protected, known_background=proof)
        self.assertEqual(alpha[72, 205], 0)
        self.assertGreater(alpha[75, 160], .95)

    def test_reference_validation_is_local_to_the_revealed_gap(self):
        image = np.full((60, 120, 3), 120, np.uint8)
        reference = image.copy()
        reference[:, 60:] = 155
        requested = np.zeros(image.shape[:2], bool)
        requested[30, (23, 93)] = True
        collar = ~requested
        supported = verified_background_area(image, reference, requested, collar)
        self.assertTrue(supported[30, 23])
        self.assertFalse(supported[30, 93])

    def test_deeper_reconstruction_requires_agreeing_models_and_holdout(self):
        shape = (80, 120)
        y, x = np.indices(shape)
        backing = np.full((*shape, 3), 132, np.uint8)
        known = x < 55
        missing = (x >= 60) & (x <= 66) & (y >= 29) & (y <= 51)
        snapshot = backing.copy()
        snapshot[~known] = [172, 55, 40]
        distances = cv2.distanceTransform((~known).astype(np.uint8), cv2.DIST_L2, 5)
        result, resolved = continue_deep_background(snapshot, missing, known, distances)
        self.assertTrue(np.all(resolved[missing]))
        np.testing.assert_array_less(np.abs(result[missing].astype(int) - backing[missing]), 5)
        alternating = snapshot.copy()
        alternating[known & ((y % 4) < 2)] = 225
        _, textured = continue_deep_background(alternating, missing, known, distances)
        self.assertFalse(textured[missing].any())

    def test_thin_limb_trimaps_retain_observed_tips_and_respect_protection(self):
        shape = (100, 120)
        person = np.zeros(shape, np.uint8)
        cv2.rectangle(person, (48, 18), (82, 70), 255, -1)
        cv2.rectangle(person, (20, 37), (48, 43), 255, -1)
        cv2.rectangle(person, (61, 70), (67, 92), 255, -1)
        image = np.full((*shape, 3), 181, np.uint8)
        image[(person != 0) & (np.indices(shape)[1] > 35)] = (48, 52, 58)
        image[70:] = 181
        pose = np.zeros((33, 3), np.float32)
        for index, x, y in ((13, 44, 40), (15, 25, 40), (17, 22, 40),
                            (25, 64, 67), (27, 64, 84), (31, 64, 90)):
            pose[index] = [x, y, 1]
        protected = np.zeros(shape, bool)
        protected[39:42, 21:23] = True
        alpha = refine_contour(image, person, protected, pose)
        self.assertGreater(alpha[40, 25], .95)
        self.assertGreater(alpha[84, 64], .95)
        self.assertEqual(alpha[40, 22], 0)
        self.assertEqual(alpha[35, 20], 0)

    def test_visible_elbow_can_lengthen_with_shoulder_and_wrist_anchored(self):
        shape = (130, 180)
        joints = np.array([[78, 64], [50, 72], [33, 47]], np.float32)
        person = np.zeros(shape, np.uint8)
        cv2.polylines(person, [joints.astype(np.int32)], False, 255, 13)
        parts = np.where(person > 0, 2, 0).astype(np.uint8)
        stationary = np.ones(shape, np.float32)
        field = Field(shape)
        self.assertTrue(extend_with_fixed_wrist(field, joints, person, parts, stationary, .25))
        result = destination_points(field, joints)
        np.testing.assert_array_equal(result[[0, 2]], joints[[0, 2]])
        source_lengths = np.linalg.norm(np.diff(joints, axis=0), axis=1)
        changed_lengths = np.linalg.norm(np.diff(result, axis=0), axis=1)
        self.assertTrue(np.all(changed_lengths > source_lengths))
        # The projected centerline may miss a narrow arm edge by a pixel.
        _, elbow, wrist = joints
        for fraction in (.20, .35):
            x, y = np.rint(elbow + fraction * (wrist - elbow)).astype(int)
            person[y, x] = 0
        self.assertTrue(extend_with_fixed_wrist(Field(shape), joints, person, parts, stationary, .25))
        parts[72, 50] = 5
        self.assertFalse(extend_with_fixed_wrist(Field(shape), joints, person, parts, stationary, .25))

    def test_full_arm_extension_can_preserve_the_wrist_and_shoulder(self):
        joints = np.array([[90, 190], [117, 215], [144, 184]], np.float32)
        person = np.zeros((324, 324), np.uint8)
        cv2.polylines(person, [joints.astype(np.int32)], False, 255, 12)
        parts = np.where(person > 0, 2, 0).astype(np.uint8)
        field = Field(person.shape)
        self.assertTrue(extend_with_fixed_wrist(
            field, joints, person, parts, np.ones(person.shape, np.float32),
            .25, full_length=True,
        ))
        self.assertTrue(field.valid(1))
        moved = destination_points(field, joints)
        np.testing.assert_allclose(moved[[0, 2]], joints[[0, 2]], atol=.02)
        length = np.linalg.norm(np.diff(joints, axis=0), axis=1).sum()
        after = np.linalg.norm(np.diff(moved, axis=0), axis=1).sum()
        self.assertAlmostEqual(after, length * 1.03, delta=.035)

    def test_wrist_contact_requires_same_skin_on_both_sides_of_frame(self):
        parts = self.parts.copy()
        x, y = np.rint(self.pose[13, :2]).astype(int)
        kinds = self.parts.copy()
        kinds[y, x] = 2
        parts[y, x] = 5
        history = [(True, self.rgb, self.person, kinds, self.pose)]
        recovered = temporal_arm_skin(self.rgb, self.person, parts, self.pose, self.protected, history)
        self.assertEqual(recovered[y, x], 5)
        incompatible = self.rgb.copy()
        incompatible[y, x] = [0, 0, 240]
        result = temporal_arm_skin(self.rgb, self.person, parts, self.pose, self.protected, [
            *history, (False, incompatible, self.person, kinds, self.pose),
        ])
        self.assertEqual(result[y, x], 5)
        proven = temporal_arm_skin(self.rgb, self.person, parts, self.pose, self.protected, [
            *history, (False, self.rgb, self.person, kinds, self.pose),
        ])
        self.assertEqual(proven[y, x], 2)

    def test_arm_preserves_accessory_near_independently_visible_wrist(self):
        pose = self.pose.copy()
        parts = self.parts.copy()
        for index, x, y in ((15, 101, 203), (17, 100, 204), (19, 101, 205), (21, 100, 203)):
            pose[index] = [x, y, 1]
            parts[y, x] = 2
        parts[198:208, 104:114] = 5
        field = Field(self.person.shape)
        result = build_geometry(field, self.person, parts, None, pose, {"armLength": .45})
        self.assertEqual(result["armLength"], (.45, "arm-contact-protected"))
        self.assertEqual(field.dx[205, 108], 0)
        self.assertEqual(field.dy[205, 108], 0)
        parts[203, 101] = 5
        result = build_geometry(Field(self.person.shape), self.person, parts, None, pose, {"armLength": .45})
        self.assertEqual(result["armLength"], (.45, "partial-arm-coverage"))

    def test_pose_recovery_requires_both_neighbors_and_current_support(self):
        failing = self.pose.copy()
        failing[11:13, :2] = [160, 125]
        failing[15, 2] = .50
        before = self.pose.copy()
        after = self.pose.copy()
        before[:, 0] -= 2
        after[:, 0] += 2
        recovered = recover_pose_sample(failing, before, after, .5, self.person)
        np.testing.assert_array_equal(recovered[[11, 12, 15]], self.pose[[11, 12, 15]])
        disagreement = after.copy()
        disagreement[[11, 12]] = disagreement[[12, 11]]
        unsupported = self.person.copy()
        unsupported[115:128] = 0
        for other, mask in [(disagreement, self.person), (after, unsupported)]:
            current = recover_pose_sample(failing, before, other, .5, mask)
            np.testing.assert_array_equal(current[[11, 12]], failing[[11, 12]])

    def test_limb_edge_transfer_keeps_the_observed_blur(self):
        shape = (70, 90)
        yy, xx = np.indices(shape)
        backing = np.full((*shape, 3), 185, np.uint8)
        image = backing.copy()
        image[27:38, 35:51] = (75, 46, 38)
        image[38:40, 38:48] = (128, 116, 109)
        person = np.zeros(shape, np.uint8)
        person[27:38, 35:51] = 255
        pose = np.zeros((33, 3), np.float32)
        pose[13] = [51, 31, 1]
        pose[15] = [44, 35, 1]
        pose[17] = [41, 36, 1]
        moved = (xx >= 30) & (xx <= 58) & (yy >= 20) & (yy < 45)
        x = xx.astype(np.float32)
        y = yy.astype(np.float32) + moved * 2
        y = y.astype(np.float32)
        alpha = np.zeros(shape, np.float32)
        obvious_halo = image.copy()
        obvious_halo[36, 43] = (243, 242, 241)
        clear = np.zeros(shape, bool)
        output = transfer_limb_edges(image, obvious_halo, person, pose, alpha, moved, x, y, [(backing, clear)])
        np.testing.assert_array_equal(output[36, 43], image[38, 43])
        np.testing.assert_array_equal(output[~moved], image[~moved])
        occluded = clear.copy()
        occluded[33:41, 40:46] = True
        blocked = transfer_limb_edges(image, obvious_halo, person, pose, alpha, moved, x, y, [(backing, occluded)])
        np.testing.assert_array_equal(blocked[36, 43], obvious_halo[36, 43])

    def test_motion_residual_measures_a_pulse_after_aligning_source_motion(self):
        rng = np.random.default_rng(11)
        original = rng.integers(45, 195, (96, 112), dtype=np.uint8)
        translated = cv2.warpAffine(original, np.float32([[1, 0, 3], [0, 1, 2]]), (112, 96))
        mask = np.zeros(original.shape, np.uint8)
        mask[12:-12, 12:-12] = 1
        stable = np.full((*original.shape, 3), 5, np.int16)
        residual = MotionResidual()
        residual.observe(0, "shot-1", 0, "fixed", (original, stable, {"skin": mask}))
        residual.observe(1, "shot-1", .04, "fixed", (translated, stable, {"skin": mask}))
        measured = residual.result()["regions"]["skin"]
        self.assertGreater(measured["samples"], 10)
        self.assertEqual(measured["p95ChannelDelta"], 0)
        residual.observe(2, "shot-1", .08, "fixed", (translated, stable + 4, {"skin": mask}))
        self.assertEqual(residual.result()["regions"]["skin"]["worst"]["channelDelta"], 4)
        residual.observe(3, "shot-2", .12, "fixed", (translated, stable + 20, {"skin": mask}))
        self.assertEqual(residual.result()["regions"]["skin"]["transitions"], 2)

    def test_decoded_audio_spans_ignore_packet_sizes_and_preserve_real_gaps(self):
        clock = Fraction(1, 1000)

        def audio_frames(observations):
            frames = [SimpleNamespace(pts=pts, time_base=clock, samples=samples, sample_rate=48_000)
                      for pts, samples in observations]
            return SimpleNamespace(decode=lambda _: iter(frames))

        before = audio_frames([(3, 240), (8, 480), (31, 480)])
        after = audio_frames([(3, 720), (31, 240), (36, 240)])
        stream = SimpleNamespace(start_time=None, duration=None, time_base=clock)
        spans = list(audio_spans(before, stream, clock))
        self.assertEqual(spans, list(audio_spans(after, stream, clock)))
        self.assertEqual(spans, [(Fraction(3, 1000), 720, 48_000), (Fraction(31, 1000), 480, 48_000)])
        stream.start_time, stream.duration = 3, 33
        trimmed = list(audio_spans(before, stream, clock))
        self.assertEqual(trimmed[-1], (Fraction(31, 1000), 240, 48_000))

    def test_analysis_grid_aligns_portrait_mask_dimensions(self):
        self.assertEqual(analysis_size(640, 480), (512, 384))
        self.assertEqual(analysis_size(432, 820), (268, 512))
        self.assertTrue(all(dimension % 4 == 0 for dimension in analysis_size(611, 807)))

    def test_face_fallback_requires_one_nonconflicting_visible_person(self):
        candidate = {"mask": self.person, "body": self.pose.copy(), "face": None}
        candidate["body"][0, 2] = 0
        empty = {**candidate, "mask": np.zeros_like(self.person)}
        self.assertEqual(face_mask_owner(self.face, [empty, candidate], self.person.shape), 1)
        self.assertIsNone(face_mask_owner(self.face, [candidate, candidate], self.person.shape))
        candidate["body"][0] = [12, 12, .9]
        self.assertIsNone(face_mask_owner(self.face, [candidate], self.person.shape))

    def test_protection_evidence_excludes_only_controls_actually_applied(self):
        intervals = [
            {"target": {"shotId": "shot-1", "trackId": "person-1"}, "status": "applied",
             "intervals": [{"startFrame": 1, "endFrame": 3}]},
            {"target": {"shotId": "shot-1", "trackId": "person-2"}, "status": "bypassed",
             "intervals": [{"startFrame": 0, "endFrame": 4}]},
            {"target": {"shotId": "shot-2", "trackId": "person-1"}, "status": "attenuated",
             "intervals": [{"startFrame": 3, "endFrame": 5}]},
        ]
        self.assertEqual(applied_targets(intervals, 2, 5), [
            {("shot-1", "person-1")}, {("shot-2", "person-1")}, {("shot-2", "person-1")},
        ])

    def test_active_picture_detection_keeps_full_frame_coordinates(self):
        source = np.zeros((120, 200, 3), np.uint8)
        source[20:100, 24:176] = (78, 95, 121)
        preview = cv2.resize(source, (100, 60), interpolation=cv2.INTER_AREA)
        bounds = active_picture(preview)
        self.assertEqual(bounds, (12, 10, 88, 50))
        self.assertIsNone(active_picture(np.zeros_like(preview)))

        def fake_detect(image):
            h, w = image.shape[:2]
            mask = np.zeros((h, w), np.uint8)
            mask[12:53, 16:73] = 255
            part = np.where(mask, 2, 0).astype(np.uint8)
            landmarks = np.array([[16., 12., .95]], np.float32)
            person = {"mask": mask, "parts": part, "box": np.array([16, 12, 72, 52], np.float32),
                      "face": None, "body": landmarks}
            return [person], np.zeros_like(mask)

        detector = SimpleNamespace(detect=fake_detect)
        people, unresolved = detect_active_picture(detector, source, preview, bounds)
        self.assertEqual(unresolved.shape, (60, 100))
        np.testing.assert_allclose(people[0]["box"], [20, 16, 48, 36])
        np.testing.assert_allclose(people[0]["body"], [[20, 16, .95]])
        self.assertFalse(people[0]["mask"][:10].any())
        self.assertEqual(people[0]["parts"][20, 30], 2)

        preview[:, 0] = 90
        self.assertIsNone(detect_active_picture(detector, source, preview, bounds))

    def test_wide_detection_recovers_a_distinct_person_and_rejects_a_clipped_duplicate(self):
        image = np.full((120, 200, 3), 140, np.uint8)
        primary = {"box": np.array([20, 9, 48, 52], np.float32), "face": None, "body": None}

        def fake_detect(crop):
            height, width = crop.shape[:2]
            self.assertEqual(width % 4, 0)
            self.assertEqual(height % 4, 0)

            def person(x, right):
                mask = np.zeros((height, width), np.uint8)
                mask[12:104, x:right] = 255
                pose = np.repeat([[float((x + right) / 2), 45., .92]], 33, axis=0).astype(np.float32)
                return {"mask": mask, "parts": mask.copy(),
                        "box": np.array([x, 12, right - 1, 103], np.float32),
                        "face": None, "body": pose}

            return [person(0, 30), person(40, 73)], np.zeros((height, width), np.uint8)

        people = [primary]
        supplement_wide_people(SimpleNamespace(detect=fake_detect), image, (60, 100), people)
        self.assertEqual(len(people), 2)
        self.assertIs(people[0], primary)
        self.assertGreater(people[1]["box"][0], 50)
        self.assertFalse(people[1]["mask"][:, :50].any())

    def test_large_combined_failure_keeps_a_verified_head_only_edit(self):
        person = np.broadcast_to(np.uint8(0), (2000, 2000))
        values = {"headReduce": .15, "legLength": .25}
        combined = (self.rgb, {
            "headReduce": (0, "background-reconstruction-unreliable"),
            "legLength": (0, "background-reconstruction-unreliable"),
        }, {})
        picture = self.rgb.copy()
        picture[70, 160] = self.plate[70, 160]
        head_only = (picture, {"headReduce": (.08, "partially-protected-contour")}, {
            "measurements": {"headReduce": ("head-silhouette-area-reduction-percent", .9)},
        })
        with patch("effects.geometry_at_source_resolution", side_effect=[combined, head_only]) as render:
            result, outcomes, metrics = geometry_edit(
                self.rgb, self.rgb, person, self.parts, self.face, self.pose,
                self.protected, [], values, self.policy,
            )
        self.assertEqual(render.call_args_list[1].args[8], {"headReduce": .15})
        self.assertIs(result, picture)
        self.assertEqual(outcomes, {**head_only[1], "legLength": (0, "combined-shape-conflict")})
        self.assertEqual(metrics, head_only[2])

    def test_large_shape_strength_ignores_pins_on_a_different_body_region(self):
        width, height = 1600, 1344
        small_h, small_w = self.person.shape
        origin = np.array([630, 455])
        left, top = origin
        region = np.s_[top:top + small_h, left:left + small_w]
        person = np.zeros((height, width), np.uint8)
        parts = np.zeros_like(person)
        person[region], parts[region] = self.person, self.parts
        pose = self.pose.copy()
        pose[:, :2] += origin
        clearance = np.ones(person.shape, np.float32)
        clearance[top + 220:, :] = 0
        kept, pinned = retained_shape_strength(
            "headReduce", .25, person, parts, self.face + origin, pose, None, clearance, None,
        )
        self.assertEqual(kept, 1)
        self.assertFalse(pinned)

    def test_vertical_working_pictures_use_a_padded_geometry_window(self):
        shape = (2200, 1500)
        picture = np.zeros((*shape, 3), np.uint8)
        person = np.zeros(shape, np.uint8)
        person[960:1320, 580:900] = self.person
        seen = {}

        def record_window(image, _original, matte, *_args, frame_edge, hair_context):
            seen.update(shape=matte.shape, frame_edge=frame_edge, hair_context=hair_context)
            return image, {"legLength": (0, "region-not-visible")}, {}

        with patch("effects.recover_combined_geometry", side_effect=record_window):
            geometry_at_source_resolution(
                picture, picture, person, np.zeros(shape, np.uint8), None, None,
                np.zeros(shape, bool), [], {"legLength": .25}, self.policy, None, (), (),
            )
        self.assertLess(np.prod(seen["shape"]), person.size // 3)
        self.assertEqual(seen["frame_edge"], min(shape) * .035)
        self.assertEqual(seen["hair_context"], [])

    def test_large_background_alignment_returns_source_pixel_offsets(self):
        generator = np.random.default_rng(15)
        image = generator.integers(0, 256, (1100, 1440), np.uint8)
        image = cv2.GaussianBlur(image, (5, 5), 1)
        shifted = cv2.warpAffine(image, np.float32([[1, 0, 4], [0, 1, -3]]), image.shape[::-1])
        blocked = np.zeros(image.shape, bool)
        transform = align_background(image, blocked, shifted, blocked)
        self.assertIsNotNone(transform)
        np.testing.assert_allclose(transform[:, 2], [-4, 3], atol=.25)

    def test_tiled_guided_contour_matches_a_single_full_filter(self):
        generator = np.random.default_rng(19)
        picture = generator.integers(0, 256, (73, 91, 3), np.uint8)
        matte = generator.random((73, 91), dtype=np.float32)
        full = guided_contour(picture, matte, tile=120)
        tiled = guided_contour(picture, matte, tile=24)
        np.testing.assert_allclose(tiled, full, atol=2e-5, rtol=1e-5)

    def test_large_field_validates_the_transition_between_row_bands(self):
        field = Field((1280, 1024))
        field.dy[1:-1, 1:-1] = .2
        self.assertTrue(field.valid(1))
        boundary = 1_000_000 // 1024 - 1
        field.dy[boundary, 1:-1] = .9
        self.assertFalse(field.valid(1))

    def test_high_resolution_body_edit_preserves_pixels_outside_its_working_window(self):
        height, width = 2160, 3840
        x, y = 1680, 890
        small_h, small_w = self.person.shape
        subject_region = np.s_[y:y + small_h, x:x + small_w]
        source = np.empty((height, width, 3), np.uint8)
        source[:] = (41, 54, 61)
        source[subject_region] = self.rgb
        source[:, 300] = (215, 221, 224)
        person = np.zeros((height, width), np.uint8)
        parts = np.zeros_like(person)
        person[subject_region] = self.person
        parts[subject_region] = self.parts
        protected = np.zeros(person.shape, bool)
        plate = source.copy()
        plate[person != 0] = (41, 54, 61)
        pose = self.pose.copy()
        pose[:, :2] += [x, y]
        values = {"headReduce": .2, "armLength": .25, "legLength": .25}
        window = body_geometry_window(person, values)
        self.assertIsNotNone(window)
        result, details, metrics = geometry_edit(
            source, source, person, parts, self.face + [x, y], pose, protected,
            [(plate, protected)], values, self.policy,
        )
        self.assertTrue(all(details[name][0] > 0 for name in values), details)
        self.assertTrue(all(metrics["measurements"][name][1] > 0 for name in values))
        changed = np.any(source != result, axis=2)
        self.assertTrue(changed.any())
        changed[window] = False
        self.assertFalse(changed.any())

    def test_background_support_requires_two_agreeing_clear_observations(self):
        scene = np.full((48, 64, 3), 68, np.uint8)
        scene[:, 28:33] = (180, 204, 216)
        known = np.ones(scene.shape[:2], bool)
        known[17:30, 25:36] = False
        current = scene.copy()
        current[~known] = (140, 65, 49)
        clear = np.zeros_like(known)
        covered = clear.copy()
        covered[:, 31] = True
        changed = scene.copy()
        changed[21:24, 27:30] = (35, 190, 80)
        neighborhood = np.ones_like(known)
        _, one = corroborated_background(current, neighborhood, known, [(scene, clear)])
        self.assertFalse(one.any())
        backing, two = corroborated_background(current, neighborhood, known, [(scene, clear), (changed, covered)])
        self.assertFalse(two[22, 28])
        self.assertFalse(two[22, 31])
        self.assertFalse(np.any(two & known))
        self.assertTrue(two[19, 28])
        np.testing.assert_array_equal(backing[19, 28], scene[19, 28])
        unrelated = np.full_like(scene, 25)
        _, wrong_scene = corroborated_background(
            current, neighborhood, known, [(unrelated, clear), (unrelated, clear)],
        )
        self.assertFalse(wrong_scene.any())

    def test_visible_background_only_pins_motion_that_would_cover_it(self):
        alpha = np.zeros((30, 32), np.float32)
        alpha[:, 16:] = 1
        coordinates = np.array([[12, 14]], np.float32)
        vectors = np.array([[[5, 0]], [[0, 2]], [[1, 0]]], np.float32)
        chosen = choose_shape_pins(alpha, coordinates, vectors, keep_background=True)
        np.testing.assert_array_equal(chosen, [1])

    def test_stronger_retry_can_restore_a_missing_measured_effect(self):
        image = np.zeros((4, 4, 3), np.uint8)
        values = {"headReduce": .2, "armLength": .25}
        before = image, {"headReduce": (0, "region-not-visible"), "armLength": (.2, None)}, {
            "measurements": {"armLength": ("extension", 2.0)},
        }
        after = image, {"headReduce": (.1, None), "armLength": (.21, None)}, {
            "measurements": {"headReduce": ("contraction", 1.0), "armLength": ("extension", 2.0)},
        }
        self.assertTrue(shape_strength_improves(values, before, after, image, None))
        after[2]["measurements"]["armLength"] = ("extension", 1.9)
        self.assertFalse(shape_strength_improves(values, before, after, image, None))

    def test_unknown_background_only_pins_the_motion_that_would_reveal_it(self):
        alpha = np.zeros((30, 30), np.float32)
        alpha[:, :13] = 1
        alpha[17:, :] = .5
        coordinates = np.array([[12, 7], [12, 22]], np.float32)
        vectors = np.array([
            [[2, 0], [2, 0]],
            [[0, 2], [0, 2]],
            [[0, 1], [0, 1]],
        ], np.float32)
        result = choose_shape_pins(alpha, coordinates, vectors)
        np.testing.assert_array_equal(result, [1, 7])

    def test_pinned_head_lift_is_even_and_never_releases_the_background(self):
        clearance = np.ones((110, 100), np.float32)
        clearance[25:28, 40:42] = .2
        region = np.s_[20:45, 39:61]
        component = np.ones((25, 22), bool)
        head = (None, None, None, None, 25, None, (region, component))
        adjusted = head_lift_clearance(head, clearance)
        np.testing.assert_array_equal(adjusted[region], np.full(component.shape, .2, np.float32))
        self.assertEqual(adjusted[88, 45], 1)
        self.assertTrue(np.all(adjusted <= clearance))
        self.assertGreater(adjusted[56, 48], .2)

    def test_local_displacement_is_sampled_after_the_leg_lift(self):
        field = Field((20, 20))
        field.dx[8:11, 5:15] = 1
        lift = np.zeros_like(field.dx)
        lift[:14, :] = 3
        field.compose_lift(lift)
        self.assertEqual(field.dx[6, 10], 1)
        self.assertEqual(field.dx[9, 10], 0)
        self.assertEqual(field.dy[6, 10], 3)
        self.assertEqual(field.dy[17, 10], 0)

    def test_ankle_drift_is_corrected_only_with_a_connected_visible_shoe(self):
        matte = np.zeros((160, 100), np.uint8)
        cv2.rectangle(matte, (46, 111), (61, 137), 255, -1)
        pose = np.zeros((33, 3), np.float32)
        pose[[25, 27, 29, 31]] = [[43, 10, .95], [43, 111, .95], [46, 14, .95], [55, 135, .95]]
        self.assertEqual(ground_anchor(matte, pose, 25, 27, [29, 31]), 111)
        matte[119:123] = 0
        self.assertIsNone(ground_anchor(matte, pose, 25, 27, [29, 31]))
        pose[27, 0] = 36
        self.assertIsNone(ground_anchor(matte, pose, 25, 27, [29, 31]))

    def test_wide_ankle_shift_requires_a_dense_observed_path(self):
        matte = np.zeros((220, 130), np.uint8)
        cv2.rectangle(matte, (51, 156), (69, 197), 255, -1)
        pose = np.zeros((33, 3), np.float32)
        pose[[25, 27, 29, 31]] = [[43, 5, .95], [43, 156, .95], [20, 188, .95], [60, 192, .95]]
        self.assertEqual(ground_anchor(matte, pose, 25, 27, [29, 31]), 156)
        matte[175, :] = 0
        self.assertIsNone(ground_anchor(matte, pose, 25, 27, [29, 31]))

    def test_visible_result_requires_sustained_substantial_effect(self):
        # These measurements describe a 640-pixel-wide review image.
        def result(weaker=(), missing=(), width=640, missing_other=False):
            response = VisibleResult(width)
            effect = {"id": "look"}
            for frame in range(20):
                measurement = (None if frame in missing else
                               ("length", 1.9, 1.5) if frame in weaker else
                               ("length", 3., 3.))
                response.observe(effect, "legLength", .25, .19, "attenuated",
                                 frame, frame / 30, (frame + 1) / 30, measurement)
            if missing_other:
                response.observe(effect, "eyeEnlarge", .1, 0, "bypassed", 0, 0, 1/30, None)
            return response.result([])

        self.assertEqual(result(weaker=(4, 5))["status"], "passed")
        self.assertEqual(result(weaker=(4, 5, 6))["status"], "failed")
        self.assertEqual(result(missing=(4,))["controls"][0]["missingFrames"], 1)
        self.assertEqual(result(missing=(4,))["status"], "failed")
        self.assertEqual(result(width=1280)["status"], "failed")
        self.assertEqual(result(missing_other=True)["status"], "failed")
        self.assertEqual(VisibleResult(640).result([])["status"], "failed")

    def test_high_strength_needs_a_larger_visible_change(self):
        def result(requested):
            response = VisibleResult(640)
            response.observe({"id": "look"}, "legLength", requested, requested * .45, "attenuated",
                             0, 0, 1/25, ("length", 3., 2.5))
            return response.result([])["status"]

        self.assertEqual(result(.30), "passed")
        self.assertEqual(result(.80), "failed")

    def test_foreshortened_arm_fringe_needs_two_clear_observations(self):
        image = np.full((96, 120, 3), 190, np.uint8)
        person = np.zeros(image.shape[:2], np.uint8)
        person[28:48, 61:78] = 255
        pose = np.zeros((33, 3), np.float32)
        pose[[11, 13, 15]] = ((22, 31, 1), (72, 36, 1), (72, 38, 1))
        mask = np.zeros_like(person, bool)
        reference = image.copy(), mask
        image[50, 71:76] = 157
        mask = mask.copy()
        mask[50, 72] = True
        args = (image, image, person, np.zeros_like(person, np.float32), pose, mask,
                np.full(person.shape, 10, np.float32))
        np.testing.assert_array_equal(restore_vacated_limb_edges(*args, [reference]), image)
        recovered = restore_vacated_limb_edges(*args, [reference, (reference[0].copy(), reference[1])])
        np.testing.assert_array_equal(recovered[50, 72], image[50, 72])
        np.testing.assert_array_equal(recovered[50, 73], reference[0][50, 73])

    def test_portrait_background_registers_visible_texture_and_preserves_exclusions(self):
        rng = np.random.default_rng(733)
        texture = rng.integers(30, 195, (160, 180, 3), dtype=np.uint8)
        image = cv2.GaussianBlur(texture, (5, 5), 0)
        shift = np.float32([[1, 0, 3], [0, 1, -2]])
        previous = cv2.warpAffine(image + 6, shift, (180, 160))
        hidden = np.zeros(image.shape[:2], bool)
        hidden[50:75, 70:92] = True
        previous[hidden] = 255
        current_mask = np.zeros_like(hidden)
        registered = register_portrait_background(image, current_mask, [(previous, hidden)])
        self.assertEqual(len(registered), 1)
        aligned, unavailable = registered[0]
        self.assertTrue(unavailable[60, 80])
        np.testing.assert_allclose(aligned[98:118, 98:118], image[98:118, 98:118], atol=2)
        self.assertFalse(register_portrait_background(image, ~current_mask, [(previous, hidden)]))

    def test_portrait_backoff_selects_a_valid_scale_above_coarse_retry(self):
        field = Field((40, 45))
        field.dx = np.maximum(0., 7. - np.abs(field.x - 22) * .88).astype(np.float32)
        before = field.dx.copy()
        self.assertFalse(field.valid(1.))
        scale = portrait_backoff(field, 0, 0)
        self.assertGreater(scale, .36)
        self.assertTrue(field.valid(scale))
        np.testing.assert_array_equal(field.dx, before)

    def test_visible_result_does_not_hide_a_long_contiguous_dip(self):
        response = VisibleResult(640)
        for frame in range(100):
            percentage = 1.8 if 30 <= frame <= 34 else 3.2
            response.observe({"id": "look"}, "legLength", .25, .22, "attenuated",
                             frame, frame / 30, (frame + 1) / 30, ("length", percentage, 3.))
        control = response.result([])["controls"][0]
        self.assertEqual(control["visibleFrames"], 95)
        self.assertEqual(control["firstBelowFloorFrame"], 30)
        self.assertEqual(control["status"], "failed")

    def test_widened_portrait_transition_leaves_the_pin_and_far_warp_intact(self):
        field = Field((72, 72))
        cheek = Field((72, 72))
        cheek.dx.fill(4.)
        pins = np.zeros((72, 72), bool)
        pins[:, 36] = True
        args = (field, {"faceSlim": cheek}, {"faceSlim": pins}, 1., None, 12)
        default = assemble_shape_pins(*args)["faceSlim"]
        wider = assemble_shape_pins(*args, transition=1.5)["faceSlim"]
        self.assertEqual(wider[20, 36], 0.)
        self.assertLess(wider[20, 44], default[20, 44])
        self.assertEqual(wider[20, 65], 1.)

    def test_separate_portrait_pins_prefer_preserving_the_cheek_edit(self):
        alpha = np.zeros((10, 10), np.float32)
        alpha[:, :6] = 1
        coordinates = np.array([[3., 4.]], np.float32)
        vectors = np.array([[[2., 0.]], [[1., 0.]]], np.float32)
        choice = choose_shape_pins(alpha, coordinates, vectors, priority=np.array([1., 4.]))
        self.assertEqual(choice.tolist(), [1])

    def test_ankle_pose_recovers_only_with_a_visible_shoe_across_a_side_swap(self):
        pose = np.zeros((33, 3), np.float32)
        near_leg, far_leg = [25, 27, 29, 31], [26, 28, 30, 32]
        pose[near_leg] = [[40, y, .95] for y in (105, 166, 177, 188)]
        pose[far_leg] = [[90, y, .95] for y in (105, 166, 177, 188)]
        before = pose.copy()
        before[near_leg + far_leg] = pose[far_leg + near_leg]
        current = pose.copy()
        current[far_leg, 0] += 12
        matte = np.zeros((220, 140), np.uint8)
        matte[101:200, 34:47] = matte[101:200, 84:97] = 255
        recovered = recover_leg_sample(current, matte, 1, (before, matte), (pose, matte), .5)
        np.testing.assert_array_equal(recovered, pose)
        missing = matte.copy()
        missing[150:, 84:97] = 0
        self.assertIs(recover_leg_sample(current, missing, 1, (before, matte), (pose, matte), .5), current)

    def test_eye_closure_and_leg_length_ground_anchor(self):
        closed = self.face.copy()
        closed[[159, 145]] = closed[33]
        closed[[386, 374]] = closed[362]
        field = Field(self.person.shape)
        detail = build_geometry(field, self.person, self.parts, closed, self.pose, {"eyeEnlarge": 1})
        self.assertEqual(detail["eyeEnlarge"], (0, "eyes-closed-or-unreliable"))
        self.assertFalse(field.dx.any())
        field = Field(self.person.shape)
        build_geometry(field, self.person, self.parts, self.face, self.pose, {"legLength": .5})
        self.assertGreater(field.dy[150, 160], 1)
        self.assertEqual(field.dy[325, 135], 0)
        ankles = self.pose[[27, 28], :2]
        np.testing.assert_array_equal(destination_points(field, ankles), ankles)

    def test_arm_length_moves_the_wrist_and_keeps_the_shoulder_fixed(self):
        field = Field(self.person.shape)
        report = build_geometry(field, self.person, self.parts, self.face, self.pose, {"armLength": .55})
        self.assertEqual(report["armLength"], (.55, None))
        positions = self.pose[[11, 13, 15], :2]
        destination = destination_points(field, positions)
        np.testing.assert_array_equal(destination[0], positions[0])
        for source_length, changed_length in zip(
            np.linalg.norm(np.diff(positions, axis=0), axis=1),
            np.linalg.norm(np.diff(destination, axis=0), axis=1),
        ):
            self.assertGreater(changed_length, source_length)
        lost = self.pose.copy()
        lost[[15, 16], 2] = 0
        missing = build_geometry(Field(self.person.shape), self.person, self.parts, self.face, lost, {"armLength": .55})
        self.assertEqual(missing["armLength"], (0, "arm-chain-occluded-or-unreliable"))

    def test_independent_skin_controls_and_protected_features(self):
        effect = {"skinScope": "face"}
        for name in ("skinSmooth", "skinBrighten", "warmth", "tint", "saturation", "facialRedness"):
            with self.subTest(name=name):
                result, report = skin_edit(self.rgb, self.person, self.parts, self.face, self.protected, effect, {name: .8})
                self.assertGreater(report[name][0], 0)
                self.assertGreater(np.count_nonzero(result != self.rgb), 3)
                np.testing.assert_array_equal(result[self.parts != 3], self.rgb[self.parts != 3])
                for feature in FEATURES[:2]:
                    region = polygon(self.person.shape, self.face[list(feature)]) > 0
                    np.testing.assert_array_equal(result[region], self.rgb[region])
        for function in (skin_edit,):
            result, report = function(self.rgb, self.person, self.parts, self.face, self.protected, effect, {})
            self.assertIs(result, self.rgb)
            self.assertEqual(report, {})

    def test_color_change_does_not_hide_bypassed_smoothing(self):
        image = np.full((64, 64, 3), (144, 101, 83), np.uint8)
        person = np.full(image.shape[:2], 255, np.uint8)
        parts = np.full(person.shape, 2, np.uint8)
        inputs = (image, person, parts, None, np.zeros(person.shape, bool),
                  {"skinScope": "visible-target-skin"})
        brightened, _ = skin_edit(*inputs, {"skinBrighten": .45})
        output, coverage = skin_edit(*inputs, {"skinBrighten": .45, "skinSmooth": .8})
        np.testing.assert_array_equal(output, brightened)
        self.assertEqual(coverage["skinBrighten"], (.45, None))
        self.assertEqual(coverage["skinSmooth"], (0, "no-measurable-pixel-change"))

    def test_comparison_preserves_long_last_frame_of_selected_range(self):
        clock = Fraction(1, 24)
        intervals = ((0, 1), (1, 1), (2, 1), (3, 30), (33, 2))
        image = np.full((40, 64, 3), 120, np.uint8)
        with TemporaryDirectory() as directory:
            base = Path(directory)
            source, analysis = base / "source.mov", base / "analysis.sqlite"
            with av.open(source, "w", options={"video_track_timescale": "24", "movie_timescale": "24"}) as output:
                stream = output.add_stream("png", rate=24)
                stream.width, stream.height, stream.pix_fmt = 64, 40, "rgb24"
                stream.time_base = stream.codec_context.time_base = clock
                for pts, ticks in intervals:
                    frame = av.VideoFrame.from_ndarray(image, format="rgb24")
                    frame.pts, frame.time_base = pts, clock
                    for packet in stream.encode(frame):
                        packet.duration = ticks
                        output.mux(packet)
                for packet in stream.encode(None):
                    output.mux(packet)
            with sqlite3.connect(analysis) as db:
                initialized_db(db)
                empty = pack(np.zeros(image.shape[:2], np.uint8))
                db.executemany("INSERT INTO frames VALUES (?, ?, ?, ?, ?, ?, ?)", [
                    (i, pts, float(pts * clock), float(ticks * clock), "shot-1", 0, empty)
                    for i, (pts, ticks) in enumerate(intervals)
                ])
            result = evaluate({
                "source": str(source), "processed": str(source), "analysis": str(analysis),
                "destination": directory, "report": {"intervals": [], "quality": {"geometryBounds": "not-evaluated"}},
                "width": 64, "height": 40, "stream": 0, "rotation": 0, "matrix": 1, "range": "JPEG",
                "timeScale": 24, "startFrame": 1, "endFrame": 4,
            })
            self.assertEqual(result["checks"]["sourceTiming"], "passed")
            with av.open(result["comparisonVideo"]) as video:
                stream = video.streams.video[0]
                self.assertEqual(stream.duration * stream.time_base, 32 * clock)
                self.assertEqual([frame.pts * frame.time_base for frame in video.decode(stream)], [0, clock, 2 * clock])

    def test_redness_absence_preserves_exact_working_pixels(self):
        neutral = self.rgb.copy()
        neutral[self.parts == 3] = [144, 101, 83]
        result, report = skin_edit(
            neutral, self.person, self.parts, self.face, self.protected,
            {"skinScope": "face"}, {"facialRedness": .5},
        )
        np.testing.assert_array_equal(result, neutral)
        self.assertEqual(report["facialRedness"], (0, "redness-not-present"))

    def test_all_skin_does_not_include_misclassified_facial_features(self):
        parts = self.parts.copy()
        eye = polygon(self.person.shape, self.face[list(FEATURES[0])]) != 0
        parts[eye] = 2
        result, report = skin_edit(
            self.rgb, self.person, parts, self.face, self.protected,
            {"skinScope": "visible-target-skin"}, {"skinBrighten": .5},
        )
        self.assertTrue(report["skinBrighten"][0])
        np.testing.assert_array_equal(result[eye], self.rgb[eye])

    def test_smooth_backdrop_transports_soft_edge_and_preserves_protection(self):
        shape = (80, 100)
        image = np.full((*shape, 3), [170, 121, 42], np.uint8)
        person = np.zeros(shape, np.uint8)
        person[30:65, 30:70] = 255
        image[30:65, 30:70] = [31, 24, 20]
        image[28, 40:60] = [125, 90, 38]
        field = Field(shape)
        x, y = field.x, field.y - 3
        alpha = cv2.remap(person.astype(np.float32) / 255, x, y, cv2.INTER_LINEAR)
        head = (np.array([50., 60.]), np.array([1., 0.]), 35, 50)
        protected = np.zeros(shape, bool)
        protected[28, 45] = True
        result = transfer_smooth_portrait_edges(image, image, person, protected, alpha, x, y, head)
        np.testing.assert_array_equal(result[28, 48], image[25, 48])
        np.testing.assert_array_equal(result[31, 48], image[28, 48])
        np.testing.assert_array_equal(result[28, 45], image[28, 45])
        np.testing.assert_array_equal(result[31, 45], image[31, 45])

    def test_hair_fringe_moves_with_verified_background_and_keeps_protected_pixels(self):
        shape = (80, 100)
        backdrop = np.full((*shape, 3), [190, 145, 60], np.uint8)
        image = backdrop.copy()
        image[24:46, 35:65] = [78, 44, 30]
        image[20, 42:58] = [155, 116, 50]
        original_alpha = np.zeros(shape, np.float32)
        original_alpha[24:46, 35:65] = 1
        parts = original_alpha.astype(np.uint8)
        protected = np.zeros(shape, bool)
        protected[20, 43] = True
        field = Field(shape)
        field.dy[18:26, 39:61] = -2
        x, y = field.x, field.y + field.dy
        moved = field.dy != 0
        warped_alpha = cv2.remap(original_alpha, x, y, cv2.INTER_LINEAR)
        head = (np.array([50., 60.]), np.array([1., 0.]), 32, 46)
        witnesses = [(backdrop, np.zeros(shape, bool))] * 3
        result = transfer_portrait_hair_edges(
            image, image, original_alpha, warped_alpha, parts, protected, head, moved, x, y, witnesses,
        )
        np.testing.assert_array_equal(result[20, 50], backdrop[20, 50])
        np.testing.assert_array_equal(result[22, 50], image[20, 50])
        np.testing.assert_array_equal(result[20, 43], image[20, 43])
        np.testing.assert_array_equal(result[22, 43], image[22, 43])
        np.testing.assert_array_equal(result[~moved], image[~moved])
        # The root enters a formerly opaque pixel as the crown contracts.
        image[22, 50] = [72, 48, 35]
        original_alpha[22, 50] = .65
        warped_alpha = cv2.remap(original_alpha, x, y, cv2.INTER_LINEAR)
        registered = transfer_portrait_hair_edges(
            image, image, original_alpha, warped_alpha, parts, protected, head, moved, x, y, witnesses,
            registered=True,
        )
        np.testing.assert_array_equal(registered[24, 50], image[22, 50])
        np.testing.assert_array_equal(registered[20, 43], image[20, 43])
        conflict = backdrop.copy()
        conflict[19:24, 46:54] = [230, 180, 110]
        mismatched = [(backdrop, witnesses[0][1]), (conflict, witnesses[0][1])]
        result = transfer_portrait_hair_edges(
            image, image, original_alpha, warped_alpha, parts, protected, head, moved, x, y, mismatched,
        )
        np.testing.assert_array_equal(result[20:23, 50], image[20:23, 50])

    def test_protection_and_background_reconstruction_ground_truth(self):
        shape = (80, 100)
        y, x = np.indices(shape)
        plate = np.stack([x * 2, y + 48, x + y], axis=-1).astype(np.uint8)
        plate[:, 49:51] = 250
        occupied = np.zeros(shape, bool)
        occupied[15:45, 40:60] = True
        hole = np.zeros(shape, bool)
        hole[15:19, 44:55] = True
        source = plate.copy()
        source[occupied] = [145, 25, 16]
        recovered, temporal, _, missing = reconstruct_background(
            source, hole, occupied, [(plate, np.zeros(shape, bool))],
        )
        self.assertFalse(missing.any())
        self.assertEqual(temporal, int(hole.sum()))
        self.assertLessEqual(np.abs(plate[hole].astype(int) - recovered[hole]).mean(), 4)
        huge = occupied.copy()
        _, _, _, missing = reconstruct_background(source, huge, occupied, [])
        self.assertTrue(missing.any())
        regions = [{"x": .4, "y": .2, "width": .3, "height": .2,
                    "timeRange": {"start": 1, "end": 2}}]
        self.assertFalse(protection(shape, regions, .99).any())
        self.assertTrue(protection(shape, regions, 1).any())
        self.assertFalse(protection(shape, regions, 2).any())

    def test_keyframes(self):
        effect = {"parameters": {"legSlim": .15}, "interpolation": "linear",
                  "keyframes": {"legSlim": [{"time": 1, "value": 0}, {"time": 2, "value": .6}]}}
        self.assertEqual(sample_parameters(effect, .8), {})
        self.assertAlmostEqual(sample_parameters(effect, 1.5)["legSlim"], .3)
        self.assertAlmostEqual(sample_parameters(effect, 4)["legSlim"], .6)
        effect["interpolation"] = "hold"
        self.assertEqual(sample_parameters(effect, 1.5), {})

    def test_tracker_continues_through_order_change_and_rejects_ambiguity(self):
        def observation(x, bin_index):
            histogram = np.zeros((16, 8), np.float32)
            histogram.flat[bin_index] = 1
            return {"box": np.array([x - 10, 30, x + 10, 90], np.float32),
                    "body": None, "face": None, "appearance": histogram}

        tracker = Tracker(200, 120)
        first = [observation(75, 0), observation(125, 2)]
        self.assertFalse(tracker.assign(first, 0))
        second = [observation(113, 2), observation(88, 0)]
        self.assertFalse(tracker.assign(second, .04))
        self.assertEqual([item["id"] for item in second], ["person-2", "person-1"])
        third = [observation(89, 0), observation(90, 0)]
        self.assertTrue(tracker.assign(third, .08))
        self.assertEqual([item["id"] for item in third], [None, None])
        reentry = [observation(90, 0)]
        self.assertFalse(tracker.assign(reentry, .42))
        self.assertEqual(reentry[0]["id"], "person-3")


if __name__ == "__main__":
    unittest.main()
