---
name: video-editor
description: Create, revise, preview and render videos in OpenCut with TypeScript. Includes editable React/TSX, SVG and Anime.js v4 motion graphics, kinetic typography, animated captions, diagrams, charts, transitions, ordinary media and audio.
---

On Apple Silicon with macOS 15 or later, see the
[installation guide](../../docs/INSTALL.md). Run `opencut doctor --json` to
check FFmpeg, ffprobe, native workers and optional model readiness.

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
   `@opencut/graphics/anime` (installed CLI:
   `@dantea/opencut/graphics/anime`). Use Anime.js `stagger`, `createSpring`
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
   `opencut timeline inspect DEFINITION --frame N --json`. Declare
   [layout assertions](references/video-definitions.md#layout-assertions) for
   essential caption, panel, watermark and coverage geometry.
4. Review the composition with `opencut preview DEFINITION --watch`, the
   desktop **Open definition** action, or a deterministic frame, clip, or
   contact sheet from `opencut preview --help`. Use exact samples on the
   definition or exported MP4 to check clip cuts and caption boundaries.
   Definition previews default to `fast`.
   Use `--quality quality` to review offline AI processing, such as 4×
   super-resolution. A failed watch rebuild leaves the last valid preview
   available. Desktop review keeps the playhead at the same timeline time
   across rebuilds, including frame-rate changes, and clamps it to the last
   frame if the revision ends earlier. Select a clip, subtitle, or transition
   to pause on the first frame at or after its start. A selection made during
   loading takes effect when the preview is ready.
5. Deliver a new MP4 with `opencut render DEFINITION --output final.mp4`.
   Run `opencut render plan DEFINITION --output final.mp4 --json` with the
   same options to check cache reuse and estimated scratch space first.
   For a review MP4 that may get audio revisions, [save its encoded picture
   and retain the version ID and cache path](references/cli.md#scripted-audio-revisions).
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
8. Use `opencut verify export` with the approved MP4 preview, the render
   JSON and, for picture-only revisions, the approved audio master.
   Review the paired images and boundary checks. Play the output with
   audio to check timing. For a 60 fps delivery, check
   `opencut probe final.mp4 --expect-fps 60 --json`.
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
