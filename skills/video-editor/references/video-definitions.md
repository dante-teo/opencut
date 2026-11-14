# Author a whole video

Use `.video.ts` or `.video.json` when starting from media and delivering a
rendered video. In TypeScript, import `defineVideo` from `@opencut/sdk` and
default-export the object through that function. TypeScript executes as trusted
Node code once per command. Repeated SDK builds refresh local ESM imports,
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
  Validation and migration enforce the 256-cue full-render limit. A frame
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
opencut preview frame opening.video.json --frame 24 --output opening.png
opencut render opening.video.json --output opening.mp4
opencut probe opening.mp4 --json
```

Read `frameCount` from validation to check the output length, including
inferred durations. Run the same commands with a `.video.ts` input. Use new output paths in an
existing directory. If TypeScript evaluation stalls after cancellation,
send a second SIGINT (Ctrl-C) or SIGTERM to terminate the command. Review
frames at meaningful boundaries and verify duration,
frame rate, dimensions and audio after rendering. For complete 20-second
definitions and fixture setup, see [Video as code](../../../docs/VIDEO_DEFINITIONS.md).

For existing projects, use `opencut migrate PROJECT --output NEW.video.json --json`.
Use a `.video.ts` extension to generate a TypeScript default export. Migration
rebases paths from the original project to the new definition. It checks that
the render plan matches and reports omitted history. See the
[complete field reference](../../../docs/VIDEO_DEFINITIONS.md#author-a-definition)
before changing a migrated definition.
