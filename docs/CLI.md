# OpenCut CLI

`opencut --help` lists the primary commands. From a checkout use
`node apps/cli/dist/index.js` after `pnpm build:packages` and
`pnpm --filter @opencut/cli build`. FFmpeg and ffprobe are required for
rendering media. Use `opencut system inspect --json` for hardware diagnostics.

```sh
opencut validate edit.video.ts
opencut inspect edit.video.ts --json
opencut timeline inspect edit.video.ts --frame 60 --json
opencut preview edit.video.ts --watch
opencut preview frame edit.video.ts --frame 60 --output review.png
opencut render edit.video.ts --output final.mp4
opencut subtitles export edit.video.ts --output captions.srt
```

Use `opencut render --help` for quality, resolution, codec, frame rate and
audio settings. Outputs are new files unless a supported render explicitly
requests `--overwrite`. Use `--json` for machine output and SIGINT or SIGTERM
to cancel foreground work. Render runs in the CLI with FFmpeg subprocesses.

Media tools include `probe`, `extract-frame`, and `separate-dialogue` on
source paths. Choose a destination that supports hard links for
`extract-frame` so it can publish the completed PNG atomically. Dialogue
separation requires a separately installed ELUATE model.

`online search` reads a JSON request. `online download` returns the downloaded
file's path and provenance for use in a definition. Cancelling an in-flight
frame extraction or download discards partial output.

See the [definition reference and examples](VIDEO_DEFINITIONS.md).
