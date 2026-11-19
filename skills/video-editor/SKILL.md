---
name: video-editor
description: Create, revise, preview and render complete videos headlessly with the installed OpenCut CLI and TypeScript SDK.
---

On Apple Silicon with macOS 15 or later, see the
[installation guide](../../docs/INSTALL.md). Run `opencut doctor --json` to
check FFmpeg, ffprobe, native workers and optional model readiness.

Treat `.video.ts` and its imports as executable local code. Run definitions
you authored for the task or that the user explicitly authorized. Validation,
inspection, preview and packaging all execute the definition.

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
   Preserve authored quality; never silently downsize a source or substitute a
   lighter model to satisfy an unsupported processor.
   Check [AI recipe support and scene boundaries](references/video-definitions.md#media-recipes).
2. Set canvas size, frame rate, ordered tracks, and clip ranges. Use integer
   frame positions or exact rationals as documented. Add subtitles, effects,
   fades, and transitions to the definition itself.
3. Run `opencut validate DEFINITION --json` and
   `opencut inspect DEFINITION --json`. Inspect exact frames with
   `opencut timeline inspect DEFINITION --frame N --json`.
4. Review the composition with `opencut preview DEFINITION --watch`, the
   desktop **Open definition** action, or a deterministic frame, clip, or
   contact sheet from `opencut preview --help`. Preview defaults to `fast`.
   Use `--quality quality` to review offline AI processing, such as 4×
   super-resolution. A failed watch rebuild leaves the last valid preview
   available. Desktop review keeps the playhead at the same timeline time
   across rebuilds, including frame-rate changes, and clamps it to the last
   frame if the revision ends earlier. Select a clip, subtitle, or transition
   to pause on the first frame at or after its start. A selection made during
   loading takes effect when the preview is ready.
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
8. Probe the final MP4 and decode samples around cuts, caption changes and
   interpolated frames. Play the output with audio to check timing. Record
   the definition, input hashes, effective profile, worker versions, recipe
   results and verification.

Start with the [complete example and visual review loop](references/workflow.md).
See [definition fields](references/video-definitions.md), the
[CLI reference](references/cli.md), and [SDK usage](references/sdk.md).

For dialogue cleanup and automatic music ducking, route audio or video tracks
with `audioRole: 'dialogue'`, `'music'` or `'other'` and enable
`professionalMix` in the definition. Use `opencut mix analyze <file.video.ts> --json`
for editable curves and a loudness report before encoding picture. See the
[mix definition, delivery presets and offline AI options](../../docs/AUDIO_MIX.md).
