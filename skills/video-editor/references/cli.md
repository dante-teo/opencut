# OpenCut CLI at T02

Run commands at the root of an installed checkout. Build with `pnpm build` if
`apps/cli/dist/index.js` does not exist.
To build only the headless packages and CLI, run `pnpm build:packages` followed by
`pnpm --filter @opencut/cli build`.

```sh
pnpm cli --help
pnpm cli --version
# Direct executable forms after building:
node apps/cli/dist/index.js --help
./apps/cli/dist/index.js --version
node apps/cli/dist/index.js probe /path/to/video.mp4 --json
node apps/cli/dist/index.js extract-frame /path/to/video.mp4 --timestamp 0.5 --output /path/to/new-frame.png --json
```

`opencut` is the workspace-local executable, not a globally installed command.
No arguments and `--help`/`-h` show usage; `--version`/`-v` print the application
version. Help takes precedence when both options are present.

Direct invocation writes results to stdout and errors to stderr. pnpm scripts
may add their own lifecycle logs, so use the Node/bin form for exact output.
Exit codes: 0 success, 2 invalid arguments, 1 media/filesystem/prerequisite or
execution failure. Unknown options/commands and extra arguments fail.

`probe <file> [--json]` inspects a local readable file. JSON contains `path`,
`formatName`, `startTimeSeconds`, `durationSeconds`, `hasAudio`, selected `video`/`audio` stream objects
(or `null`), and all `streams`. Stream fields include codec, dimensions, average
frame rate and its rational ratio, duration, start time, time base, bit rate,
language, disposition flags, pixel format, audio sample rate, channels and layout.
Missing/inapplicable metadata is `null`. Default streams are preferred, then the
first stream; attached pictures are excluded from the selected video.

`extract-frame <file> --timestamp <seconds> --output <file.png> [--json]`
extracts one PNG at the first available frame at or after the requested time.
The time is relative to input start, in nonnegative decimal seconds (rounded to
FFmpeg's microsecond precision). The input start timestamp is reported as
`startTimeSeconds`. Timestamps at or beyond the selected video's known end fail;
its end relative to input start is `video.startTimeSeconds - startTimeSeconds + video.durationSeconds`.
Start timestamps may be negative; keep their signs when computing offsets.
Incomplete timing falls back to the reported media duration or an extraction
attempt. A seek beyond the last decodable frame also fails. JSON contains absolute
`path`, absolute `sourcePath`, requested `timestampSeconds`, and `streamIndex`.
The source is never modified. Use a new
`.png` path in an existing directory; existing files and symlinks are refused.
`timestampSeconds` preserves the requested value before FFmpeg precision rounding.

`probe` requires external `ffprobe` on PATH; extraction also requires `ffmpeg`
with PNG support. Install prerequisites manually. Each subprocess has a 60-second
limit and bounded output (4 MiB for probe; 64 MiB for extraction). Runtime failures
produce no JSON on stdout; errors remain text on stderr. Both commands provide
human-readable output when `--json` is omitted.

For filenames starting with `-`, place options before `--` and the filename,
or use an absolute path. For an output name starting with `-`, use
`--output=-frame.png` or an absolute path. Quote paths in the calling shell.
The complete [CLI/API contract](../../../docs/CLI.md) describes all fields and
limits. Project editing, playback, rendering and GUI media commands do not exist.
