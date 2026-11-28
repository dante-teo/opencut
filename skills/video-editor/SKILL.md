---
name: video-editor
description: Create, revise, preview and render videos in OpenCut with TypeScript. Includes editable React/TSX, SVG and Anime.js v4 motion graphics, kinetic typography, animated captions, diagrams, charts, transitions, ordinary media and audio.
---

On Apple Silicon with macOS 15 or later, see the
[installation guide](../../docs/INSTALL.md). Run `opencut doctor --json --compact`
to check FFmpeg, ffprobe, native workers and optional model readiness.

Treat `.video.ts` and its imports as executable local code. Run definitions
you authored for the task or that the user explicitly authorized. Validation,
inspection, preview and packaging all execute the definition.

Default-export a value from `defineVideo` in a `.video.ts` file. Import
`defineVideo` from `@opencut/sdk`. Use `opencut convert name.video.json` to
migrate a legacy composition to a `.video.ts` file beside the resolved JSON source.
Run `opencut --help` to discover commands and `opencut render --help` for export controls.

## Choose graphics when the video calls for them

OpenCut can author and render custom **React/TSX, HTML, CSS, SVG, and Anime.js v4**
compositions as editable, transparent clips. Reach for this when the brief asks
for kinetic type, animated captions, SVG path drawing or morphs, coordinated
scene transitions, product diagrams, infographics, or a distinctive motion
identity. A declarative scene or template is a simpler fit for standard graphics.
For an ordinary footage edit, follow the media workflow below.

- Decide what the viewer should notice in each beat. Mark the entrance, the
  moment the idea becomes clear, and the handoff to the next beat. Leave words
  on screen long enough to read at the smallest intended viewing size.
- Give the main subject the clearest movement. Stagger supporting elements
  in the order they should be read, and give related elements a shared rhythm.
  Ease into a resting pose. Use spring overshoot when it suits the subject.
- Carry a shape, direction, or color between scenes so the transition connects
  the ideas. Time important changes to a spoken phrase or an audio cue when
  the cut has one. In Tideline, a drawn wave introduces the tide, a contour
  gives the swell a shape, and a rotating needle brings the focus to rhythm.

1. Put the default-exported TSX component beside the project or in a subfolder.
   Declare an asset with `kind: 'graphic'`, `renderer: 'react'`, the TSX `path`,
   `durationFrames` and `animation: { version: 1, seed, parameters }`.
   Set asset `props` as defaults and clip `props` for each placement. Declare
   local images and fonts in `resources`. Put soundtrack material on audio tracks.
2. Register animation with `useGraphicTimeline(ref, build)` from
   `@opencut/graphics/anime`. Use Anime.js `stagger`, `createSpring`
   and `svg` helpers with explicit initial and target values. OpenCut builds
   and seeks the paused timeline for each source frame. Drive visual state
   from that clock. Use stable-ID randomness and scoped SVG IDs.
