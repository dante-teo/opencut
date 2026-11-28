# OpenCut quick start

OpenCut compiles a TypeScript definition into a video. See [Install OpenCut](INSTALL.md)
for packaged installations. To run from source, install
Node.js 24.12+ within the 24.x series, pnpm 11.20, FFmpeg, and ffprobe.
On macOS, install Apple’s Command Line Tools for Xcode or Xcode itself to
build the native RSS helper. The VideoToolbox AI workers require the
macOS 26 SDK. From a checkout, run:

```sh
pnpm install
pnpm build:packages
pnpm --filter @opencut/cli build
node apps/cli/dist/index.js --help
```

Generate the synthetic media with `pnpm fixtures:generate` to run the
[showcase](VIDEO_DEFINITIONS.md#run-the-example). From the repository root:

```sh
node apps/cli/dist/index.js validate examples/video/showcase.video.ts
node apps/cli/dist/index.js render examples/video/showcase.video.ts --output showcase.mp4
```

Use the [parameterized short-video example](VIDEO_DEFINITIONS.md#reusable-functions-and-parameters)
to render landscape, portrait, and square variants from the same TypeScript
definition. The example uses the synthetic media from the previous step.

```sh
node apps/cli/dist/index.js batch examples/video/short-batch.video.ts \
  --variants examples/video/short-batch.variants.json --output-dir ./outputs --json
```

Run `node apps/cli/dist/index.js preview examples/video/showcase.video.ts --watch`
to rebuild a playable MP4 as you edit. Open the printed path in your video
player. Use [frame, clip and contact-sheet previews](VIDEO_DEFINITIONS.md#inspect-preview-and-render)
to review specific points in the edit.

- [Definition format and examples](VIDEO_DEFINITIONS.md)
- [React and SVG graphics](GRAPHICS.md)
- [CLI commands](CLI.md)
- [Compare revisions and trace a delivered shot](CLI.md#review-a-revision)
- [Reuse verified video packets for a picture revision](CLI.md#local-picture-revisions)
- [Transcribe media and align corrected captions](CLI.md#local-transcription-and-corrected-timing)
- [Build recovery and portable projects](CLI.md#build-recovery)
- [TypeScript SDK](SDK.md)
- [Export and rendering limits](EXPORT.md)
- [Architecture](ARCHITECTURE.md)
- [Preview and export conformance](PREVIEW_EXPORT_CONSISTENCY.md#video-as-code-conformance)
- [Professional Dialogue Mix](AUDIO_MIX.md)
