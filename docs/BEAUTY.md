# Beauty and body reshaping

OpenCut applies beauty as the first recipe on a timed video asset. Its CPU worker
runs locally without a display server. The recipe keeps the original media and
makes a lossless RGB MOV for OpenCut's normal preview and export paths.

## Set up the CPU backend

The tested host is Apple Silicon macOS with Python 3.12 and FFmpeg 9.1. MediaPipe
also publishes Linux x86-64 wheels. Linux execution needs independent
qualification. The backend is CPU-only. OpenCut checks installed versions and
model hashes and never downloads them during processing.

Install into an isolated Python environment and download the three pinned model
files. FFmpeg and ffprobe must be on PATH.

```sh
python3.12 -m venv ./beauty-python
./beauty-python/bin/python -m pip install \
  'mediapipe==0.10.35' 'opencv-contrib-python==4.12.0.88' \
  'numpy==2.2.6' 'av==16.1.0'
mkdir -p ./beauty-models
origin=https://storage.googleapis.com/mediapipe-models
curl -fsSL "$origin/face_landmarker/face_landmarker/float16/1/face_landmarker.task" -o ./beauty-models/face.task
curl -fsSL "$origin/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task" -o ./beauty-models/pose.task
curl -fsSL "$origin/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite" -o ./beauty-models/parts.tflite
export OPENCUT_BEAUTY_PYTHON="$PWD/beauty-python/bin/python"
export OPENCUT_BEAUTY_MODELS="$PWD/beauty-models"
opencut beauty preflight --json
```

