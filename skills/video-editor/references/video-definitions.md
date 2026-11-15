# Author a whole video

Use `.video.ts` or `.video.json` when starting from media and delivering a
rendered video. In TypeScript, import `defineVideo` from `@opencut/sdk` and
default-export the object through that function. TypeScript executes as trusted
Node code once per compilation. A default export can also be a promise that
resolves to the definition. Repeated builds refresh local ESM imports,
while package imports follow Node's normal cache. JSON contains the same
object as plain data.

```json
{
  "version": 1,
  "name": "Opening",
  "canvas": {
    "width": 640,
    "height": 360,
    "frameRate": 24,
    "durationFrames": 480
  },
  "assets": {
    "intro": { "path": "media/intro.mp4", "kind": "video" }
  },
  "tracks": [
    {
      "type": "video",
      "clips": [
        {
          "asset": "intro",
          "at": 0,
          "sourceIn": 12,
          "sourceOut": 108,
          "volume": 0.6
        }
      ]
    },
    {
      "type": "text",
      "clips": [
        {
          "at": 12,
          "duration": 72,
          "text": { "content": "Opening", "fontSize": 48 }
        }
      ]
    }
  ]
}
```

This example requires a video source at least 4.5 seconds long. Put `media/`
beside the definition. Resolve media paths relative to that file using forward
slashes. Inspect the source with `opencut probe` to choose valid source points.

- Use `durationFrames` for an exact output frame count with trailing gaps.
  Omit it to derive duration from the last clip or subtitle. Set it explicitly
  for audio-only or blank canvases. Visual tracks composite bottom to top.
  A video track can contain video, image and text clips in one lane.
- Clip `at` is timeline-relative. `sourceIn` and exclusive `sourceOut` use
  the source clock. These fields accept project-frame numbers or rational
  seconds. Use `duration` for a still or title with a zero source in point.
  A rational `speed` divides the source interval to get playback duration.
  Titles appear on project ticks within their exact timeline intervals.
- Visual clips accept `visual` and `keyframes`. Video and images also accept
  `grade` with a curve. Keyframe times use exact clip-local seconds, as do
  audio `gainKeys` and custom fade durations. Use ordered clip `effects`,
  clip and track `volume` and `muted` when mixing audio.
- Use explicit IDs for clips referenced by `transitions`. Use a
  `cross-dissolve` for adjacent video clips with handles, or `fade-in` and
  `fade-out` for video opacity at the clip edges.
- Use `subtitles: { style, cues }` with exact timeline seconds for cue
  bounds, clip-independent per-cue styling and cue-relative word timings.
  Validation enforces the 256-cue full-render limit. A frame
  preview counts only the cues visible in that frame.
  Use a named `font` on a title or subtitle style with a matching `fonts`
  entry. A font entry takes a definition-relative TTF/OTF path or base64 data.
- Use an image clip for a freeze. To derive the image from a video, set its
  asset `kind` to `image`, give it the video path, and set `freezeFrame` to
  the exact source timestamp in rational seconds from the start of the video
  stream.

```sh
opencut validate opening.video.json --json
opencut inspect opening.video.json --json
opencut preview opening.video.json --watch --json
opencut preview frame opening.video.json --frame 24 --output opening.png
opencut preview contact-sheet opening.video.json --from 0 --to 48 --count 4 --output sheet.png
opencut preview clip opening.video.json --from 0 --to 48 --output review.mp4
opencut render opening.video.json --output opening.mp4
opencut probe opening.mp4 --json
```

Run watch in a separate terminal or use **Open definition** in Electron.
Read `current.generation` and `current.path` from `ready` events.
On an `error` event, `current` holds the last playable revision if one exists.
Watch tracks local ESM imports, including dynamic imports used to resolve the
default export, along with referenced fonts and media. Stop watch with Ctrl-C
when review ends. To keep a preview, write a named output with a one-shot
command or copy the current MP4 before it is replaced. For timeline seconds, use
`--timestamp` in place of `--frame`. Range ends are exclusive.

Read `frameCount` from validation to check the output length, including
inferred durations. Run the same commands with a `.video.ts` input. Use new output paths in an
existing directory. If TypeScript evaluation stalls in a one-shot command after cancellation,
send a second SIGINT (Ctrl-C) or SIGTERM to terminate the command. Review
frames at meaningful boundaries and verify duration,
frame rate, dimensions and audio after rendering. For complete 20-second
definitions and fixture setup, see [Video as code](../../../docs/VIDEO_DEFINITIONS.md).

## Media recipes

Set `recipe` on an asset to run steps in order. Available types are `trim`,
`crop`, `resize`, `frameRate`, `interpolateFrames`, `smoothSlowMotion`,
`superResolution`, `denoise`,
`extractAudio`, `normalizeAudio`, and `convert`.
Set `kind` to the final result and use processed time for clip source ranges.
Recipe trims use seconds from the input container start and retain the
selected audio stream when it overlaps the trim.
Use `visual.crop` for a crop that belongs to an individual timeline clip.
The [recipe reference](../../../docs/VIDEO_DEFINITIONS.md#media-preprocessing-recipes)
includes step parameters and paired TypeScript and JSON examples.

For local AI interpolation use `{ "type": "interpolateFrames", "numerator": 48 }`
on 24 fps video. This preserves picture duration and the relative timing of
the selected picture and audio. The first retained stream becomes time zero.
For half-speed
picture use `{ "type": "smoothSlowMotion", "numerator": 30, "speed": 0.5 }`;
its duration doubles and the result is silent. Set optional `quality` to
`fast`, `balanced` (default), or `high`. Specify known shot cuts in
`sceneCuts` using seconds from the first picture frame entering that step.
Use the declared cadence from the preceding interpolation step when choosing
a target for a chained step. Match the canvas cadence to the final processed
video to show every synthesized frame.
These steps require a supported Apple Silicon Mac on macOS 26+. Inspect
hardware with `opencut system inspect --json`. On unsupported inputs the
step fails. See the [AI recipe reference](../../../docs/VIDEO_DEFINITIONS.md#ai-interpolation).

For AI upscaling, set `{ "type": "superResolution", "backend": "videotoolbox",
"width": 3840, "height": 2160, "quality": "high" }` on a 16:9 asset.
Use 2160 × 3840 for 9:16. Match the canvas to deliver UHD. Put `trim` before
enhancement to select a range on the source container's clock. A later
`trim` uses the derived clock, where the first retained stream starts at
zero and the relative audio delay is preserved. `fast` uses a size-dependent
1.5× or 2× model.
`high` uses Apple's temporal 4× model and resizes to the target. For
`denoise`, choose `light`, `medium`, or `strong` and check temporal
noise-filter support before use. AI enhancement accepts constant-rate,
progressive, square-pixel, 8-bit video-range SDR input. If the color matrix
tag is missing, OpenCut resolves it from the input dimensions and codec
before enhancement. Recipe order determines whether enhancement runs
before or after interpolation. Compare
the processed sequence with a Lanczos resize when judging detail and
temporal consistency. See the [enhancement reference](../../../docs/VIDEO_DEFINITIONS.md#ai-enhancement).
