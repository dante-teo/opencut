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

| Field                 | Meaning                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas`              | Required `width` and `height` in pixels, integer or rational `frameRate`, and positive `durationFrames`. The optional `backgroundColor` is `#RRGGBB`, `#RRGGBBAA`, or `transparent` and defaults to black.                                                  |
| `assets`              | Optional map of stable names to `{ path, kind }` with `kind` set to `video`, `audio`, or `image`. Use relative paths with forward slashes.                                                                                                                  |
| `tracks`              | Array ordered from bottom to top for visual layers. Each track has a `type`, a `clips` array, and optional `id` and `name`. Video and audio tracks can set `volume` and `muted`.                                                                            |
| All clips             | Required `at`, the zero-based timeline start, and optional `id`.                                                                                                                                                                                            |
| Video and audio clips | Named `asset` of the matching kind, optional `sourceIn` (default 0), required exclusive `sourceOut`, optional rational `speed` (0.25×–4×, default 1×), and optional `volume`, `muted`, `fadeIn`, and `fadeOut`.                                             |
| Image clips           | Named image `asset` and positive `duration` in frames.                                                                                                                                                                                                      |
| Text clips            | Positive `duration` in frames and a `text` object. It requires `content` and can set `fontFamily`, `fontSize`, `fontWeight`, `color`, `alignment`, `wrapWidth`, `stroke`, `shadow`, and `background`. Text defaults to the bundled Noto Sans SC font.       |
| `visual`              | Optional on video, image and text clips. Use center-relative `x` and `y` in canvas pixels, `scale` (0.01–4), `rotation` in degrees, and `opacity` (0–1). Video and image also accept `fit` (`contain`, `cover`, or `stretch`) and fractional `crop` insets. |

All authoring times use integer frames on the canvas frame-rate grid, including
the source points. For example, `sourceIn: 12` at 24 fps starts half a second into
the media. Playback duration is the exact source interval divided by speed.
Fades are clip-local timeline frame counts. Clip and track volumes multiply,
and a mute at either level silences that clip. Video clips include their
embedded audio by default.

Clips on the same track may touch at exclusive boundaries and must not overlap.
Every clip must end within the declared canvas duration. Empty intervals use
the canvas background and have silence when the audio mix is empty. The MP4
ends at exactly `durationFrames`, including any trailing gap. The current
renderer takes at most 64 clips and 600 seconds, a frame rate of 1–120 fps, and
even dimensions up to 3840 pixels per side and 3840×2160 pixels total.
Transparent canvas areas are flattened over black in MP4 and PNG previews.

Asset names and authored IDs use letters, digits, underscores and hyphens and
start with a letter or digit. Use distinct IDs across tracks, clips and assets.
Generated track IDs derive from track content, with a suffix for identical
tracks. Generated clip IDs derive from the owning track and start frame.
Supply explicit IDs when you want references to survive edits to those inputs.

## Inspect, preview and render

`validate` checks the schema, timeline, render constraints, media kinds and source
bounds. `inspect --json` returns the compiled project fields, exact rational
duration, and revision 0. Both use ffprobe for declared media and can validate
asset-free videos without media tools. Use `preview frame --frame N --output FRAME.png`
to sample the same composition used for MP4. `render --json` prints one result
on stdout after verified publication. TypeScript console messages go to stderr.

Each compilation captures a frozen project snapshot, its render plan and its
source metadata. Edits to the definition after compilation apply on the next
invocation. Validation and rendering do not save a project or add editing
history. Render and preview commands publish a new output only after
verification. Send SIGINT (Ctrl-C) or SIGTERM to request cancellation.
If a TypeScript definition is stalled, send a second signal to terminate the
CLI. Saved projects continue to use `project render` and the
project editing commands.

SDK callers can use `compileVideo(file, { signal })` to obtain the definition
`path` and the frozen `project`. Pass the project to the shared evaluator for
frame inspection, or spread the result of `await video.resolveRender()` into
the existing headless media renderer. That method reuses the current build's
source probe results.
