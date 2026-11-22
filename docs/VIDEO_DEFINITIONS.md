# Video as code

Author a complete video in one `.video.ts` file. OpenCut
compiles the definition to an in-memory project and uses the shared timeline
evaluator, compositor, and audio mixer.

## Run the example

With the installed CLI, start with the [opening card](../examples/video/opening-card.video.ts)
and follow the [headless review loop](../skills/video-editor/references/workflow.md).
The opening card needs no input media.

### Checkout examples

The [showcase](../examples/video/showcase.video.ts) renders a 20-second
video using the repository's synthetic media fixtures. Run the
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
node apps/cli/dist/index.js render examples/video/showcase.video.ts --output "$out/showcase.mp4"
ffprobe -v error -show_streams -show_format "$out/showcase.mp4"
```

Use `opencut` in place of `node apps/cli/dist/index.js` if the executable is
on PATH. The definition argument and output path resolve from the invoking
directory. Source paths in authored definitions resolve from the definition
file's directory, using the target directory if the file is reached through a
symlink. Output files must be new and their parent directories must exist.

## Author a definition

Import `defineVideo` from `@opencut/sdk` and default-export the
result. The installed CLI and review app resolve this import to their included
SDK when the project has no local SDK. Node 24.12+ within 24.x runs the file
with native type stripping. Use ESM and
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

The optional `version` field defaults to `1` for media-only definitions and `2`
for definitions using [React or SVG graphics](GRAPHICS.md). The optional top-level `name` defaults to
`Untitled video`.

- `canvas` requires width, height and an integer or rational frame rate. Set
  `durationFrames` to include an exact trailing gap. Omit it to derive the
  length from the last clip or subtitle. Set `durationFrames` explicitly for
  audio-only or blank canvases. `backgroundColor` accepts `#RRGGBB`, `#RRGGBBAA` or `transparent` and defaults
  to black.
- `assets` maps IDs to `{ path, kind }` for video, audio and images. Paths use
  forward slashes and resolve from the definition. An optional asset `name`
  and `provenance` preserve the display name and license attribution. Use
  `kind: 'graphic'` for a [React or static SVG surface](GRAPHICS.md).
