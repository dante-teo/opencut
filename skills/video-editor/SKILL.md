---
name: video-editor
description: Use the OpenCut CLI to inspect media, extract PNG frames, or concatenate video clips with background music into an H.264/AAC MP4. Project and timeline editing are not available.
---

# OpenCut CLI

This is the official product skill for external coding agents using OpenCut.
It will grow with the CLI to cover project inspection, modification, validation
and rendering. T03 includes a composition/export prototype; project and timeline
editing remain unavailable.

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
node apps/cli/dist/index.js compose /path/to/clip1.mp4 /path/to/clip2.mp4 --music /path/to/music.wav --output /path/to/new-composition.mp4 --json
```

Probing needs `ffprobe` on PATH; extraction/composition also need `ffmpeg`. Never silently
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

For composition arguments, timing, gains and result fields, read
[the composition reference](references/cli.md#composition). Provide 2–16 timed
video clips in order and a background audio file. The default output is
1280×720 at 30 fps, with letterboxing, 48 kHz stereo audio, original gain 1 and
music gain 0.25. Use `--clip-volume 0` for music only. Music loops/trims to fit;
the duration is the sum of frame-rounded video durations, up to 600 seconds.
Use a new `.mp4` path in an existing directory. Original clips are read only;
existing destinations and symlinks are refused. Read back the resulting metadata
and decode or play the output before claiming delivery. Composition is an FFmpeg
spike, with a 10-minute encoder limit; it requires FFmpeg 8+ with libx264/AAC and
standard filters. It is not the final rendering architecture.

Do not invent project, import, edit, validate, render or MCP commands. Explain
the current limitation when a workflow needs them. Probing reads metadata;
it does not validate full-file decodability.
