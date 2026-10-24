---
name: video-editor
description: Use the OpenCut CLI to inspect local media metadata and extract PNG frames at specified timestamps, or check available commands and version. Editing workflows are not available in T02.
---

# OpenCut CLI

This is the official product skill for external coding agents using OpenCut.
It will grow with the CLI to cover project inspection, modification, validation
and rendering. **Editing commands do not exist in T02.**

From an installed and built OpenCut checkout, run `pnpm cli --help` to discover
supported capabilities and `pnpm cli --version` to check the application version.
If the CLI has not been built, run `pnpm build` from the checkout root first.
For a CLI-only build, run `pnpm build:packages` and then
`pnpm --filter @opencut/cli build`.
For result fields, direct executable forms, safety rules and exit codes, read
[the current CLI reference](references/cli.md) when needed.

Implemented media commands (use the direct Node form for clean JSON stdout):

```sh
node apps/cli/dist/index.js probe /path/to/video.mp4 --json
node apps/cli/dist/index.js extract-frame /path/to/video.mp4 --timestamp 0.5 --output /path/to/new-frame.png --json
```

Probing needs `ffprobe` on PATH; extraction also needs `ffmpeg`. Never silently
install these tools. Inspect metadata before selecting a timestamp. Use finite,
nonnegative decimal seconds relative to input start, below the selected video's
known end. Compute that end as `video.startTimeSeconds - startTimeSeconds + video.durationSeconds`
when all three fields are known; it includes any delay before the video starts.
Preserve negative start timestamps when calculating that offset.
A seek beyond the last available frame can still fail. Unknown metadata is
`null`; audio-only files have no video to extract. Frame rate is an average.

Choose an explicit new `.png` output in an existing directory. Extraction never
overwrites existing files or symlinks and does not modify the source. Read back
the result and inspect the saved PNG before claiming delivery. Errors are text
on stderr even with `--json`; check exit status before parsing stdout.

Do not invent project, import, edit, validate, render or MCP commands. Explain
the current limitation when a workflow needs them. Probing reads metadata;
it does not validate full-file decodability.
