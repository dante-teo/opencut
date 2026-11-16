# OpenCut

OpenCut is a local video rendering engine for video as code.
Define a complete video in one TypeScript (.video.ts) file and render it from
the CLI.

```sh
opencut validate my-video.video.ts
opencut preview frame my-video.video.ts --frame 48 --output review.png
opencut render my-video.video.ts --output final.mp4
```

The CLI, TypeScript SDK and Electron review app share the same timeline
evaluator and rendering pipeline. Use Electron to watch a definition and
export a reviewed revision.

## Install

Use pnpm or the Homebrew tap for the Apple Silicon CLI. The macOS review app
is a separate download. See the [installation guide](docs/INSTALL.md) for
release availability, system requirements and optional AI model setup.

## Run from source

On macOS, install Node.js 24.12 or later within the 24.x series, pnpm 11.20.0,
and Apple’s Command Line Tools for Xcode or Xcode itself. The build compiles
a native RSS helper against the macOS SDK. Run from the repository root:

```sh
pnpm install
pnpm dev
```

Install FFmpeg and ffprobe for rendered previews and video export. See the [full quick start](docs/README.md) for
details.

## Documentation

- [Video-as-Code reference and runnable examples](docs/VIDEO_DEFINITIONS.md)
- [Media preprocessing recipes](docs/VIDEO_DEFINITIONS.md#media-preprocessing-recipes)
- [Architecture and compatibility](docs/ARCHITECTURE.md)
- [CLI reference](docs/CLI.md)
- [TypeScript SDK](docs/SDK.md)
- [OpenCut Agent Skill](skills/video-editor/SKILL.md)

## License

OpenCut is available under the [MIT License](LICENSE). The bundled fonts
retain their own SIL Open Font License notices for
[Noto Sans SC](packages/media/fonts/OFL.txt) and
[Noto Emoji](packages/media/fonts/OFL-NotoEmoji.txt).
