# Preview and export consistency

OpenCut runs the same timeline planner and media engine for frame, clip,
watch, and final export. Frame numbers use the authored canvas
rate. A preview clip keeps the selected time range with an exclusive end.
A single-frame PNG and MP4 decoded at the same position can differ slightly
from lossy encoding and chroma subsampling. Watched playback also uses a
size cap and fast encoding.

When comparing an AI-processed preview with a final render, use the same
`--quality` on both commands. Preview defaults to `fast` and render defaults
to `quality`, so their inherited interpolation and super-resolution settings
can produce different pictures on the same frame grid. See the
[render quality profiles](CLI.md#render-quality-profiles).

## Rendering work

For a range preview, OpenCut starts the canvas at the requested frame.
Static image layers reuse their fitted pixels throughout the visible
interval. These optimizations apply automatically at every quality profile.
Animated media layers use fractional positions and sizes on the project
frame grid so a slow pan or zoom can move by less than one pixel per frame.

For eligible 1× clips in MP4 or MOV sources with zero-based timestamps,
single-frame previews and transformed layers can start at an earlier
keyframe. The decoder keeps preroll timestamps to sample on the authored
frame grid. A seek can land after the requested presentation time across
a long variable-frame-rate gap. If an indexed transform decode yields too
few frames, OpenCut discards that attempt and decodes the layer from the
beginning, which can take longer.

See the [performance benchmarks](CLI.md#performance-benchmarks) for
the CLI harness.

## Watched revisions

Watch mode stages referenced media for each revision so a file changing in
place cannot mix old and new input within one published preview. A failed or
superseded rebuild leaves the last complete playback available. The SDK can
export a selected revision with its staged inputs and retains those inputs
while the render is active. When the final profile requires different AI
processing, the watcher keeps the original recipe inputs available for that
export as well. See [export and delivery checks](EXPORT.md#preflight-and-delivery-checks).

Run `pnpm test:consistency` for frame and audio alignment and preview
recovery. The suite compares graded exports and frame previews across a long
variable-frame-rate gap against sequential decoding.

## Video-as-Code conformance

Run `pnpm test:conformance` with FFmpeg and ffprobe on PATH. The command
builds OpenCut, generates synthetic inputs in a fresh workspace, runs the
Video-as-Code native tests, and removes the temporary media and recipe cache.
Fixture directories must stay under `tests/fixtures/generated/` and may not
traverse symlinks. The native cases also run under `pnpm test:media`, which
uses the fixtures prepared by `pnpm fixtures:generate`.

The root type check and Vitest exclude `tests/fixtures/generated/`.
Prepare the offline Lottie and GLB fixtures for `pnpm test:media` with
`python3 tests/reference-motion/fixtures.py --adapters-only`.
To check whether a native pixel assertion is a regression, run the same
test on the base revision with the same synthetic inputs and FFmpeg build.
The native integration tests also check protocol rejection and make sure
that cancelling a render or killing its CLI or native worker during
decoded-frame verification stops the FFprobe process and preserves an
existing export.

After the build, the runner writes `conformance-results/run-*/report.json`.
Use `cases` for test results and skip reasons, and `measurements` for
decoded values and artifact paths.
Paths are relative to the run directory and point to items such as PNG
comparisons, representative MP4s, and decoded WAVs. Runs are ignored by Git.

VideoToolbox cases depend on the host's hardware, OS, and model readiness.
An unavailable capability is recorded as a skip. The report status
`passed-with-skips` means all cases that ran passed and the command exited
successfully. A test failure exits nonzero.

The two-second mixed-rate fixture checks half-speed source sampling, the
dissolve, transform animation, and title and subtitle ranges. A brightness
marker identifies the portrait source frames so the test can verify the
trim offset and which frames are held across a variable timestamp gap.
The two-minute portrait fixture checks all 2,880 frame timestamps and
eight flash/tone pairs at 15-second intervals. The
audio tests check decoded sample continuity, measure overlapping tones and
fade envelopes, and compare both orders of an equalizer and a limiter.

- Project frame timestamps must match the rational frame grid. A/V flash
  and pulse onsets may differ by up to 10 ms, allowing for 5 ms detection
  windows and AAC transient spread. Preview and export tone amplitude may
  differ by up to 0.004 on a full-scale 1.0 signal.
- For decoded RGB preview/export comparisons, the mean channel error is
  limited to 5/255, the 95th percentile to 25/255, and at most 2.5% of
  pixels may differ by more than 48 in any channel. Lossy compression
  and 4:2:0 chroma sampling can shift edges. Same-quality repeated builds
  use tighter bounds of 0.5/255, 2/255, and 0.1%,
  with 0.003 RMS tolerance for stereo PCM. The shared export parity check
  compares every decoded frame in bounded batches.
- The AI chain checks that interpolated frames differ from both endpoints
  and track a moving marker within 2.5 pixels of a withheld reference.
  For super-resolution, the report compares each sample to a native
  high-resolution reference and a Lanczos control and checks adjacent-frame
  error for large discontinuities. The restoration case measures seeded
  noise against the matching clean clip. The quality thresholds apply to
  these fixtures and allow backend variation. Timing, frame counts, and
  stream metadata are checked independently.
- Negative controls remove a frame, alter a single dissolve frame while
  preserving its timestamp, shift an audio marker, and compare against a
  frame missing an overlay.
- Cache cases cover timestamp-only source changes, media replacement,
  recipe parameter and model signature changes, and repair of a corrupt
  AI output. Cancellation and failure cases check cleanup and retry. An
  edit made during recipe processing exercises revision isolation by
  rendering both the original compiled definition and the next build.
