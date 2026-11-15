# OpenCut quick start

OpenCut compiles a TypeScript or JSON definition into a video. Install
Node.js 24.12+ within the 24.x series, pnpm 11.20, FFmpeg, and ffprobe. From
a checkout, run:

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
node apps/cli/dist/index.js render examples/video/showcase.video.json --output showcase.mp4
```

Run `pnpm dev` for the optional Electron app. **Open definition** watches
the chosen file and its inputs, shows the last playable revision, and lets
you export it. **Open video** plays a local source file. Edit the definition
in your usual text editor.

- [Definition format and examples](VIDEO_DEFINITIONS.md)
- [CLI commands](CLI.md)
- [TypeScript SDK](SDK.md)
- [Export and rendering limits](EXPORT.md)
- [Architecture](ARCHITECTURE.md)
- [Preview and export conformance](PREVIEW_EXPORT_CONSISTENCY.md#video-as-code-conformance)
