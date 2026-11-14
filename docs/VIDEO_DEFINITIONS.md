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
erasable TypeScript syntax. The command evaluates the entry module once per
compilation as trusted local code. Relative and absolute local ESM imports are
evaluated afresh with the entry module. Bare package imports use Node's
normal module cache. The CLI does runtime validation. The TypeScript compiler
can check the authoring type separately.

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
  `{ time, value, easing }` using the [project easing rules](PROJECT_FORMAT.md#visual-keyframes-t37).
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
  audio-track clip for the legacy behavior that pads short audio to match
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

### Evaluation order

The compositor selects the source frame, grades its pixels, applies crop,
fit and clip transforms, and scales alpha by clip opacity. Transitions
weight the fitted layers before they composite over lower tracks and the
canvas. The audio renderer maps and retimes each source, applies its
`effects` array in order, then applies the clip envelope and clip/track
gain before mixing and limiting the result. The effect types are
`eq`, `compressor`, `limiter`, `de-esser` and `reverb`. See the
[project format](PROJECT_FORMAT.md) and [CLI reference](CLI.md) for the
shared property limits.

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

## Inspect, preview and render

`validate` checks the schema, timeline, media kinds, source bounds and
full-render constraints. Its JSON output includes `{ ok, path, frameCount }`.
The frame count is available for both declared and inferred durations.
`inspect --json` returns the compiled project fields, exact rational duration
and revision 0. Both commands use ffprobe for declared media and can run without
media tools for asset-free definitions.

Full renders support up to 256 distinct subtitle cues that appear on the
output frame grid. `validate`, `inspect` and `migrate` check this limit before
any render. `preview frame --frame N --output FRAME.png` counts only the cues
visible in the selected frame, so a long subtitle track can still be reviewed
one frame at a time. `render --json` prints one result on stdout after verified
publication. TypeScript console messages go to stderr.

Each compilation captures a frozen project snapshot, its render plan and its
source metadata. Edits to the definition after compilation apply on the next
invocation. Validation and rendering do not save a project or add editing
history. Render and preview commands publish a new output only after
verification. Send SIGINT (Ctrl-C) or SIGTERM to request cancellation.
If a TypeScript definition is stalled, send a second signal to terminate the
CLI. Saved projects continue to use `project render` and the
project editing commands.

SDK callers can use `compileVideo(file, { signal })` to obtain the definition
`path`, frozen `project` and computed `frameCount`. Pass the project to the
shared evaluator for frame inspection, or spread the result of
`await video.resolveRender()` into the headless media renderer. That method
reuses the current build's source probe results. For a frame or range preview,
use `compileVideo(file, { signal, preview: true })` and pass the selected
range to the renderer. The renderer applies the subtitle limit to that range.

## Convert a saved project

```sh
opencut migrate edit.opencut.json --output edit.video.json --json
opencut migrate edit.opencut.json --output edit.video.ts
```

Migration reads the saved snapshot and publishes a new definition. It retains
the canvas and duration mode, stable IDs, track stacking, exact rational
times, effects, subtitle metadata, markers, embedded fonts and referenced
media. It re-expresses media paths relative to the new definition's directory.
Keep those referenced files available. Existing freeze-frame PNGs stay
referenced as image assets. Repeated embedded font bytes are stored once in
the definition. Saved editing history is omitted and reported as
`historyOmitted` in JSON output.

Conversion checks the source project, probes its media and checks that the
compiled definition has the same render plan before writing. Unknown format
versions, unsupported render settings, missing media, and paths that cannot
be rebased cause an explicit error. The source project and its assets are
read-only. The destination must be a new file in an existing directory.

The SDK also exposes `migrateProject(source, output, { signal })`, which
returns `{ path, sourcePath, historyOmitted }` on success.

The native migration test covers mixed video and stills, eased visual animation,
a cross-dissolve, canvas fades, grading, ordered audio effects, exact gain and
source times, and styled subtitles with word timing. It compares matching
preview PNGs and MP4 exports from the original and converted compositions.
The comparison is exact for both outputs in that fixture. PNG-to-MP4
comparisons can show the encoder's color and chroma differences.