3. Place it on a video track with `asset`, `at`, optional `sourceIn` and
   exclusive `sourceOut`. The graphic can appear over video, stills or other
   graphics and keeps its alpha. Set clip transforms with `visual` and
   `keyframes`. Edit timing and props in the definition or with
   `opencut timeline edit-graphic` and a
   [JSON edit](../../docs/CLI.md#react-and-svg-graphics). Use whole project
   frames and split where any attached transitions can stay whole.
4. Run `opencut doctor --json` for the pinned Chromium prerequisite,
   `opencut validate DEFINITION --json` for code and parameter validation,
   and `opencut preview frame DEFINITION --frame N --quality quality --output frame.png`.
   Check the clip's first and final visible samples and both sides of motion
   boundaries. Use
   `opencut preview clip DEFINITION --from START --to END --output motion-review.mp4`
   to review a beat or transition in motion with the audio. Check where the
   eye goes, whether text has time to read, and how the next scene arrives.
   Adjust the timing and play the revision before rendering with
   `opencut render DEFINITION --output final.mp4`.
   Keep the editable TSX and assets with the definition and package them if needed.
   See the [Anime.js authoring API](../../docs/GRAPHICS.md#animejs-motion-graphics)
   and [runnable Tideline example](../../examples/motion/tideline/tideline.video.ts).

## Edit and deliver

1. Probe inputs with `opencut probe FILE --json`. Reference media paths
   relative to the definition. Keep original media intact. Use ordered asset
   recipes for reusable preprocessing. Run
   `opencut recipes inspect DEFINITION --json` to check the steps without
   transcoding. Use `interpolateFrames` to preserve duration at a higher
   frame rate or `smoothSlowMotion` to extend picture duration and mute it.
   Use `superResolution` for AI upscaling and `denoise` on supported hardware.
   Preserve authored quality; never silently downsize a source or substitute a
   lighter model to satisfy an unsupported processor.
   Check [AI recipe support and scene boundaries](references/video-definitions.md#media-recipes).
2. Set canvas size, frame rate, ordered tracks, and clip ranges. Use integer
   frame positions or exact rationals as documented. Add subtitles, effects,
   fades, and transitions to the definition itself. Use `buildNarration`
   to create dialogue clips and caption cues together from recordings and
   transcripts with [stable segment IDs](references/sdk.md#narration-and-captions).
3. Run `opencut validate DEFINITION --json` and
   `opencut inspect DEFINITION --json`. Inspect exact frames with
   `opencut timeline inspect DEFINITION --frame N --metadata-only --json`
   for authored clip and crop details without cache writes. Run resolved
   inspection to get processed-media evidence. Declare
   [layout assertions](references/video-definitions.md#layout-assertions) for
   essential caption, panel, watermark and coverage geometry.
4. Review the composition with `opencut preview DEFINITION --watch` or a
   deterministic frame, clip, or contact sheet from `opencut preview --help`.
   Use exact samples on the
   definition or exported MP4 to check clip cuts and caption boundaries.
   Definition previews default to `fast`.
   Use `--quality quality` to review offline AI processing, such as 4×
   super-resolution. A failed watch rebuild leaves the last valid preview
   available.
5. Deliver a new MP4 with `opencut render DEFINITION --output final.mp4`.
   Run `opencut render plan DEFINITION --output final.mp4 --json` with the
   same options to check composition and delivery specs, each shot's cadence,
   cache reuse, and estimated scratch space first. Use the SDK's
   [`create4K60Delivery`](../../docs/SDK.md#4k60-delivery-variants) for a native
   4K60 composition with interpolation on selected shots.
   For an MP4 that may get audio revisions, keep the export and its JSON
   report from `render --revision-evidence --json`.
   The CLI defaults to `quality` and runs directly. Use `--quality maximum`
   for slower MP4 encoding with the same AI algorithms as `quality`.
   Export an SRT or VTT
   with `opencut subtitles export DEFINITION --output final.srt` if requested.
6. For variants, use `defineVideo(shape, compose)` with `videoParams` and
   reusable TypeScript helpers. Validate a sample with `--params params.json`.
   Run `opencut batch DEFINITION --variants variants.json --output-dir outputs --json`.
   Read each result and retry corrected entries with `--only id,id`.
7. If interrupted, run `opencut build inspect DEFINITION --json` with the
   same cache, quality and parameters. Check source-change JSON for the file,
   stage and content comparison. For transfer, run `opencut package DEFINITION --output bundle`
   and `opencut package verify bundle`. Render `bundle/opencut.bundle.video.ts`
   with the required backends.
8. Use `opencut verify export` with the approved MP4 preview and render
   JSON. Supply `--audio-master` when delivery requires exact encoded audio
   content and timing from an approved MP4.
   Compare different frame rates by presentation time with `--timestamps`.
   For a 60 fps delivery, use `--expect-fps 60` to check the complete frame
   clock. Review the paired images and boundary checks. Play the output with
   audio to check the result.
   Follow the [matched-frame workflow](../../docs/CLI.md#verify-interpolation-and-upscale)
   for interpolation or upscale. Record
   the definition, input hashes, effective profile, worker versions, recipe
   results and verification.

Start with the [complete example and visual review loop](references/workflow.md).
See [definition fields](references/video-definitions.md), the
[CLI reference](references/cli.md), and [SDK usage](references/sdk.md).

For reusable animated information cards, charts, callouts, and title cards,
place `kind: 'graphic'` assets on video tracks. React requires the pinned
Chromium Headless Shell. Static SVG uses the same composition commands
without a browser and supports text with bundled or declared local fonts.
For direct built-in templates, `validate` and `package` check asset defaults
and placement props. React errors carry mapped source locations when
available. Keep animation source-local and use matching preview/export quality.
See [React and SVG graphics](../../docs/GRAPHICS.md).

For targeted face, body or skin work, use the
[beauty workflow](references/beauty.md). Check the local backend, bind the
intended person from source analysis, and inspect the coverage and motion
evidence before delivering.

For dialogue cleanup and automatic music ducking, route audio or video tracks
with `audioRole: 'dialogue'`, `'music'` or `'other'` and enable
`professionalMix` in the definition. Use `opencut mix analyze <file.video.ts> --json`
for editable curves and a loudness report before encoding picture. See the
[mix definition, delivery presets and offline AI options](../../docs/AUDIO_MIX.md).

For declarative motion graphics, declare a version 3 scene directly in the
definition. Choose a preset or add primitives with stable node IDs. Give
text explicit pixel bounds and an overflow policy. Set motion in local
source frames. Use the timeline inspector to check the resolved sample,
then preview a frame before the motion, one in flight and one at rest.
Use `audioAnalysis` and an audio node when visual movement depends on
actual sound. A missing resource error names its asset or node. Check the
file path relative to the authored definition. See the
[declarative scene reference](../../docs/GRAPHICS.md#declarative-scenes).

## Revise an edit

- Use `opencut review` to compare named moments or find changed ranges
  from compatible timeline evidence. See the [review guide](../../docs/CLI.md#review-a-revision). Open the synchronized comparison
  and record viewing and listening separately from technical checks.
  For music candidates, use the same `musicComparison` group with
  `--music-loudness matched`.
- Use `opencut timeline patch --dry-run` to check frame ranges, ripple movement
  and source availability before writing a new definition. For a client note
  on one shot, use `review --source-comparison` with the delivery, definition
  and matching report. Use a `replace-source` patch to keep the shot's timing
  while changing the take, and choose embedded audio explicitly if needed.
  Put `replace-source` before any `trim` of that clip in the same patch.
- For a local picture change, use `render --picture-from BASELINE.mp4 --render-report BASELINE.render.json --preflight`.
  Check `checks`, `pendingChecks`, the changed and encoded frame ranges,
  packet reuse and soundtrack decision before rendering to a new output.
  An eligible revision still needs to verify timestamps on the actual segments
  and delivery. Render with `--json` to capture the timing details and the
  `fallback` command. If you run the fallback, keep its successful JSON report
  with the MP4 identified by its `path` field for the next baseline. Use a
  successful revision report to sample splice joins with
  `preview contact-sheet --around picture`.
  [Local picture revisions](../../docs/CLI.md#local-picture-revisions)
- For an audio-only change, run `opencut remix --preflight` with the existing
  MP4 and its render report, then run `remix` if the decision is `reuse`.
  See the [scripted audio workflow](references/cli.md#scripted-audio-revisions).
- For local caption timing, use `transcribe` with times relative to the
  first picture frame or first audio sample for audio-only files. Correct
  the UTF-8 sidecar, then use `transcript align` and review flagged spans
  before export. Check `doctor --json --compact` for tool and model readiness.
  [Local transcription](../../docs/CLI.md#local-transcription-and-corrected-timing)