- `tracks` lists tracks in bottom-to-top order. A `video` track can contain
  video, still images, graphics and text in the same lane. An `audio` track can use an
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
  `rotation` and `opacity`. Media accepts `fit`, `sourceWindow` in source pixels, and fractional `crop` insets.
  `keyframes` maps x, y, scale, rotation and opacity to arrays of
  `{ time, value, easing }` using the [easing rules](#visual-keyframe-easing).
  Key times are rational seconds from the clip's timeline start. Changing a
  source in point or speed leaves those offsets intact. Keys must fit within
  the resulting playback duration.
- Media grading takes all six fields in
  `grade: { exposure: 0, temperature: 0, tint: 0, contrast: 1, saturation: 1, curve: [] }`.
  That example is neutral. Contrast and saturation range from 0 to 3.
  Supply interior curve points as `{ input, output }` with increasing
  inputs between zero and one. OpenCut supplies the endpoints.
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
  and joins adjacent photos or video clips on the same video track.
  A timed video needs usable source frames on its side of the cut.
  Photos and freeze frames can extend through the dissolve. Dialogue and
  other clip audio retain their original timing. `fade-in` and `fade-out`
  reference `clipId` and apply within its picture interval without source handles.
- Freeze an existing image by placing it as a still clip. To hold a source
  video frame directly, declare
  `{ "path": "media/clip.mp4", "kind": "image", "freezeFrame": { "numerator": 3, "denominator": 2 } }`
  as an asset. Time zero is the start of the video stream. OpenCut uses the
  source frame covering that time and treats it as an image with no audio
  for the clip's full duration. Clips that hold the same source frame share
  one temporary PNG per preview or export and can apply different styling.

### Frame a source window

Set `visual.sourceWindow` on a video or still-image clip and specify
`visual.fit` as `contain`, `cover` or `stretch`. For a 1200 × 1600 source,
this places the left 900 pixels of the full-height image on a 9:16 canvas.

```ts
{
  id: 'left-framed',
  asset: 'two-person-shot',
  at: 0,
  sourceOut: 120,
  visual: {
    sourceWindow: { x: 0, y: 0, width: 900, height: 1600 },
    fit: 'cover',
  },
}
```

The window uses integer source pixels with a top-left origin and
exclusive right and bottom edges. It must fit inside the oriented image
after media recipes. Sample aspect ratio affects fitting, while the window
is measured on the source pixel grid. `contain` fits the whole window,
`cover` fills the fitting box by trimming around the center, and
`stretch` fills the box independently along both axes.

`opencut timeline inspect edit.video.ts --frame 60 --json` includes a
`framing` object for active media with known source dimensions. It reports
the resolved `sourceWindow`, the axis-aligned `destinationBounds` in
project pixels after the clip transform and before canvas clipping, and
`visibleSourceRegion.polygon`. The polygon vertices are in oriented
source-pixel coordinates. A rotated clip cut by the canvas can yield
more than four vertices. An empty polygon means no geometric intersection
or zero opacity. This geometry measures the clip against the canvas and
excludes transition effects, masks, and occlusion by other layers.

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

Media recipes run first on the asset. The compositor selects and orients
the resulting source frame, crops `sourceWindow` if present, then grades
and fits the media on the canvas. Legacy `visual.crop` insets mask the fitted
layer. Rotation uses the fitted layer's center, `x` and `y` position it, and
opacity scales alpha. Transitions weight the fitted layers before they
composite over lower tracks and clip to the canvas. The audio renderer maps and retimes each source, applies its
`effects` array in order, then applies the clip envelope and clip/track
gain before mixing and limiting the result. The effect types are
`eq`, `compressor`, `limiter`, `de-esser` and `reverb`. See the [CLI reference](CLI.md) for export controls.

Clips on the same track can touch at exclusive boundaries. A declared
canvas duration must cover all clips and subtitles. The current renderer
takes up to 128 clips and 600 seconds, a frame rate of 1–120 fps, and
even dimensions up to 3840 pixels per side and 3840×2160 pixels total.
Transparent canvas areas are flattened over black in MP4 and PNG previews.
Dense overlapping stacks composite in ordered lossless passes when needed.
These passes use temporary disk space even when picture caching is disabled.

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
recipes. The [example](../examples/video/recipes.video.ts) shares a trim between a
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
| `superResolution`   | Set even `width` and `height` in the source aspect ratio. Optional `quality` overrides the render profile.                                                                                          |
| `denoise`           | Apple VideoToolbox temporal noise filtering. Set `strength` to `light`, `medium` (default), or `strong`, independently of render quality.                                                           |
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
Use an asset recipe to share a baked crop across clips. Use
`visual.sourceWindow` for source-pixel framing on a single placement and
`visual.crop` for fractional masking of its fitted layer.

Use `opencut recipes inspect DEFINITION --json` for the ordered steps and
estimated metadata, or `opencut recipes validate DEFINITION` to check the
recipe declarations and input streams. These commands probe sources without
transcoding. `opencut validate`, `inspect`, `preview`, and `render` compile
and materialize referenced recipes as needed. See [CLI flags and limits](CLI.md#media-recipes).

### AI interpolation

Use this asset recipe for 24 → 48 fps.

```ts
import type { VideoRecipe } from '@opencut/sdk';

const recipe: VideoRecipe = [{ type: 'interpolateFrames', numerator: 48 }];
```

Use this recipe for half-speed picture at 30 fps.

```ts
import type { VideoRecipe } from '@opencut/sdk';

const recipe: VideoRecipe = [
  { type: 'trim', start: 2, end: 6 },
  {
    type: 'smoothSlowMotion',
    numerator: 30,
    speed: 0.5,
    quality: 'quality',
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
- An authored `quality` of `fast`, `quality`, or `maximum` takes precedence over
  the command's profile. Omit it to use `fast` in previews and `quality` in
  final renders by default. `fast` uses the low-latency midpoint model and
  supports a source-clock rate (`target fps / speed`) up to 2× input cadence.
  `quality` and `maximum` use the same quality-priority offline VideoToolbox
  Frame Rate Conversion revision 1 with on-the-fly optical flow. They compute
  the requested phase within each input pair. Every profile requires a
  source-clock rate above the input cadence.
- The sampler follows decoded presentation timestamps, including variable
  cadence. At source timestamps the sampler emits the source frame. The
  offline backend round-trips 8-bit YUV through RGBA for its FP16 surfaces.
  Fast can reuse the midpoint on long VFR intervals. If the duration ends
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

Fresh AI steps require an Apple Silicon Mac, OpenCut built with the macOS
26+ SDK, and FFmpeg with `scdet` and `libx264`. Offline interpolation requires
macOS 15.4 or later. Low-latency interpolation requires macOS 26 or later.
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

This asset recipe processes seconds 2 through 6 of a 720p or 1080p 16:9
source. The SDK types these steps with `VideoRecipe`.

```ts
import type { VideoRecipe } from '@opencut/sdk';

const recipe: VideoRecipe = [
  { type: 'trim', start: 2, end: 6 },
  {
    type: 'superResolution',
    backend: 'videotoolbox',
    quality: 'quality',
    width: 3840,
    height: 2160,
  },
];
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

OpenCut runs the steps in recipe order. Denoising before upscaling keeps
denoising at the smaller dimensions. For 30 → 60 fps, upscaling first
enhances half as many frames, but interpolation then has to support and
process the larger frames. Interpolating first keeps interpolation at the
original dimensions and doubles the number of frames sent to enhancement.

| Step and preset                           | Processor                                      | Supported geometry and settings                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superResolution`, `fast`                 | VideoToolbox low-latency super-resolution      | Uses a 1.5× or 2× model at supported source sizes. It picks 1.5× if that covers the target with even intermediate dimensions, and 2× otherwise. Select `quality` if the required scale is unavailable.                                   |
| `superResolution`, `quality` or `maximum` | VideoToolbox video super-resolution revision 1 | Runs the temporal 4× model on supported sizes up to 1920 × 1080 or 1080 × 1920. Portrait frames rotate for inference and rotate back. The model uses the previous input and output, with a reset at detected cuts.                       |
| `denoise`                                 | VideoToolbox temporal noise filter             | Keeps the dimensions. `light`, `medium`, and `strong` correspond to strengths 0.25, 0.5, and 0.75. It uses references from the same detected shot, so an isolated frame has no filter result. A range with no eligible references fails. |

The accepted `backend` value is `videotoolbox`, also the default. Both
super-resolution presets run AI inference and use Lanczos to reduce the
model output to the target size when needed. The requested size controls the
result. The temporal model still computes its full 4× output. Its input size
limit applies to the frame reaching the step, after any explicit crop or
resize. OpenCut reports unsupported dimensions and leaves any source resize
to the recipe author.

Temporal denoising may help with compression noise. Apple exposes no
separate deblocking control here.

Use Apple Silicon with macOS 26 or later and an OpenCut build made with the
macOS 26+ SDK. Run `opencut system inspect --json` and look for
`low-latency-super-resolution`, `video-super-resolution`, or
`temporal-noise-filter`. For offline portrait upscaling, check the transposed
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

Check `system inspect` for both processors when chaining them. For a
comparison, use `resize` with `"method": "lanczos"` at the same target
dimensions. Review several consecutive frames with fine text, faces,
texture, and motion. UHD dimensions alone do not establish recovered detail.

## Layout assertions

Use `layoutAssertions` to record placement requirements in project pixels.
Give each assertion a unique `id` and select a clip or subtitle cue by ID
with `target: { clip: 'id' }`, a visual track with `target: { track: 'id' }`,
or all burned-in subtitle cues with `target: { subtitles: true }`.

```ts
layoutAssertions: [
  {
    id: 'dialogue-anchor',
    kind: 'bottom-center',
    target: { subtitles: true },
    bottom: 120,
    tolerance: 2,
  },
  {
    id: 'dialogue-ink',
    kind: 'glyphs-centered',
    target: { subtitles: true },
    tolerance: 6,
  },
  {
    id: 'watermark-anchor',
    kind: 'upper-left',
    target: { clip: 'watermark' },
    top: 28,
    left: 28,
    tolerance: 2,
  },
  {
    id: 'portrait-panel',
    kind: 'centered',
    target: { clip: 'portrait' },
    against: 'photo-panel',
    tolerance: 2,
  },
  {
    id: 'photo-cover',
    kind: 'covers-canvas',
    target: { clip: 'hero-shot' },
  },
],
```

`centered` compares horizontal and vertical centers. `inside` checks
containment, with optional `insets: { top, right, bottom, left }`. Both use
the canvas by default and accept `against` for a named element.
`bottom-center` compares the center X and bottom edge to the canvas anchor.
`upper-left` compares the left and top edges to the requested offsets.

Text placement uses the background panel when present and native font ink
metrics otherwise. `glyphs-centered` compares shaped glyph bounds in both
axes against a background panel and excludes stroke, shadow and active-word
highlight effects. `covers-canvas` checks all four canvas corners against
the fitted media polygon, including crop, rotation and animated placement.
Media and graphic checks use the fitted layer's geometry. Transparent
pixels inside source artwork and face placement need visual review.
Groups with a matte or foreground blur require visual review and produce a
structured unsupported-geometry result.

`tolerance` defaults to zero and `required` defaults to true. OpenCut
checks the active project frame range and returns the worst frame per
resolved segment. It skips frames where a transition fully hides a layer.
If authored motion takes a shot off-canvas during a visible part of a fade,
its coverage check still fails. An assertion targeting missing geometry
fails. This includes targeting subtitles in a render made with `--no-subtitles`.
Set `required: false` to collect an advisory result. See the
[CLI report fields and exit behavior](CLI.md#layout-assertions).

## Inspect, preview and render

With the checkout fixtures generated, open [the review example](../examples/video/review.video.ts) to try a two-second
composition with video, an image overlay, subtitles, a dissolve and an audio
track. Edit its imported `review-title.ts` to update the title and project name.

```sh
opencut preview examples/video/review.video.ts --watch
opencut timeline inspect examples/video/review.video.ts --timestamp 1
opencut preview frame examples/video/review.video.ts --timestamp 1 --output frame.png
opencut preview contact-sheet examples/video/review.video.ts --from 12 --to 36 --count 4 --output review.png
opencut preview clip examples/video/review.video.ts --from 6 --to 42 --quality maximum --output review.mp4
```

A timestamp can be decimal
seconds, a fraction such as `1001/30000`, or a clock time such as `00:00:01.500`.
It selects the project frame covering that time. `--frame` selects a frame
directly. Range ends are exclusive and clips have a 30-second limit.
Use [frame-targeted contact sheets](CLI.md#frame-targeted-contact-sheets)
to review the rendered frames around a cut or caption boundary.

In Electron, choose **Open definition** and select the source file. OpenCut
compiles and renders a playable revision with mixed audio. Use the timeline
ruler or frame buttons to seek the composition. A build error appears beside
the last valid revision, which stays playable while you fix the file.

Desktop review uses the `fast` profile. If a recipe requires the offline
processor to preview successfully, set `quality: 'quality'` on that recipe
step. That setting applies to exports as well.

CLI watch prints the build stages and the path of each playable MP4. Use
`--size` to change the default 640-pixel cap on the longest side.
With `--json`, stdout carries one event per line. Each event has a `status`
(`compiling`, `rendering`, `ready`, or `error`), an attempted `generation`, and
a `current` field. `current` is `null` until the first playable preview and
then contains its `generation`, `sourceRevision`, `path`, `frameCount`, and
`quality`.
An `error` event also includes an `error` message and watch keeps running.

A `ready` event can reuse the current MP4 when an edit leaves the render plan
unchanged. The MP4 is temporary. Copy it while it is current to keep it, or
use a one-shot preview command to write a named output. Press Ctrl-C to stop
watching and remove the temporary preview files.

Watch mode debounces saves and tracks the entry, local ESM imports,
including Node `#` aliases that resolve to local files, referenced font
files, and local media. It reuses unchanged media snapshots and probe
results. Changes to the render plan encode a full preview
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

Full renders support up to 512 distinct subtitle cues that appear on the
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

## Reusable functions and parameters

Use TypeScript functions and imports to compose the same definition fields.
A helper can return one clip, a group of clips with transitions, subtitle
cues, or an audio clip with effects. Give each placement a distinct,
stable scope. When one piece references another, qualify their IDs with
`videoId(scope, localId)`. Reuse the same qualified clip IDs in transitions.
The compiler also supplies stable IDs for clips and tracks when explicit IDs
are unnecessary.

Use `defineVideo(shape, compose)` to declare external inputs and infer their
types inside the composition function. `videoParams` exposes Zod builders.
OpenCut treats an omitted parameter file as an empty object and reports
missing required fields, unknown top-level keys, and invalid values with
`params` paths. Use `z.strictObject` for nested records that should also
reject unknown keys. Defaults and transforms resolve before composition.
Keep resolved values JSON-compatible. The composition function can be
asynchronous and runs once per compile. Batch compiles each variant in its
own worker with fresh module state.

The [three-second example](../examples/video/short-batch.video.ts) imports
[sequence, title, subtitle, and soundtrack helpers](../examples/video/batch-sequences.ts).
It places the same two-clip sequence with a dissolve in the intro and outro
using separate scopes. Its [manifest](../examples/video/short-batch.variants.json)
selects landscape, portrait, and square canvases with different titles and
captions. The square variant selects alternate footage and audio.

```sh
opencut validate examples/video/short-batch.video.ts --params examples/video/short-batch.params.json
opencut preview frame examples/video/short-batch.video.ts --params examples/video/short-batch.params.json --frame 12 -o review.png
opencut batch examples/video/short-batch.video.ts --variants examples/video/short-batch.variants.json --output-dir ./outputs --concurrency 2
```

One-shot inspection, frame and clip previews, contact sheets, and subtitle
export accept the same `--params` file as `render`. For a quick comparison,
generate a contact sheet for each parameter file you want to review.

```sh
opencut preview contact-sheet examples/video/short-batch.video.ts \
  --params examples/video/short-batch.params.json --count 4 -o contact.png
```

In the SDK, pass `params` to `compileVideo` and review the resulting
composition with `previewVideo(compiled)`.

## Moving a definition to another machine

Package one resolved parameter selection with
[`opencut package`](CLI.md#portable-projects). Keep the package together
when moving it. The editable files retain their original relative layout
under `project/`. Render the generated `opencut.bundle.video.ts` at the
package root.
A named font file travels with the bundle. The receiving machine supplies
OpenCut, FFmpeg and any system AI backends required by the recipes.

## Professional Dialogue Mix

`professionalMix` enables dialogue cleanup, editable gain automation, music ducking and output loudness management. Set `audioRole` on audio or video tracks to route them as `dialogue`, `music` or `other`. See [settings and examples](AUDIO_MIX.md).

Set `channelMode: 'mono-center'` on an audio or video track to
[center its dialogue in a stereo mix](AUDIO_MIX.md#centered-mono-dialogue).
Use `musicComparison` to choose among
[independently edited music tracks](AUDIO_MIX.md#compare-music-candidates).

## Convert a legacy definition

Run `opencut convert name.video.json` to create a `.video.ts` file beside the
resolved JSON source. The converter handles plain compositions and version 1
parameterized documents. It carries over defaults, constraints, and bindings
into TypeScript. Use the resulting file with normal commands and pass variant
values through `--params params.json`. See the
[conversion command](CLI.md#convert-a-legacy-definition).

## Visual track groups

`visualGroups` isolates a contiguous set of visual tracks, identified by
explicit track IDs in bottom-to-top order. Each track belongs to at most
one group. A group can assign a separate member track as its alpha
`matte`. That track defines visibility of the group's other tracks.
An empty matte is transparent. Supply a group `clip` rectangle in logical
pixels. The group can apply `blur`, then static `scale` and `rotation`
about the canvas center, `x` and `y` offsets, and `opacity` once after
the children combine. Group and effect output is clipped at the project
canvas. `backdropBlur` blurs the actual lower-track picture within the
transformed group alpha. Blend a group with that backdrop using
`normal`, `multiply`, `screen` or `overlay`. The compositor uses
straight-alpha SDR surfaces and premultiplies for spatial blur.
Audio routing follows the original tracks.

An existing `cross-dissolve` can specify a `style` using
`{ kind: 'dip-to-color', color: '#102030' }`,
`{ kind: 'wipe' | 'slide' | 'push', direction: 'left' | 'right' | 'up' | 'down' }`,
`{ kind: 'zoom', amount: 0.18 }` or `{ kind: 'blur', radius: 18 }`.
The same centered, frame-aligned transition window applies between adjacent
pictures on one track. First and last transition frames match their
corresponding endpoints. Timed graphics and video require source handles.
Images and static SVGs hold their source frame throughout the transition,
including before the incoming clip's nominal start. The nominal cut still
controls audio. Directional styles progress linearly by default and accept an optional
`easing: { type: 'cubic-bezier', x1, y1, x2, y2 }` with all four controls
between 0 and 1.

Native subtitle styling accepts `activeWordStyle: { color, background? }`
for timed emphasis. Omitting it preserves existing word-highlight colors.
