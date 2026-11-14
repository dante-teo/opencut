# OpenCut

OpenCut is a local video editor for authoring and rendering video as code.
Define a complete video in one TypeScript or JSON file and render it from
the CLI.

```sh
opencut validate my-video.video.ts
opencut preview frame my-video.video.ts --frame 48 --output review.png
opencut render my-video.video.ts --output final.mp4
```

The CLI, TypeScript SDK and Electron review app share the same timeline
evaluator and rendering pipeline. Saved projects also support persistent
undo and redo for interactive editing through the CLI or SDK.

## Run from source

On macOS, install Node.js 24.12 or later within the 24.x series and pnpm
11.20.0, then run these commands from the repository root:

```sh
pnpm install
pnpm dev
```

Install FFmpeg and ffprobe for media import, rendered previews, and video
export. See the [full quick start](docs/README.md#quick-start-macos) for
details.

## Documentation

- [Video-as-Code reference and runnable examples](docs/VIDEO_DEFINITIONS.md)
- [Timeline editing and shortcuts](docs/TIMELINE_EDITING.md)
- [CLI reference](docs/CLI.md)
- [TypeScript SDK](docs/SDK.md)
- [OpenCut Agent Skill](skills/video-editor/SKILL.md)

## License

OpenCut is available under the [MIT License](LICENSE). The bundled fonts
retain their own SIL Open Font License notices for
[Noto Sans SC](packages/media/fonts/OFL.txt) and
[Noto Emoji](packages/media/fonts/OFL-NotoEmoji.txt).
