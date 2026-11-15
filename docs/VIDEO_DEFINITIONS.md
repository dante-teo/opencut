# Video as code

Author a complete video in one `.video.ts` or `.video.json` file. OpenCut
compiles the definition to an in-memory project and uses the shared timeline
evaluator, compositor, and audio mixer.

## Run the example

The [TypeScript example](../examples/video/showcase.video.ts) and
[JSON example](../examples/video/showcase.video.json) each produce the same
20-second video. They use the repository's synthetic media fixtures. Run the
commands from the checkout root with Node 24.12+ within 24.x, pnpm 11.20.0, and
FFmpeg and ffprobe on PATH. Run `pnpm fixtures:generate` once if the fixture
directory is absent.

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
out="$(mktemp -d tests/fixtures/generated/showcase-XXXXXX)"
node apps/cli/dist/index.js validate examples/video/showcase.video.ts
node apps/cli/dist/index.js inspect examples/video/showcase.video.ts --json
node apps/cli/dist/index.js preview frame examples/video/showcase.video.ts --frame 96 --output "$out/preview.png"
node apps/cli/dist/index.js render examples/video/showcase.video.ts --output "$out/typescript.mp4"
node apps/cli/dist/index.js render examples/video/showcase.video.json --output "$out/json.mp4"
ffprobe -v error -show_streams -show_format "$out/typescript.mp4"
```

Use `opencut` in place of `node apps/cli/dist/index.js` if the executable is
on PATH. The definition argument and output path resolve from the invoking
directory. Source paths resolve from the definition file's directory, using
the target directory if the file is reached through a symlink. Output files
must be new and their parent directories must exist.

## Author a definition

In TypeScript, import `defineVideo` from `@opencut/sdk` and default-export the
result. Put the SDK on the definition's Node package resolution path. Node
24.12+ within 24.x runs the file with native type stripping. Use ESM and
erasable TypeScript syntax. OpenCut evaluates the entry module once per
compilation as trusted local code. The default export can also be a promise
that resolves to a definition. Relative and absolute local ESM imports are
evaluated afresh, including dynamic imports made while that promise resolves.
Bare package imports use Node's normal module cache. The CLI validates the
resolved value at runtime. The TypeScript compiler can check the authoring type
separately.

```ts
import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  name: 'Opening card',
  canvas: {
    width: 640,
    height: 360,
    frameRate: { numerator: 30000, denominator: 1001 },
    durationFrames: 600,
    backgroundColor: '#182032',
  },
  tracks: [
    {
      type: 'text',
      clips: [
        {
          at: 0,
          duration: 540,
          text: { content: 'Opening card', fontSize: 54 },
        },
      ],
    },
  ],
});
```

JSON contains the same object as plain data. Both formats accept `version: 1`
and use version 1 when omitted. The optional top-level `name` defaults to
`Untitled video`.

- `canvas` requires width, height and an integer or rational frame rate. Set
  `durationFrames` to include an exact trailing gap. Omit it to derive the
  length from the last clip or subtitle. Set `durationFrames` explicitly for
  audio-only or blank canvases. `backgroundColor` accepts `#RRGGBB`, `#RRGGBBAA` or `transparent` and defaults
  to black.
- `assets` maps IDs to `{ path, kind }` for video, audio and images. Paths use
  forward slashes and resolve from the definition. An optional asset `name`
  and `provenance` preserve the display name and license attribution.
- `tracks` lists tracks in bottom-to-top order. A `video` track can contain
  video, still images and text in the same lane. An `audio` track can use an
  audio file or a video's audio stream. The `image` and `text` track types
  remain available for single-kind layers. Use `volume` and `muted` on video
  and audio tracks.
- Every clip has an `at` position and either an `asset` ID or a `text` object.
  Use `sourceIn` (default zero) and exclusive `sourceOut` for an exact source
  range. Images and titles also accept `duration` in place of both source points.
  All four timing fields take integer project frames or an exact seconds
  object such as `{ "numerator": 1001, "denominator": 24000 }`. Playback length
  is the source range divided by rational `speed` (0.25×–4×, default 1×).
  Titles and subtitles are visible on project ticks within their exact
  intervals. Title animation remains relative to the authored start.
