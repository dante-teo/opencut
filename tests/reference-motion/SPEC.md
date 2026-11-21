# Motion comparison fixtures

Use original scenes, the same inputs and fonts in both engines, and a 30 fps
output grid. Render each Remotion reference with version 4.0.545. Review the
references before judging parity. Record input SHA-256s, generated video hashes,
frame counts, and engine options with the local outputs. Coordinates are pixels
from the upper left. Intervals include their start and exclude their end.

| Scene       | Canvas    | Frames | Reference landmarks                                                                                                                                                                                                                                                                     |
| ----------- | --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field Notes | 1080×1920 | 900    | Trim real speech at a whole-frame mark. Cut to B-roll at frames 240 and 540, and back to the speaker at frame 360. Keep speech continuous. Place captions within x=86–994 and y=1380–1630; active-word boxes match supplied cue boundaries. Show the lower third at frames 45–165.      |
| Prism       | 1920×1080 | 600    | Center the title at x=960. The lead card moves from x=670 to x=960, crossing x=985 during the entrance and settling within 2 px by frame 90. The two cards show opposite perspective. The foreground mask reveals the gradient, and the transition spans frames 315–344.                |
| Waterline   | 1920×1080 | 600    | Bars originate from y=790. In the initial variant, heights are proportional to 24, 45, 72 and 90; the second variant uses 35, 55, 65 and 80. Complete the line reveal by frame 390. Bound long labels to their allotted widths and keep the callout leader attached to its datum.       |
| Signal      | 1920×1080 | 450    | Audio source is PCM at 48 kHz. Trim the first second and place the edited clip at frame 15. Source impulses at 2, 5 and 9 s arrive at frames 45, 135 and 255. Spectral peaks must distinguish 220 Hz from 880 Hz in the two source variants.                                            |
| Relay       | 1920×1080 | 300    | Capture vector animation over footage. Use a source whose intrinsic rate is 24 fps and in-point is frame 12. Seek the first visible coordinate at a nonzero source trim and change speed on the second placement. Leave the four corners transparent in the standalone sampled overlay. |
| Parallax    | 1920×1080 | 300    | Use an original local GLB with overlapping meshes at different depths. Seek by explicit camera time. Over the camera move, an occlusion edge must move across the rear mesh. Preserve a transparent background around the silhouette so the video track remains visible.                |

Capture the first and last frame of every placement and transition plus
interior frames at one-quarter and three-quarter progress. For Prism, inspect
the widest spring overshoot and confirm blur spans multiple positions during
motion. The wipe at frames 315–344 follows cubic Bézier `(0.32, 0, 0.18, 1)`,
with its 1920 px edge at approximately x=1308, 348 and 48 on frames 322, 330
and 338. Check complete clip durations, frame timestamps, and the mixed audio
while watching both outputs. Compare geometry/timing and perceived results
across engines. Use the tighter decoded tolerances in OpenCut’s conformance
documentation for repeated and preview-versus-render OpenCut output.

For resource runs, use one worker initially. Cap incremental scratch at 8 GiB
and combined observed process-tree RSS at 8 GiB on the 32 GiB host and 4 GiB
on the 16 GiB host. Track cache bytes separately. Repeat from an empty cache
and a warm cache. Record first-frame, selected-range and full-render latency,
peak scratch, process-tree RSS, backend reported GPU use when exposed, and
time from cancellation to owned process exit.

The Relay reference explicitly converts the composition sample to the intrinsic
24 fps clock. The two trims are 24 and 72 project frames, with rates of 1×
and 1.5×. This corrects the initial reference wrapper, which used unconverted
component frames and shortened the second placement. Both versions of Relay
use the same transforms, data, design, assets and output duration.

## Reproduce the references

Install the isolated reference dependencies from the checkout root with
`pnpm --dir tests/reference-motion install --ignore-workspace --frozen-lockfile --ignore-scripts`.
The comparison evaluates independently authored compositions under the
pinned Remotion License. OpenCut does not bundle or ship Remotion.

Run `python3 tests/reference-motion/fixtures.py` with FFmpeg and FFprobe
on PATH. This requires the two documented public-domain video sources
and generates pinned local audio, Lottie and GLB inputs. The sampled English
word ranges in `field-captions.json` originate from local alignment of the
White House recording. The Chinese glosses are authored here.

Set `OPENCUT_REFERENCE_CHROMIUM` to the pinned Chromium Headless Shell
path from `opencut doctor --json`. Run
`node tests/reference-motion/render.mjs` for all six reference scenes
and the two parameter variants. Supply a composition ID to run one.
Videos and boundary sheets are written under the ignored fixture directory.

Run `node tests/reference-motion/workloads.mjs` to prepare the resource
gate definitions. Run `python3 tests/reference-motion/measure.py /path/to/opencut LABEL editorial sustained uhd-wide uhd-tall ordinary --warm --cancellation`
to collect host measurements and verify budgets. The harness counts RSS
for the process group and its children. It cannot directly attribute
graphics-driver allocations. Use `--rss-gib 4` on the 16 GiB reference host.
Run `python3 tests/reference-motion/measure.py /path/to/opencut LABEL cache-limit --picture-cache`
to verify cache exhaustion. The 96 high-entropy frames should all reach the
export even when the 256 MiB graphic sample write budget stops admitting
new samples.

For installed-runtime verification, package each JSON definition in
`examples/motion/` with `opencut package DEFINITION --root . --output
relocated/SCENE` from the checkout. Transfer the resulting directories to
a clean host. With the installed CLI and its matching Chromium ready,
restrict outbound network access using the host's controls while preserving
local browser IPC. Run `bash tests/reference-motion/verify-installed.sh
/path/to/opencut relocated new-output-directory`.
