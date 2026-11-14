# OpenCut

OpenCut is a desktop video editor with an Electron timeline, a command-line
interface, and a TypeScript SDK. All three use the same project format and
editing core.

Edit video, audio, titles, and subtitles across multiple tracks. Group edits,
ripple delete, and insert editing share a persistent undo and redo history.
Preview edits in the desktop app or use the CLI to inspect and render a saved
project.

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

- [Timeline editing and shortcuts](docs/TIMELINE_EDITING.md)
- [CLI reference](docs/CLI.md)
- [TypeScript SDK](docs/SDK.md)
- [OpenCut Agent Skill](skills/video-editor/SKILL.md)

## License

OpenCut is available under the [MIT License](LICENSE). The bundled fonts
retain their own SIL Open Font License notices for
[Noto Sans SC](packages/media/fonts/OFL.txt) and
[Noto Emoji](packages/media/fonts/OFL-NotoEmoji.txt).