The CLI archive includes the worker sources and requires a separately installed
Python environment and pinned model files. The models are Apache-2.0 and come
with their own model cards. [Face Landmarker](https://huggingface.co/litert-community/MediaPipe-FaceLandmarker)
[Pose Landmarker Full](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Full)
[Selfie Multiclass](https://huggingface.co/litert-community/MediaPipe-ImageSegmenter-Selfie-Multiclass)

## Analyze and bind a target

```sh
opencut beauty capabilities --json
opencut beauty analyze source.mp4 --recipe-cache ./cache --json > analysis.json
analysis_id=$(jq -r .id analysis.json)
opencut beauty inspect "$analysis_id" --recipe-cache ./cache --output ./targets --json
```

The analysis receipt lists shots, ambiguous intervals, tracks, detected face,
pose and skin spans, representative source frames, the analysis dimensions,
the source fingerprint, the decoder settings and model hashes. Each region's
coverage includes supported, missing and unreliable observations with
confidence ranges where the model supplies a score. The frame
database contains per-frame PTS, person masks, semantic parts, and landmarks.
Track IDs are specific to the analysis and shot. They identify a subject within
footage. Use the sample and interval together to select the intended subject.
A region span indicates available observations. An effect still checks
visibility and protection before applying changes.

To correct a short track association, supply `--edit corrections.json` to
`beauty analyze`. Each entry has `frame` (zero-based source ordinal),
`shotId`, `trackId` and `anchor` (a normalized x/y point near the target's
torso or face). Each correction must uniquely match a visible detection and
a previously observed track in the same shot. After 0.22 seconds without a
trusted observation, automatic reacquisition uses a new track. An explicit
correction can restore the earlier track at a clear frame after an occlusion.
`correctionsApplied` lists accepted anchors and identifies reattachments.
Merged person masks and unresolved faces pause assignment until the people
can be identified again. Corrections create a new analysis ID. Resolve its
targets again.

When the edited file is an excerpt, supply the uncut original to add verified
background observations without changing the excerpt's render clock or
pixels as input. Use the original timestamp at which the excerpt starts.

```sh
opencut beauty analyze excerpt.mp4 --context-source original.mov --context-start 0.6 \
  --recipe-cache ./cache --json > analysis.json
```

The excerpt must contain a single shot and at least three identifiable frames.
Both inputs must have the same decoded dimensions, up to one million pixels per
frame. The matching interval must fall within the first 180 seconds of the
original. The worker verifies foreground motion and visible background at
distributed timestamps and retains observations from the matching shot.
The analysis ID includes the original's fingerprint and offset. The original
recording is read during analysis. Rendering uses the cached observations and
the unchanged excerpt. The strength and visual acceptance policies still apply.

## Write the recipe

```ts
{
  type: 'beauty',
  analysisRef,
  acceptance: 'allow-limitations',
  effects: [{
    type: 'beauty',
    id: 'portrait-main',
    version: 1,
    target: { assetId: 'picture', shotId: 'shot-1', trackId: 'person-1' },
    timeRange: { start: 0, end: 2 },
    parameters: { faceSlim: 0.16, skinSmooth: 0.2 },
    keyframes: {
      faceSlim: [{ time: 0, value: 0 }, { time: 0.4, value: 0.16 }],
    },
    protectedRegions: [{ x: 0.8, y: 0, width: 0.2, height: 0.12 }],
    failurePolicy: { trackingUncertain: 'bypass' },
  }],
}
```

Use the asset ID that owns the recipe. Set one effect per person for independent
settings. Use non-overlapping intervals for multiple effects on the same person.
Use separate asset aliases pointing to the original file when two placements
need different looks. Both can reference the same analysis receipt.

`enabled` defaults to true. Each control defaults to zero. The neutral path
uses the original source directly and requires no receipt or inference runtime.
Active targets must resolve against the current source bytes and worker version.

| Parameter                      | Range   | Operation                                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------------------------- |
| `faceSlim`                     | 0 to 1  | Narrows sides of the lower face around a fixed central core                       |
| `headReduce`                   | 0 to 1  | Moves the observed head contour toward a fixed neck attachment                    |
| `eyeEnlarge`                   | 0 to 1  | Expands an open eye within the protected face interior                            |
| `bodySlim`                     | 0 to 1  | Narrows the torso and contributes a smaller amount to supported limbs             |
| `waistSlim`                    | 0 to 1  | Narrows the shoulder-to-hip waist estimate with arm protection                    |
| `legSlim`, `armSlim`           | 0 to 1  | Narrow visible segments across the local bone axis, tapering at joints            |
| `armLength`                    | 0 to 1  | Extends each visible shoulder–elbow–wrist chain along its bone directions         |
| `legLength`                    | 0 to 1  | Lengthens legs in supported upright stances while anchoring the feet              |
| `skinSmooth`                   | 0 to 1  | Blends in an edge-aware filtered detail layer inside the skin mask                |
| `skinBrighten`                 | 0 to 1  | Lifts skin midtone lightness with a rolloff at both ends                          |
| `warmth`, `tint`, `saturation` | −1 to 1 | Adjust warmth, tint and chroma independently                                      |
| `facialRedness`                | 0 to 1  | Reduces local red excess in the central face while avoiding outer cheeks and lips |

Head reduction uses facial landmarks and semantic hair where available. In
wide shots it can use a connected person silhouette around a reliable pose.
The silhouette must bound the crown and sides before it can drive the warp.
Face and eye controls still require detailed facial landmarks and semantic
support. When verified original-shot context is available, the worker
can keep cheek narrowing and head contraction active independently around
unresolved background. If the transition around a protected point is too
abrupt, the worker widens it and repeats the same geometry check. It takes
an alternate deformation only when both measured changes improve or stay
equal and no requested control loses effective strength.

Strengths are artistic controls. Arm lengthening keeps the shoulder attachment
fixed and extends the two arm segments from it. It uses a shared elbow transform
so the segments stay joined. One-sided coverage, insufficient space and unclear
wrist or elbow boundaries are reported explicitly. If a nearby accessory
overlaps the edit, the worker can hold it in place when the wrist and hand
remain independently visible. When neither full arm edit is available, a
supported elbow bend can lengthen with the shoulder and wrist anchored.
The report shows reduced coverage when the bend reaches only part of the
requested length.

Leg lengthening requires both knees and ankles, plus a visible heel or toe on
each side. It anchors the observed feet at their individual screen positions and
moves the pelvis and upper body upward within available headroom. For a small
ankle landmark offset, the selected person's mask must show a continuous shoe
between the corrected point and an observed heel or toe. Larger corrections
within the bounded search require a connection checked at pixel spacing.
A single inconsistent ankle chain on a high-resolution leg edit can be
recovered from the neighboring observations of the same person. The estimate
must be supported by the visible knee and shoe in the current frame, even
when the detector swaps leg labels. The worker can use verified background
from elsewhere in the same shot and pin unresolved areas locally before
retrying the warp. It attenuates
or fails when headroom is insufficient and bypasses unsuitable stances or missing
foot geometry. Torso and local adjustments combine with diminishing gain. Eye
enlargement remains independent of lower-confidence contour reconstruction.

Use `skinScope: 'face'` (default) or `'visible-target-skin'`.
`facialRedness` always uses the face scope. Masks and feature exclusions
protect eyes, eyebrows, lips, nostrils, hair and clothing. Author protected
rectangles in normalized oriented source coordinates. An optional
`timeRange` on a rectangle uses the same clock as the effect. Protection for
other detected people and overlapping face occluders is always active.

### Time and color

Analysis uses the original presentation timestamps with the first decoded
picture at source time zero. All authored beauty times are seconds from that
origin. Start is inclusive and end is exclusive. Keyframes override the
corresponding base parameter, clamp to their endpoints, and use `linear`
(default) or `hold` interpolation. Analysis coordinates are top-left oriented
pixels on a surface whose longest edge is at most 512. Protected regions are
normalized against the full oriented source.

The worker processes the full source once so a seek or short preview gets the
same surrounding observations as a full export. Later asset recipes and the
regular timeline apply trim, source windows, speed, crop, scale, rotation,
transitions and grade. A repeated segment samples the same source-stage
pixels. Beauty uses symmetric context up to two observations per side within
0.12 seconds for landmarks and masks. Reconstruction can consult three
additional observations from the previous 0.75 seconds in the same shot.
The worker aligns local observations before smoothing and keeps
the current eye geometry for blinks. Shot boundaries reset association and
block temporal lookup. At four megapixels and above, a missed detection can
retry inside the confirmed black bars of a shot. The retry maps observations
back to full-frame coordinates, and delivery retains the original framing.
For wide high-resolution shots, the worker can also look for a second
person in an overlapping region when the primary pass detects one person.

Supported inputs are progressive, right-angle oriented, square-pixel, 8-bit SDR
video, up to 8,294,400 pixels. Supported tags are BT.709, BT.601 and sRGB.
The worker honors the input matrix and range while unpacking to full-range
encoded RGB. Smoothing works in encoded RGB. The color controls use OpenCV's
sRGB-based CIELAB conversion. The worker retains source primaries and transfer
tags in the lossless intermediate and uses OpenCut's normal SDR delivery profile
for the encoded export. HDR, alpha and other unsupported color configurations
fail preflight on the source. The worker checks decoded frame count, each PTS
and frame duration before publishing a recipe output.

### Protection and failure policy

Skin processing precedes geometry. The worker combines local inverse fields,
composes them with any leg lift, and samples the geometry once. Displacement
feathers out at protected pixels.
A sampled Jacobian must stay within 0.55 to 1.65 and the inverse field must
remain inside the input. Reshaping reconstructs newly exposed pixels using
nearby background observations whose alignment passes a photometric check.
The worker can repair an isolated bad pose sample when the preceding and
following samples agree and the current silhouette supports the joints.
For a missed head outline, nearby outlines from the same track can guide a
new segmentation. The current frame must still show a matching contour.
A clear side profile can also use the outline supported by the visible
eyes, ears, and neck. Connected hair follows the head through that outline.
Stationary background detail confirmed by two other source frames is kept
out of the moving head matte.
For a blurred hand or foot, it preserves the observed soft image edge when
the source and destination background can both be checked in another frame.
For narrow gaps it can estimate a smooth surface from nearby observed colors,
or continue texture only when it can reproduce a withheld band of visible
background. Deeper patches require two prediction methods to agree and both
must reproduce a nearby visible sample. Independently fitted surfaces must
agree at their joins. The worker pins unverified contour patches, feathers
displacement around them, and rechecks the resulting field before rendering.
Reported strengths incorporate the share of each shape deformation retained
after this feathering. If a combined edit loses its measured head or arm
response, the worker can retry with an even lift around the head or a reduced
leg lift. It keeps the retry only when it restores an intended change and
retains every previously measured control. For combined head, arm and leg
edits in a bounded frame, it can also pin the motion that would reveal
unverified background while preserving the other controls. The retry can
use a wider, memory-bounded window of verified observations from the same
shot to recover newly exposed pixels. Use the original recording with a
timeline trim when possible. Sparse, seekable frames from farther along the
same shot can help reconstruct an edited excerpt. These frames still need to
match the visible background. When two
clear frames agree, that detail can also support reconstruction of an
adjacent gap under the same spatial checks. The worker can also retry with
pins limited to verified background edges that the stronger warp would
disturb. A retry must retain the measured strength of each previously applied
control and preserve verified edges around the head.
For combined cheek and head edits, fine hair at the contour can move with
the head when matching source observations verify the background at both
its original and destination positions.
For a textured backdrop, the worker can align wall details across context
frames and match their lighting using visible background. This lets it carry
fine strands through to their roots while preserving brick or mortar beside
them. For high-resolution leg lifts, it can recover a soft outline left at
the old position of an arm or leg when two observations agree on the newly
exposed smooth background.
The report lists reconstruction intervals, distinguishes pixels recovered from
other frames and from spatial estimates, and identifies a representative region
for each effect. The evaluator includes a matched background crop when that
frame falls within its requested interval.

`trackingUncertain` defaults to `fail` and accepts `bypass`.
`invalidGeometry` and `unreliableReconstruction` default to `attenuate`
and accept `fail`. `complete-coverage` (default) fails when a requested
interval is attenuated or bypassed. Choose `allow-limitations` only when the
caller accepts that outcome. Reports preserve the authored strength and show
effective strength ranges, source intervals, and reasons. Skin controls report
coverage individually. For example, smoothing that leaves uniform skin pixels
unchanged is bypassed even if brightening changes those same pixels. Look for
`no-measurable-pixel-change` in the interval report.

Geometry intervals with measured cheek, head, arm, or leg response include
the minimum and maximum percentage change and the sample count. The
measurements use the accepted sampling field, head matte, and landmarks. A combined edit's cheek
measurement describes the change in the rendered cheeks. Review each
requested parameter, even when the render exits zero.

Use `acceptance: 'visible-result'` when a sustained, visible reshape matters
more than reaching the exact slider value on every frame. The versioned
`cpu-beauty-visible-v2` profile measures cheek narrowing, head contraction,
and arm and leg extension in the accepted warp. It uses the same 640-pixel
maximum picture width as the side-by-side review.

| Control      | Minimum change                    | Minimum at review size |
| ------------ | --------------------------------- | ---------------------- |
| `faceSlim`   | 1.25% mean cheek-width reduction  | 1.25 pixels            |
| `headReduce` | 2% head silhouette area reduction | 1.25 diameter pixels   |
| `armLength`  | 2% mean arm-chain extension       | 2 pixels               |
| `legLength`  | 2.5% hip-to-ankle extension       | 2 pixels               |

Each measured control must meet both floors for at least 90% of its active
time. For slider values above 0.4, the floors rise linearly to twice their
listed values at maximum strength. No dip below the floors may last longer
than 125 milliseconds. Each requested frame also needs a positive measured
change above 15% of its applicable floors and at least 15% of its requested
strength. At least one measured control is required. Other active controls
still require complete coverage. The `visibleResult` report identifies the
first weak frame, the longest dip, and measured coverage by control.

This visibility profile governs effect response. Geometry checks, masking,
the outside-influence limit, and independent motion review still apply.

## Validate, preview, evaluate, and deliver

```sh
opencut beauty validate edit.video.ts --recipe-cache ./cache --json
opencut render plan edit.video.ts --recipe-cache ./cache --output final.mp4 --json
opencut preview clip edit.video.ts --from 0 --to 48 --quality quality \
  --recipe-cache ./cache --output preview.mp4 --json > preview.json
recipe_key=$(jq -r '.beauty[0].recipeKey' preview.json)
opencut beauty evaluate source.mp4 --result "$recipe_key" --from 0 --to 48 \
  --recipe-cache ./cache --output ./evidence --json > evidence.json
opencut render edit.video.ts --quality quality --recipe-cache ./cache \
  --output final.mp4 --json > final.json
```

Preview ranges count project frames. Evidence ranges count decoded source
frames and allow up to 240 frames per comparison. The comparison video shows
original on the left and processed on the right. It starts at zero and
preserves the duration of each selected source frame, including the last
frame in a variable-frame-rate excerpt. The evaluator reopens the encoded
video to verify those intervals before reporting `sourceTiming: passed`.
Independent visual acceptance still requires a separate normal-speed review.

The evaluator writes full frames and available eye, face, arm and leg crops.
The outside-influence metric requires exactly zero changed RGB pixels farther
than 14% of the source diagonal from the observed person occupancy. It reports unevaluated dimensions
explicitly. Its success covers the implemented checks only.

The evaluator also compares the high-confidence core of each detected person
without an applied control on that frame. Any changed RGB pixel in that core
fails `nonTargetPeopleUnchanged`. A shot with no observed unselected person
leaves that check unevaluated. The diagnostic counts and reports the worst
affected frames with the shot and track identifiers.

The source-motion residual aligns consecutive original frames using checked
optical-flow correspondences. It reports the sample count, frame transitions,
95th percentile and worst RGB edit difference for skin, contours and nearby
background. The measurement uses frames with constant applied controls and
skips shot changes, uncertain motion and authored strength changes. It
complements the unchanged independent visual rubric.

Use the same quality, framing, and output resolution for final-quality
comparison. For the finished MP4, use `opencut verify export` and the
source-comparison mode of `opencut review` in addition to inspecting the recipe
evidence. Review normal-speed sequences across motion, occlusion, crossings,
shot cuts and intentional strength changes. Check these independently.

- The requested person changes in the intended direction, with joints, lids,
  expression, gaze and normal proportions intact.
- Other people and foreground objects remain in front where expected.
- Hair and clothing edges, background lines and texture hold through motion.
- Skin detail, makeup, lighting and complexion remain plausible.
- Every attenuation and bypass is disclosed and acceptable for delivery.

Use at most three preview attempts per look. If a pass fails, lower the
responsible control, tighten the interval, correct the track, or add a
protection region based on the evidence. Preserve the best valid result.
Report `not-evaluated` whenever a required measurement or motion review is
missing.

The [parameterized definition](../examples/video/beauty.video.ts) supports the
`skin`, `subtle`, `portrait`, `body`, `full` and `neutral` looks. Give it a relative
`source` path, `analysisRef`, project `frameRate` and `frames`, and a
`people` array of `{ shotId, trackId, start, end, look, fadeIn }`. Add
multiple people to configure simultaneous targets. Set `fadeIn: true` for
time-varying strength. Use `allowLimitations: true` with partial visibility,
or omit it to fail on bypass. Supply normalized rectangles with `protect`
to reproduce a protection conflict. Use the example with `--params` on
validate, preview and render.

## Cache and operating limits

The analysis ID binds source bytes, the decode configuration, corrections,
platform, worker code, runtime versions and model checksums. Strength edits
reuse analysis and create a different picture recipe entry. The CLI validates
receipts and hashes before reuse. A new render checks its Python and package
versions against the analysis receipt. If the runtime differs, restore the
recorded Python and package versions or analyze again with a supported
runtime. Run analysis again and update `analysisRef` after a worker revision.

The effective memory limit is part of the render key because it controls
how many background observations the worker can use. A budget change can
rebuild the picture while reusing the existing analysis. Keep the same
`--recipe-memory-bytes` setting across render planning, preview and export
when comparing them. A cached render includes the picture and its processing
report. Interrupted work never publishes an incomplete entry. Retry the
original command to use completed work. Partial analysis and partial beauty
encodes restart. The job ID appears in command and progress JSON. Send
SIGINT or SIGTERM to cancel the foreground job.

Use `beauty inspect` to verify a cache entry and `beauty remove` with an exact
analysis ID to remove it. Removing an entry affects the cache only and can
invalidate projects that reference it. A copied package still needs access to
the original analysis cache and the configured runtime. Use the same cache
root for all commands.

Analysis streams one decode at a time. Rendering buffers the current frame
and neighboring source observations, writes one frame at a time and verifies
the intermediate before publication. On high-resolution footage, body warps
can use a padded, source-resolution window around the person. The padding
accounts for possible movement and background reconstruction. Large arm
maps and geometry checks use bounded row bands. Edge fitting uses padded
tiles at source resolution. If a combined high-resolution head, arm, and
leg warp produces no usable geometry, the renderer can retry supported upper
body or individual controls through the same checks. The report identifies
any omitted controls. Beauty inputs with at least 3,000,000 pixels per
frame, including 1440×2560 portrait footage, default to a worker limit of
up to 2 GiB. Set `--recipe-memory-bytes 4294967296` to request 4 GiB for
these inputs. The host may cap the effective limit. Tune `--recipe-temp-bytes`
and `--recipe-timeout-ms` for the workload. Inputs with dense overlaps, fine
hair or large camera moves can exceed the current
tracking, segmentation or reconstruction envelope. Model coverage, temporal
review, and visual acceptance are separate checks. Hardware and dependency
changes can change inference results.

## Require independent visual acceptance

The evaluator accepts `--notes review.json` from a separate normal-speed
review. The review records `version: 1`, `profile: "cpu-beauty-evidence-v1"`,
the exact `recipeKey`, `startFrame`, `endFrame`, `reviewer`, and
`normalSpeed: true`. Its `checks` map uses the names in
`profileSettings.requiredIndependentChecks` from the evidence. Each check is
`passed`, `failed`, `not-evaluated`, or `unsupported`. Its `findings` array
contains `check`, `frame`, `severity`, `message` and optional `shotId` and
`trackId`. Use `--require-visual` to require passing independent checks.
An unreviewed or failed gate exits nonzero.

## Measured development workloads

The initial combined-look jobs ran on an Apple M1 Max with 32 GiB RAM, Python 3.12.12 and
FFmpeg 9.1. Each workload targeted one track. Times cover the indicated CPU
worker. Render throughput excludes the normal MP4 encode. Cache sizes are for
the lossless recipe picture and analysis database. The final delivery used
software H.264 at 30 fps.

| Clip        | Source                         | Analysis | Recipe worker   | Peak analysis / recipe RSS | Analysis / picture cache |
| ----------- | ------------------------------ | -------- | --------------- | -------------------------- | ------------------------ |
| Interview   | 640×360, 59.94 fps, 120 frames | 22.2 s   | 19.2 s, 6.2 fps | 375 / 262 MiB              | 4.83 / 14.1 MiB          |
| Gym motion  | 640×360, 30 fps, 60 frames     | 11.0 s   | 11.9 s, 5.0 fps | 371 / 224 MiB              | 1.11 / 10.1 MiB          |
| CDC excerpt | 320×240, 30 fps, 59 frames     | 4.1 s    | 1.8 s, 33 fps   | 363 / 150 MiB              | 0.42 / 3.73 MiB          |

The cropped CDC job applied effects on 14 source frames. The bound track and
required foot landmarks are absent in parts of the clip, so strict coverage
fails. A separate wide CDC excerpt demonstrates arm and leg lengthening on
visible joints. The isolated interview render demonstrates head reduction.
Their reports record geometric change from the applied sampling maps.
Unmeasurable or reverse shape changes are discarded and reported per interval.

Each comparison observed zero changed RGB pixels outside the measured
influence region. Full temporal and independent visual acceptance remain
unverified. The concurrency test reused a completed analysis on its second
request. Larger resolutions, high frame rates, long durations and sustained
multi-person workloads require more qualification.

The 640×480 full-body excerpt uses 54 frames at 24 fps. With verified
background observations from the uncut original, the strict recipe retained
head reduction, arm lengthening and leg lengthening at their authored
strengths across all 54 frames. The recipe worker took 70.6 s, peaked at
419 MiB RSS and recovered the exposed background from actual source
observations. The evaluator checked 9.5 million pixels outside the influence
region and found zero changes there.

The initial four-frame 3840×2160 input smoke test used a 1 GiB worker
budget. The 24 fps sample was an upscale of the interview excerpt, rendered
to a 640×360 delivery canvas. Head geometry ran on a padded source-resolution
region and used 924 MiB peak worker RSS over 7.0 seconds. All four frames had
measured head contraction with attenuation. This smoke test covers short
high-resolution input processing.

A later full-body stress test used 54 frames at 24 fps, upscaled and padded
to 3840×2160. Analysis took 12.6 s and used 454 MiB peak RSS. The recipe
worker used 169.6 s, 1.12 GiB peak RSS, and 89.2 MiB of intermediate picture
storage. The 4K export preserved all 54 frames. Head, arm, and leg changes
were measurable on 31, 31, and 24 frames respectively. This checks a 4K
render and delivery path.

The native 2160×3840 side-view benchmark uses 224 input frames at 25 fps
and a 4 GiB worker limit. The combined-only run took 943.8 s and peaked at
2.20 GiB RSS. The fallback run took 1352.2 s and peaked at 2.27 GiB RSS.
Measured head coverage rose from 12 to 192 frames and arm coverage rose from
1 to 33 frames. Leg lengthening remained measurable on one frame. The
fallback export preserved 224 frames, source timing, and valid geometry.
The lossless recipe output preserved every measured pixel outside the
influence region. Side-view limb visibility and reconstructed background
limited coverage.

The native 3840×2160 two-person fixture uses 235 input frames at 25 fps.
Both tracks were retained throughout, and the recipe edited the selected
person on 59 of 75 requested frames. The lossless intermediate preserved
every checked pixel in the unselected person's high-confidence mask
(19.5 million samples). The recipe worker took 586.3 s and peaked at
1.32 GiB RSS. The controlled comparison covered a three-second edit within
the longer source. Its timing, geometry bounds, and outside-influence
checks passed.

For the leg-length benchmark, the same native 4K fixture targeted one person
at 0.25 for the first 25 frames. All 25 frames passed `visible-result` with
reported attenuation and 2.64% to 3.70% hip-to-ankle extension. None of the
4.26 million checked pixels on the other person changed. The CPU worker
processed the full 235-frame source in 428.5 seconds, used 1.49 GiB peak RSS,
and wrote 1.37 GiB of intermediate picture data under a 4 GiB budget. The
export kept the native 3840×2160 raster and 25 fps cadence.

The 25-frame vertical 1440×2560 test targeted leg length at 0.25. All 25
frames passed `visible-result` with reported attenuation and 3.27% to
4.03% extension. The worker took 92.6 seconds, used 758 MiB peak RSS, and
wrote 41.1 MiB of intermediate picture data under a 4 GiB budget. Its
comparison kept the full one-second duration. Other checks ran concurrently
during these native and vertical measurements.

Two portrait benchmarks used 432×768 excerpts with matching original-shot
context, face slimming at 0.28, head reduction at 0.23, and eye enlargement
at 0.10. On textured brick (60 frames at 24 fps), the CPU worker took
424.6 seconds and used 647 MiB peak RSS. Cheek and head changes met the
visibility floor on 58 and 54 frames respectively. Both remained measurable
throughout. On the plain studio wall (50 frames at 25 fps), both changes met
the floor on all 50 frames. The worker took 280.4 seconds and used 539 MiB
peak RSS. Other verification jobs ran concurrently. These timings cover
source-frame processing and reconstruction of the exported edit.

See the [fixture sources](../tests/fixtures/README.md).
