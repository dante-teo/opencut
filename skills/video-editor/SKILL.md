---
name: video-editor
description: Create, review and render video with OpenCut TypeScript definitions.
---

Default-export a value from `defineVideo` in a `.video.ts` file. Import
`defineVideo` from `@opencut/sdk`. Run `opencut --help` to
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
   contact sheet from `opencut preview --help`. Authored TypeScript executes as
   trusted local code. Preview defaults to `fast`. Use `--quality quality`
   to review the final AI recipe processing. A failed rebuild leaves the
   last valid preview available.
5. Deliver a new MP4 with `opencut render DEFINITION --output final.mp4`.
   The CLI defaults to `quality` and runs directly. Use `--quality maximum`
   for slower MP4 encoding with the same AI algorithms as `quality`.
   Export an SRT or VTT
   with `opencut subtitles export DEFINITION --output final.srt` if requested.
6. For variants, use `defineVideo(shape, compose)` with `videoParams` and
   reusable TypeScript helpers. Validate a sample with `--params params.json`.
   Run `opencut batch DEFINITION --variants variants.json --output-dir outputs --json`.
   Read each result and retry corrected entries with `--only id,id`.
7. If interrupted, run `opencut build inspect DEFINITION --json` with the
   same cache, quality and parameters. Retry to reuse verified recipes and restart
   unfinished encoding. For transfer, run `opencut package DEFINITION --output bundle`
   and `opencut package verify bundle`. Render `bundle/opencut.bundle.video.ts`
   with the required backends.
8. Probe the results and report dimensions, frame counts, failed variants,
   and recipe cache reuse when relevant.

See [definition fields](references/video-definitions.md), the
[CLI reference](references/cli.md), and [SDK usage](references/sdk.md).