- Visual clips accept `visual` with center-relative `x`, `y`, `scale`,
  `rotation` and `opacity`. Media accepts `fit` and fractional `crop` insets.
  `keyframes` maps x, y, scale, rotation and opacity to arrays of
  `{ time, value, easing }` using the [easing rules](#visual-keyframe-easing).
  Key times are rational seconds from the clip's timeline start. Changing a
  source in point or speed leaves those offsets intact. Keys must fit within
  the resulting playback duration.
- Media grading takes `grade: { exposure, temperature, tint, contrast,
saturation, curve }`. Curve points have increasing `input` and an
  `output`, with fixed endpoints at zero and one.
- Clip audio accepts `volume`, `muted`, `fadeIn`, `fadeOut`, `gainKeys` and
  `effects`. Fades take a project-frame count or an object with rational
  `duration` and optional gains `from` and `to`. `gainKeys` holds
  `{ time, value }` pairs with linear interpolation. Both envelopes use
  clip-local timeline time. Use `detachedAudio: true` on a video asset's
  audio-track clip to pad short audio to match
  picture. Mute the picture clip to avoid mixing its audio twice.
- `text` requires `content` and supports font size, weight, alignment, wrap
  width, rotation, emphasis, color, stroke, shadow, background and canvas
  fill. Define a named font under `fonts` with `{ path: "fonts/title.ttf" }`
  or `{ data: "BASE64" }` and set `font` on the text or subtitle style.
  Styles also accept inline `embeddedFont` data and a `fontFamily` name.
  OpenCut embeds TTF and OTF files up to 2 MiB. Text without a specified font
  uses the bundled font.
- `subtitles` is a `{ style, cues }` object. Cues take a stable `id`,
  `text`, `start` and exclusive `end` in rational timeline seconds, plus
  optional `style`, `pop`, `emphasis` and `words`. Each word has a UTF-16
  text range `[from, to)` and rational `start` and `end` measured from the
  cue start. Cues render above the regular tracks.
- `transitions` holds records with `id`, `kind` and `frames`.
  A `cross-dissolve` references explicit clip IDs in `from` and `to`
  and needs adjacent video clips and usable source handles. `fade-in`
  and `fade-out` reference `clipId` and affect the video layer's alpha.
- Freeze an existing image by placing it as a still clip. To hold a source
  video frame directly, declare
  `{ "path": "media/clip.mp4", "kind": "image", "freezeFrame": { "numerator": 3, "denominator": 2 } }`
  as an asset. Time zero is the start of the video stream. OpenCut uses the
  source frame covering that time and treats it as an image with no audio
  for the clip's full duration. Clips that hold the same source frame share
  one temporary PNG per preview or export and can apply different styling.

### Visual keyframe easing

Each animated property holds a nonempty array of keys in strictly increasing
clip-local time. Channels are `x`, `y`, `scale`, `rotation`, and `opacity`.
Times extend from zero through the clip's duration, inclusive. The nearest
key holds outside the channel's key span. Rotation interpolates the specified
numbers directly, so 0 to 360 is one clockwise turn.

A key's easing applies to the segment that follows it. Use `linear`,
`ease-in`, `ease-out`, or `ease-in-out` for quadratic easing. An optional
`curve: [from, to]` selects a strictly increasing subrange of `[0, 1]`.
Sampling renormalizes the easing within that subrange.

### Evaluation order

The compositor selects the source frame, grades its pixels, applies crop,
fit and clip transforms, and scales alpha by clip opacity. Transitions
weight the fitted layers before they composite over lower tracks and the
canvas. The audio renderer maps and retimes each source, applies its
`effects` array in order, then applies the clip envelope and clip/track
gain before mixing and limiting the result. The effect types are
`eq`, `compressor`, `limiter`, `de-esser` and `reverb`. See the [CLI reference](CLI.md) for export controls.

Clips on the same track can touch at exclusive boundaries. A declared
canvas duration must cover all clips and subtitles. The current renderer
takes up to 64 clips and 600 seconds, a frame rate of 1–120 fps, and
even dimensions up to 3840 pixels per side and 3840×2160 pixels total.
Transparent canvas areas are flattened over black in MP4 and PNG previews.

Asset and timeline IDs use letters, digits, underscores and hyphens and
start with a letter or digit. Explicit project, asset, track, clip, cue,
marker and transition IDs must be unique across those entities. Generated
track IDs derive from track content, with a suffix for identical tracks.
Generated clip IDs derive from their track and exact timeline start. Use
explicit IDs for references that should survive edits. Defaults are
deterministic, including the project timestamps, which default to the
Unix epoch. Identical definitions and sources on the same toolchain build
the same composition. A trusted TypeScript script can supply different
inputs on different builds.

## Media preprocessing recipes

An asset can declare a `recipe` of 1–32 ordered steps. Set `kind` to the
final media kind. Multiple declarations can use the same source with different
recipes. The [TypeScript](../examples/video/recipes.video.ts) and
[JSON](../examples/video/recipes.video.json) examples share a trim between a
cropped video and a normalized soundtrack.

| `type`              | Parameters and behavior                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trim`              | `start`, `end` in seconds from the current input’s container start. End is exclusive. Cuts each retained stream at the same boundaries and rebases the range. Video cuts align to available frames. |
| `crop`              | Integer `x`, `y`, `width`, `height` within the current oriented image. Cropping before resizing uses the original pixel grid.                                                                       |
| `resize`            | Integer `width`, `height` in square pixels. Optional `method` is `bicubic` (default), `bilinear`, `lanczos`, or `nearest`.                                                                          |
| `frameRate`         | `numerator` and optional `denominator` (default 1), 1–120 fps. Uses FFmpeg’s nearest timestamp drop/duplicate conversion. Fractional frame boundaries can round by a frame.                         |
| `interpolateFrames` | Synthesizes frames at the requested cadence, preserving picture duration and the selected audio stream. See [AI interpolation](#ai-interpolation).                                                  |
| `smoothSlowMotion`  | Synthesizes frames while extending picture duration by `1 / speed`. Drops the selected audio stream. See [AI interpolation](#ai-interpolation).                                                     |
| `extractAudio`      | Selects the input’s default audio stream and outputs audio. Pads a delayed audio start with silence to retain its position.                                                                         |
| `normalizeAudio`    | One-pass loudness normalization. Optional `targetLufs` defaults to −16 and accepts −40 through −10. Requires audio.                                                                                 |
| `superResolution`   | Set even `width` and `height` in the source aspect ratio. Apple VideoToolbox uses the `high` (default) or `fast` preset.                                                                            |
| `denoise`           | Apple VideoToolbox temporal noise filtering at `light`, `medium` (default), or `strong` strength.                                                                                                   |
| `convert`           | `format` is `mov` (FFV1 with PCM) or `mp4` (H.264 with AAC and even dimensions) for video, `png` for images, and `wav` (float PCM) or `flac` for audio.                                             |

Steps select the same primary video and audio streams as composition. By
default, each step writes lossless MOV, PNG, or WAV for the resulting kind.
A conversion applies to that step. Put it last when you want that format
as the asset consumed by the renderer. Use either `recipe` or `freezeFrame`
on an asset.

Recipe inputs are single local media files. Supported formats include MOV/MP4,
MKV/WebM, AVI, AAC, AIFF, FLAC, MP3, Ogg, WAV, BMP, TIFF, JPEG, PNG, WebP,
GIF, and APNG. A video trim must intersect the picture stream. The result
includes audio when the selected audio stream overlaps the range. For a
source whose picture starts at 0.2 s and audio starts at 0 s, a trim from
0.8 s to 1 s selects the picture at those container timestamps. If the audio
ends before 0.8 s, the result contains picture only.

Clip source positions refer to the final processed media. For example, a
trim from 8 to 10 seconds makes the selected picture available from source
position zero on the derived asset. Composition uses the probed duration and
stream offsets of the derived media.
Use an asset recipe to share a baked crop across clips. Use a clip’s
`visual.crop` for a crop specific to that placement.

Use `opencut recipes inspect DEFINITION --json` for the ordered steps and
estimated metadata, or `opencut recipes validate DEFINITION` to check the
recipe declarations and input streams. These commands probe sources without
transcoding. `opencut validate`, `inspect`, `preview`, and `render` compile
and materialize referenced recipes as needed. See [CLI flags and limits](CLI.md#media-recipes).

### AI interpolation

Use this asset recipe in a `.video.json` definition for 24 → 48 fps.

```json
{
  "recipe": [
    { "type": "interpolateFrames", "numerator": 48, "quality": "balanced" }
  ]
}
```

Use this TypeScript recipe for half-speed picture at 30 fps. Both operations
accept the same properties in either definition format.

```ts
import type { VideoRecipe } from '@opencut/sdk';

const recipe: VideoRecipe = [
  { type: 'trim', start: 2, end: 6 },
  {
    type: 'smoothSlowMotion',
    numerator: 30,
    speed: 0.5,
    quality: 'balanced',
    sceneCuts: [1.2],
  },
];
```

- `numerator` and `denominator` set the target rate from 1 through 120 fps.
  The denominator defaults to 1. `speed` for slow motion ranges from 0.125
  inclusive to 1 exclusive. At output picture time `t`, slow motion samples
  input picture time `t * speed`. It writes silent video starting at zero.
  Duration-preserving interpolation starts the derived container at the
  first retained stream and preserves the relative picture and audio offsets.
  If an earlier track is discarded and the retained picture and audio started
  at 0.125 s and 0.25 s, the derived picture starts at zero and audio at
  0.125 s. The recipe encodes the selected audio as float PCM and trims decoder
  padding beyond a declared audio endpoint.
- `quality` selects `fast`, `balanced` (default), or `high`. VideoToolbox
  provides up to one, three, or seven intermediate phases per pair,
  respectively. Higher settings resolve finer source-time positions and can
  cost more. The effective source sampling rate (`target fps / speed`) must
  exceed the input cadence and stay within 2×, 4×, or 8× that cadence for the
  selected quality. OpenCut uses the probed average for original media.
- The sampler follows decoded presentation timestamps, including variable
  cadence. Original frames on the output grid retain their pixels. Between
  originals the sampler uses the nearest available interior model phase
  and may reuse that phase on long VFR intervals. If the duration ends
  between grid points, the final packet is shortened to keep the endpoint.
  Subsequent recipe steps use the declared cadence even when the shorter
  packet changes the average frame rate reported by a probe. For example,
  a 48 fps interpolation result can feed a 50 fps step in the same recipe.
- `sceneThreshold` is the FFmpeg scene change score from above 0 through 100
  and defaults to 8. `sceneCuts` are strictly increasing seconds relative to
  the first picture frame in this step's input. A cut between frames applies
  to the first decoded frame at or after that time. The sampler holds the
  previous image until a detected or explicit cut and holds the final source
  image through its last interval. Automatic detection is heuristic. Specify
  known edits in `sceneCuts`, especially where two shots have similar colors.
- Put a `trim` before the AI step to limit processing to that input range.
  Source positions on timeline clips use the final derived asset's clock.
  A high-rate derived asset needs a matching canvas frame rate when the
  delivered composition should show every synthesized frame.

Fresh AI steps require an Apple Silicon Mac running macOS 26 or later,
OpenCut built with the macOS 26+ SDK, and FFmpeg with `scdet` and `libx264`.
OpenCut opens a VideoToolbox model session for the actual oriented dimensions
and quality. Inputs must be even-sized, progressive, 8-bit, video-range SDR
4:2:0 with right-angle rotation if a display matrix is present. Untagged range
is interpreted as video range. When audio is present, the picture stream must
declare its duration. The derived MOV uses lossless H.264, retains the source
color tags where specified, and keeps portrait geometry. Full-range, HDR,
higher-bit-depth, and unsupported configurations fail with an error. Use
`opencut system inspect --json` for hardware diagnostics. AI steps have no
automatic fallback. The separate `frameRate` recipe is available for regular
timestamp-based conversion.

Fine edges and partly occluded motion can soften or warp between frames.
In the reviewed [Tears of Steel](https://mango.blender.org/about/) excerpts,
fast foreground machinery sometimes blurred more on synthesized frames.
Faster movement, flashes, and subtle cuts can also challenge scene detection.
Review synthesized frames and cut boundaries in the final composition. See
the [CLI processing limits and cache behavior](CLI.md#media-recipes).

### AI enhancement

The following `.video.json` asset recipe processes only seconds 2 through 6
of a 720p or 1080p 16:9 source. The same steps and properties work in
`.video.ts` and are typed by `VideoRecipe` in the SDK.

```json
{
  "recipe": [
    { "type": "trim", "start": 2, "end": 6 },
    {
      "type": "superResolution",
      "backend": "videotoolbox",
      "quality": "high",
      "width": 3840,
      "height": 2160
    }
  ]
}
```

Set 2160 × 3840 for a 9:16 portrait input. Both dimensions must be even and
match the source aspect ratio. To deliver UHD, set the composition canvas
to the matching dimensions as well.

Both enhancement operations set time zero to the earliest retained video or
audio stream and preserve the delay between them. A `trim` before enhancement
uses the source container's clock. A `trim` after enhancement uses the derived
file's clock. For example, if an unselected track starts at 0 s, the selected
video at 2 s, and the selected audio at 2.25 s, the derived video starts at 0 s
and the audio at 0.25 s. Timeline clip offsets use the final recipe output.

| Step and preset           | Processor                                      | Supported geometry and settings                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superResolution`, `fast` | VideoToolbox low-latency super-resolution      | Uses a 1.5× or 2× model at supported source sizes. It picks 1.5× if that covers the target with even intermediate dimensions, and 2× otherwise. Try `high` if the selected factor is unavailable.                                        |
| `superResolution`, `high` | VideoToolbox video super-resolution revision 1 | Runs the 4× model on supported sizes up to 1920 × 1080 or 1080 × 1920. Portrait frames rotate for inference and rotate back. The model uses the previous input and output, with a reset at detected cuts.                                |
| `denoise`                 | VideoToolbox temporal noise filter             | Keeps the dimensions. `light`, `medium`, and `strong` correspond to strengths 0.25, 0.5, and 0.75. It uses references from the same detected shot, so an isolated frame has no filter result. A range with no eligible references fails. |

The accepted `backend` value is `videotoolbox`, also the default. Both
super-resolution presets run AI inference and use Lanczos to reduce the
model output to the target size when needed. Temporal denoising may help
with compression noise. Apple exposes no separate deblocking control here.

Use Apple Silicon with macOS 26 or later and an OpenCut build made with the
macOS 26+ SDK. Run `opencut system inspect --json` and look for
`low-latency-super-resolution`, `video-super-resolution`, or
`temporal-noise-filter`. For portrait `high`, check the transposed
dimensions under `video-super-resolution`. The system probe reports known
configurations and the offline model's readiness. The actual job verifies
the model can initialize and process frames. OpenCut uses system-managed
models and leaves model downloads to the system or user.

Inputs need a constant frame cadence from 1 through 120 fps, square pixels,
progressive 8-bit video-range SDR 4:2:0, and even dimensions. With audio,
the source must declare its picture duration. Use `frameRate` before AI
enhancement for variable-rate sources. The derived lossless MOV retains
picture cadence, a partial final packet, relative audio timing, and
supported primaries, transfer, matrix, and video range. When the matrix
tag is missing, OpenCut resolves the matrix from the input dimensions and
codec before enhancement and writes it to the derived file. Untagged range is
interpreted as video range. HDR, full-range, higher-bit-depth, alpha, and
unsupported model configurations produce errors. The preview and final MP4
use the timeline renderer's BT.709 output space.

Recipe order is processing order. Denoising before upscaling keeps its
work at the smaller dimensions. Interpolating first runs enhancement over
more frames, but keeps interpolation at the original dimensions. Upscaling
first may take the picture outside the interpolation processor’s limits.
Check `system inspect` for both processors when chaining them. For a
comparison, use `resize` with `"method": "lanczos"` at the same target
dimensions. Review several consecutive frames with fine text, faces,
texture, and motion. UHD dimensions alone do not establish recovered detail.

## Inspect, preview and render

Open [the review example](../examples/video/review.video.ts) to try a two-second
composition with video, an image overlay, subtitles, a dissolve and an audio
track. Edit its imported `review-title.ts` to update the title and project name.

```sh
opencut preview examples/video/review.video.ts --watch
opencut timeline inspect examples/video/review.video.ts --timestamp 1
opencut preview frame examples/video/review.video.ts --timestamp 1 --output frame.png
opencut preview contact-sheet examples/video/review.video.ts --from 12 --to 36 --count 4 --output review.png
opencut preview clip examples/video/review.video.ts --from 6 --to 42 --quality high --output review.mp4
```

Both definition formats support these commands. A timestamp can be decimal
seconds, a fraction such as `1001/30000`, or a clock time such as `00:00:01.500`.
It selects the project frame covering that time. `--frame` selects a frame
directly. Range ends are exclusive and clips have a 30-second limit.

In Electron, choose **Open definition** and select the source file. OpenCut
compiles and renders a playable revision with mixed audio. Use the timeline
ruler or frame buttons to seek the composition. A build error appears beside
the last valid revision, which stays playable while you fix the file.

CLI watch prints the build stages and the path of each playable MP4. Use
`--size` to change the default 640-pixel cap on the longest side.
With `--json`, stdout carries one event per line. Each event has a `status`
(`compiling`, `rendering`, `ready`, or `error`), an attempted `generation`, and
a `current` field. `current` is `null` until the first playable preview and
then contains its `generation`, `sourceRevision`, `path`, and `frameCount`.
An `error` event also includes an `error` message and watch keeps running.

A `ready` event can reuse the current MP4 when an edit leaves the render plan
unchanged. The MP4 is temporary. Copy it while it is current to keep it, or
use a one-shot preview command to write a named output. Press Ctrl-C to stop
watching and remove the temporary preview files.

Watch mode debounces saves and tracks the entry, relative and absolute ESM
imports, referenced font files, and local media. It reuses unchanged media
snapshots and probe results. Changes to the render plan encode a full draft
playback movie with the shared renderer. Larger compositions take longer to
refresh. Media may need temporary disk space for copies when the filesystem
cannot clone them.
Only open trusted TypeScript. Bare package files, arbitrary files read by
script code, and external state are outside the tracked inputs.

`validate` checks the schema, timeline, media kinds, source bounds and
full-render constraints. Its JSON output includes `{ ok, path, frameCount }`.
The frame count is available for both declared and inferred durations.
`inspect --json` returns the compiled snapshot and its exact rational duration.
Both commands use ffprobe for declared media and can run without
media tools for asset-free definitions.

Full renders support up to 256 distinct subtitle cues that appear on the
output frame grid. `validate` and `inspect` check this limit before
any render. `preview frame --frame N --output FRAME.png` counts only the cues
visible in the selected frame, so a long subtitle track can still be reviewed
one frame at a time. `render --json` prints one result on stdout after verified
publication. TypeScript console messages go to stderr.

Each compilation captures a frozen project snapshot, its render plan and its
source metadata. Edits to the definition after compilation apply on the next
invocation. Validation and rendering do not save a project or add editing
history. Render and preview commands publish a new output only after
verification. Send SIGINT (Ctrl-C) or SIGTERM to request cancellation.
Watch can cancel the worker that evaluates TypeScript. If TypeScript evaluation
stalls in a one-shot CLI command, send a second signal to terminate the CLI.

SDK callers can pass `await compileVideo(file, { signal, preview: true })`
to `previewVideo` for project inspection, exact frame inspection, PNGs,
contact sheets and clips. `watchVideo(file, { onStatus, signal })` delivers
playable revisions and build errors. The SDK reference documents the lifetime
of these revisions. [SDK reference](SDK.md)
