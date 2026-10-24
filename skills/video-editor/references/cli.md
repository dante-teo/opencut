# OpenCut CLI at T06

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
node apps/cli/dist/index.js compose /path/to/clip1.mp4 /path/to/clip2.mp4 --music /path/to/music.wav --output /path/to/new-composition.mp4 --json
node apps/cli/dist/index.js project create /path/to/new.opencut.json --name "My project" --fps 30000/1001 --json
node apps/cli/dist/index.js project info /path/to/new.opencut.json --json
node apps/cli/dist/index.js project validate /path/to/new.opencut.json --json
```

`opencut` is the workspace-local executable, not a globally installed command.
No arguments and `--help`/`-h` show usage; `--version`/`-v` print the application
version. Help takes precedence when both options are present.

Direct invocation writes results to stdout and errors to stderr. pnpm scripts
may add their own lifecycle logs, so use the Node/bin form for exact output.
Exit codes: 0 success, 2 invalid arguments, 1 project validation/data,
media/filesystem/prerequisite or execution failure. Unknown options/commands,
extra arguments and inapplicable options fail. Repeated options use the last value.
Errors remain text on stderr with `--json`. Help and version also accept `--json`, returning
`{ "help": "..." }` and `{ "name": "OpenCut", "version": "0.1.0" }` respectively.
The application version and project `schemaVersion` identify different contracts;
use `schemaVersion` when checking project-format compatibility.

## Projects

Project commands run without Electron, FFmpeg or ffprobe. Each takes an explicit
project-file path, relative to the working directory or absolute; result paths are
absolute. No directory discovery, automatic parent creation or extension requirement
exists. Prefer `.opencut.json` and quote paths containing spaces. Use `--` before
a positional filename beginning with `-`.

`project create <project-file> --name <name> [--width <px>] [--height <px>] [--fps <n|n/d>] [--json]`
creates an empty version 1 project with a UUID and UTC timestamps. Name must be
nonblank. Dimensions default to 1920×1080 and must be positive safe integers.
Frame rate defaults to 30/1; integer or rational components must be positive safe
integers (maximum 9007199254740991). Decimal `29.97` is rejected; use `30000/1001`.
These are model settings without encoder-specific restrictions. Ratios are preserved.
Creation validates inputs before opening the destination and refuses existing files,
directories and symlinks, including dangling ones. There is no overwrite flag.
The parent must exist. A write failure may leave a partial newly created file.

`project info <project-file> [--json]` validates data and returns metadata,
settings and asset/track/clip counts. Offline media does not prevent info.
Creation and info JSON contain `path`, `schemaVersion`, `metadata` (`id`, `name`,
`createdAt`, `updatedAt`), `settings` (`width`, `height`, rational `frameRate`) and
`statistics` (`assets`, `tracks`, `clips`).

`project validate <project-file> [--json]` checks schema/version, unique IDs,
internal references, media compatibility, timestamps and source ranges. Once data
passes, it checks every referenced file for readability, resolving relative media
paths from the project file's directory. It does not decode or probe media.
The report contains `path`, `valid`, `structureValid`, `issues` and `media`.
Issues have JSON-pointer `path`, `code`, `message`; media entries have `assetId`,
resolved `path`, `status`, `message`. Statuses are `available`, `missing`, `unreadable`,
`not_file` and `unsupported_path`. Data errors yield `structureValid: false` with
issues and no media checks. Offline projects yield `structureValid: true` but
`valid: false`. Exit 0 requires valid data and all media available; otherwise exit 1.

Validation failures still return the requested report on stdout with diagnostics
on stderr. File-read or execution failures return no stdout report. Check exit
status before using results. Info and validate never modify projects or media.
Run `project --help` or `project create|info|validate --help` for scoped usage.

## Media inspection and frame extraction

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

## Composition

`compose <clip1> <clip2> [more clips] --music <audio> --output <new.mp4> [--json]`
concatenates 2–16 video clips in argument order. Each needs a timed video stream
and known positive duration; still images and audio-only clips fail. Default
video/audio streams are selected as for probe; only one audio stream per clip
is used. Original audio and background music are mixed by default.

Options: `--width` (1280, even integer 2–3840), `--height` (720, even integer
2–2160), `--fps` (30, integer 1–60), `--clip-volume` (1, decimal 0–1),
`--music-volume` (0.25, decimal 0–1). Zero gain mutes that source.
Unknown or inapplicable options fail. `--timestamp` does not apply to composition.

Output uses H.264/yuv420p, AAC 192 kb/s, 48 kHz stereo and MP4 faststart. Video is
scaled without cropping, letterboxed and converted to the requested constant
frame rate with square pixels. Segments begin at their video's first frame;
each video duration is rounded to the nearest output frame, minimum one frame.
At 1 fps, this minimum is one second per clip, even for very short inputs.
The sum is capped at 600 seconds. Original audio keeps its offset relative to
the video, with silence for gaps/missing audio and trimming at segment boundaries.
Unknown stream starts assume alignment. Music starts at zero and loops/trims to
fit; timestamp gaps, including gaps below 100ms, are filled with silence so later
music keeps its position.
Gains stay stable through silent clips; a latency-compensated limiter avoids
clipping. Loop boundaries may be audible; there is no crossfade or ducking.

JSON contains `path`, ordered `clipPaths`, `musicPath` (all absolute), planned
`durationSeconds`, `width`, `height`, `fps`, `clipVolume`, `musicVolume` and
measured `metadata` using the probe schema. Before publishing, codecs, dimensions,
FPS, audio configuration, container/stream durations and A/V duration agreement
are checked, along with container/stream starts within 0.05s of zero. The
encoder has a 10-minute wall-clock limit and 4 MiB stdout/stderr limits.
FFmpeg 8+ with libx264, AAC and standard filters is required (tested with 9).

Use a new `.mp4` in an existing writable directory supporting hard links. A
verified temporary render is published atomically without overwriting existing
files or symlinks. Temporary files are cleaned on handled failures; forced process
termination may leave `.opencut-compose-*` beside the destination. Source media
is not modified. This is an SDR composition spike; HDR/color management,
misleading source timing, project files and timeline editing are outside scope.

## Prerequisites and paths

`probe` requires external `ffprobe` on PATH; extraction also requires `ffmpeg`
with PNG support. Install prerequisites manually. Probe/extraction subprocesses have a 60-second
limit and bounded output (4 MiB for probe; 64 MiB for extraction). Runtime failures
produce no JSON on stdout; errors remain text on stderr. All media commands provide
human-readable output when `--json` is omitted.

For filenames starting with `-`, place options before `--` and the filename,
or use an absolute path. For an output name starting with `-`, use
`--output=-frame.png` or an absolute path. Quote paths in the calling shell.
The complete [CLI/API contract](../../../docs/CLI.md) describes all fields and
limits. Project editing, playback and GUI media commands do not exist.
