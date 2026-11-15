---
name: video-editor
description: Create, review and render video with OpenCut TypeScript or JSON definitions.
---

Make a `.video.ts` or `.video.json` file the source of truth. In TypeScript,
default-export a value constructed with `defineVideo` from `@opencut/sdk`.
Use JSON when executable code is unnecessary. Run `opencut --help` to
discover commands and `opencut render --help` for export controls.

1. Probe inputs with `opencut probe FILE --json`. Reference media paths
   relative to the definition. Keep original media intact. Use ordered asset
   recipes for reusable preprocessing. Run
   `opencut recipes inspect DEFINITION --json` to check the steps without
   transcoding. Use `interpolateFrames` to preserve duration at a higher
   frame rate or `smoothSlowMotion` to extend picture duration and mute it.
   Use `superResolution` for AI upscaling and `denoise` on supported hardware.
   Check [AI recipe support and scene boundaries](references/video-definitions.md#media-recipes).
2. Set canvas size, frame rate, ordered tracks, and clip ranges. Use integer
   frame positions or exact rationals as documented. Add subtitles, effects,
   fades, and transitions to the definition itself.
3. Run `opencut validate DEFINITION --json` and
   `opencut inspect DEFINITION --json`. Inspect exact frames with
   `opencut timeline inspect DEFINITION --frame N --json`.
4. Review the composition with `opencut preview DEFINITION --watch`, the
   desktop **Open definition** action, or a deterministic frame, clip, or
   contact sheet from `opencut preview --help`. TypeScript executes as trusted
   local code. A failed rebuild leaves the last valid preview available.
5. Deliver a new MP4 with `opencut render DEFINITION --output final.mp4`.
   The CLI does not need Electron or a running worker. Export an SRT or VTT
   with `opencut subtitles export DEFINITION --output final.srt` if requested.
6. Probe the result and report what was rendered and checked.

See [definition fields](references/video-definitions.md), the
[CLI reference](references/cli.md), and [SDK usage](references/sdk.md).
