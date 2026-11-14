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

- The canvas duration is the exact output frame count, including trailing gaps.
  Use integer fps or `{ "numerator": 30000, "denominator": 1001 }` for fractional fps.
- Visual tracks composite bottom to top. Within a track, clips may touch at
  exclusive boundaries. Every clip must fit inside the declared duration.
- Video and audio clips use `asset`, `at`, `sourceIn` (default 0), and exclusive
  `sourceOut`. All are frame indices on the canvas grid except the asset name.
  Optional rational `speed` divides the source interval to get the timeline
  duration. Use `volume`, `muted`, and clip-local `fadeIn`/`fadeOut` frame counts.
- Image clips use an image asset and `at`/`duration`. Text clips use
  `at`/`duration` and a `text` object with `content` and optional styling.
  Visual clips accept `visual` with center-relative `x`/`y`, `scale`, `rotation`,
  and `opacity`. Video and image also accept `fit` and fractional `crop`.
- Use explicit track and clip IDs to retain identity across edits. All explicit
  IDs and asset names must be distinct.

```sh
opencut validate opening.video.json
opencut inspect opening.video.json --json
opencut preview frame opening.video.json --frame 24 --output opening.png
opencut render opening.video.json --output opening.mp4
opencut probe opening.mp4 --json
```

Run the same commands with a `.video.ts` input. Use new output paths in an
existing directory. If TypeScript evaluation stalls after cancellation,
send a second SIGINT (Ctrl-C) or SIGTERM to terminate the command. Review
frames at meaningful boundaries and verify duration,
frame rate, dimensions and audio after rendering. For complete 20-second
definitions and fixture setup, see [Video as code](../../../docs/VIDEO_DEFINITIONS.md).
