# CLI reference (T03)

Build from the checkout root with `pnpm build`. The `opencut` executable is
workspace-local. Use the direct Node form for machine-readable stdout; pnpm
scripts can add lifecycle logs.

For a CLI-only build, run `pnpm build:packages` followed by
`pnpm --filter @opencut/cli build`. This builds the headless packages and CLI
without building or launching the desktop app.

```sh
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js --version
node apps/cli/dist/index.js probe tests/fixtures/generated/video-medium.mp4 --json
node apps/cli/dist/index.js extract-frame tests/fixtures/generated/video-medium.mp4 --timestamp 0.5 --output tests/fixtures/generated/frame.png --json
node apps/cli/dist/index.js compose tests/fixtures/generated/video-short.mp4 tests/fixtures/generated/video-medium.mp4 --music tests/fixtures/generated/audio-tone.wav --output tests/fixtures/generated/composition.mp4 --width 640 --height 360 --json
```

The media examples require the synthetic fixtures. Generate them explicitly
with `pnpm fixtures:generate` if absent; see the
[fixture contract](../tests/fixtures/README.md). The output parent directory must
already exist, and the output file must not exist.

## Commands

- No arguments, `--help`, or `-h`: print usage. Help takes precedence over version.
- `--version` or `-v`: print the application version.
- `probe <file> [--json]`: inspect a readable local file with ffprobe.
- `extract-frame <file> --timestamp <seconds> --output <file.png> [--json]`:
  extract one video frame with ffprobe and FFmpeg. Seconds must be a finite,
  nonnegative decimal number, such as `0`, `0.5`, or `12.25`.
- `compose <clip1> <clip2> [more clips] --music <audio> --output <new.mp4> [--json]`:
  concatenate video clips in argument order and mix their original audio with music.

Options can precede the input. For filenames beginning with `-`, put all options
before `--`, followed by the filename, or use an absolute path. For an output
name starting with `-`, use `--output=-frame.png` or an absolute path. Quote paths
containing spaces in the calling shell.

All media commands print a readable summary by default. `--json` prints one JSON
object followed by a newline, without progress or diagnostics on stdout.
Errors always go to stderr as text, including with `--json`.

Exit codes: **0** success, **2** invalid command/arguments, **1** media, filesystem,
prerequisite or execution failure. Unknown commands/options and extra positional
arguments fail. `--timestamp` applies only to extraction; `--output` applies to
extraction and composition. Composition options are rejected by other commands. `--json`
applies only to media commands.

## Probe JSON

| Field              | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `path`             | Absolute input path                                                                      |
| `formatName`       | ffprobe container name, or `null`                                                        |
| `startTimeSeconds` | Container start timestamp in seconds, or `null`; stream starts use the same time base    |
| `durationSeconds`  | Container duration, falling back to the maximum known stream duration; `null` if unknown |
| `hasAudio`         | Whether any audio stream is present                                                      |
| `video`            | Default non-cover-art video stream, falling back to the first; `null` if absent          |
| `audio`            | Default audio stream, falling back to the first; `null` if absent                        |
| `streams`          | Every stream, including subtitles, data and attached pictures                            |

Each stream contains `index`, `type`, `codec`, `durationSeconds`,
`startTimeSeconds`, `timeBase`, `bitRate`, `language`, `isDefault`,
`isAttachedPicture`, `width`, `height`, `frameRate`, `frameRateRatio`,
`pixelFormat`, `sampleRate`, `channels`, and `channelLayout`. Missing or
inapplicable numeric/string fields are `null`. Stream indices refer to the
original input. Dimensions are coded pixel dimensions. `frameRate` is the average
FPS; `frameRateRatio` preserves its rational representation, such as
`30000/1001`. An average rate does not imply constant-rate video. Unknown or
invalid rates such as `0/0` become `null`. Still images can have unknown duration.
Inspection reads metadata; it does not verify that every frame is decodable.
Start timestamps may be negative; preserve their signs when calculating offsets.

## Frame JSON and file safety

The extraction result contains `path` (absolute output), `sourcePath` (absolute
input), `timestampSeconds` (requested time), and `streamIndex` (selected video).
It saves one PNG without modifying the source. The timestamp is relative to the
input start, rounded to FFmpeg's microsecond precision. FFmpeg seeks accurately
and selects the first available frame at or after that time. An exact frame at
every timestamp is not guaranteed.

A timestamp at or beyond the selected video's known end relative to the input
start is rejected: `video.startTimeSeconds - startTimeSeconds + video.durationSeconds`.
For example, a two-second video starting at 5s in a file starting at 0s ends at 7s;
5.5s is a valid request. An input starting at 10s with video starting at 15s and
lasting two seconds has the same 7s end relative to input start. When stream timing
or the input start is unavailable, the reported media duration is used if known.
Unknown bounds are checked by attempting extraction. Extraction fails if FFmpeg
produces no frame, including after a seek beyond the last available frame.
Audio-only media and files containing only attached cover art have no extractable
video stream. The result's
`timestampSeconds` retains the requested value before rounding to FFmpeg precision.

The destination must end in `.png`. Existing files, directories and symlinks are
refused; no overwrite option is provided. PNG bytes are decoded and checked for
the PNG signature before exclusive output creation, so subprocess failures leave
no output file. Disk write failures can leave an incomplete newly created output;
review it before removing it. Parent directories are not created automatically.

## Composition prototype

`compose` is a T03 technical spike in the headless media package, using one
FFmpeg filter graph. It does not define a project format or timeline API.

| Option           | Default  | Accepted values                                  |
| ---------------- | -------- | ------------------------------------------------ |
| `--music`        | required | Readable local file with an audio stream         |
| `--output`       | required | New `.mp4` in an existing writable directory     |
| `--width`        | 1280     | Even integer, 2–3840                             |
| `--height`       | 720      | Even integer, 2–2160                             |
| `--fps`          | 30       | Integer, 1–60                                    |
| `--clip-volume`  | 1        | Decimal linear gain, 0–1; 0 mutes original audio |
| `--music-volume` | 0.25     | Decimal linear gain, 0–1; 0 mutes music          |

Provide 2–16 clips with a timed video stream and a known positive duration.
Still images, audio-only clips and unknown-duration inputs are rejected. Default
video/audio streams are selected using the same rules as `probe`; only that audio
stream is mixed, even if a clip contains several. Subtitles/data are not exported.

Each selected video's first frame begins its segment. Prefer its stream duration;
if absent, subtract its start offset relative to the input from the reported media
duration. For that calculation, a missing input start is zero and a missing video
start uses the input start. Unknown or nonpositive durations are rejected.

Each segment is rounded to the nearest output frame, with a minimum of one frame.
At 1 fps, even a clip lasting only 1/60 second contributes one second to the export.
The export lasts the sum of these frame-aligned durations, at most 600 seconds.
Frames can be duplicated or dropped during frame-rate conversion; the last frame
is held if rounding extends a clip. Input display aspect ratio is
preserved with square pixels and centered black letterboxing, without cropping.
Output is constant-frame-rate H.264 (`libx264`, CRF 20, veryfast), yuv420p, with
AAC 192 kb/s, 48 kHz stereo audio and MP4 faststart.

Original audio is resampled/downmixed to stereo, positioned relative to its
video's start timestamp, padded with silence or trimmed to that segment. Leading
audio before the video is dropped; delayed audio retains its gap. Missing start
timestamps assume aligned starts. Clips without audio supply silence. Background
audio starts at zero, loops when shorter and is trimmed when longer than the
composition. Gaps in background audio timestamps are filled with silence before
trimming, preserving the position of later music. Gains remain stable through
silent clips; a latency-compensated limiter prevents clipping. There is no
ducking, loudness normalization or crossfade; music loop boundaries can be audible.
This spike is intended for ordinary SDR media;
HDR/color management and damaged or misleading input timing are not validated.

Composition JSON contains absolute `path`, ordered absolute `clipPaths`, absolute
`musicPath`, frame-aligned planned `durationSeconds`, `width`, `height`, `fps`,
`clipVolume`, `musicVolume`, and measured `metadata` in the Probe JSON schema.
The metadata path points to the final destination. Before publishing, the command
checks codecs, dimensions, frame rate, audio configuration, container and stream
durations (each within max(0.1s, one frame) of planned duration), A/V duration
agreement (within 0.1s), and container/stream starts (within 0.05s of zero).
Native tests additionally decode the full export and check frame
counts, source images, mixed tone frequencies and synchronization markers.

FFmpeg renders into an owned temporary directory beside the destination.
After verification, an atomic exclusive hard link publishes the MP4; existing
files, directories, hard-link aliases and symlinks (including dangling ones) are
refused. Temporary renders are cleaned on success and handled failures, leaving
no partial final output. The destination filesystem must support hard links;
there is no overwrite option. A forced termination of the parent process can
leave an `.opencut-compose-*` temporary directory. Inputs are read only.

## Headless media API

Workspace consumers declare `"@opencut/media": "workspace:*"` as a dependency
and build the headless packages before importing it. The package exports
`probeMedia(file)`,
`extractFrame(file, timestampSeconds, output)`, `composeMedia(options)`,
their TypeScript option/result types, and `MediaError`.

```ts
import { composeMedia } from '@opencut/media';

const result = await composeMedia({
  clips: ['/path/to/clip1.mp4', '/path/to/clip2.mp4'],
  music: '/path/to/music.wav',
  output: '/path/to/new-composition.mp4',
  width: 640,
  height: 360,
  fps: 30,
  clipVolume: 1,
  musicVolume: 0.25,
});

console.log(result.path, result.durationSeconds, result.metadata);
```

Only `clips`, `music` and `output` are required. Optional fields use the same
defaults and bounds as the CLI options above; CLI `--clip-volume` and
`--music-volume` correspond to API `clipVolume` and `musicVolume`. The returned
`CompositionResult` has the same fields as composition JSON. Tool prerequisites,
timing rules, output protection and filesystem requirements also apply to API
calls. The CLI owns argument parsing, stdout/stderr and exit codes; the media
package runs independently of Electron and React.

## External tools and limits

Put `ffprobe` on PATH to probe; extraction also needs `ffmpeg` with PNG support.
Composition needs FFmpeg with `libx264`, AAC, and the standard scale, pad, fps,
concat, aresample, amix and alimiter filters, including scale's `reset_sar` option
(FFmpeg 8+; validated here with FFmpeg 9).
Install them manually through your preferred package manager. OpenCut does not
install, download or bundle media executables. Help/version, ordinary unit tests,
and the desktop placeholder do not need them.

Node's built-in `execFile` is sufficient for this small subprocess boundary;
no wrapper dependency or native binding is required. Arguments are passed
without a shell, inputs are resolved to absolute local files, and child stdin
is closed. Probe/extraction subprocesses have a 60-second limit; the composition
encoder has a 10-minute wall-clock limit. ffprobe/encoder stdout and stderr are
bounded to 4 MiB each and PNG/stderr to 64 MiB each. Exceeding a bound is an execution error.
Error-level tool diagnostics fail the command even if the tool exits zero.

The subprocess and JSON behavior follows the official
[Node child-process API](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
and [ffprobe documentation](https://ffmpeg.org/ffprobe.html).

## Verification

`pnpm test` covers metadata normalization, absent streams, command validation,
missing tools, execution failures and output protection without requiring media
tools. For real CLI probing and PNG extraction, generate fixtures if absent, then
run `pnpm test:media`. This explicit native suite requires FFmpeg/ffprobe and the
five generated fixtures; missing prerequisites fail with a nonzero exit. It
compares extracted pixels against an independent timestamp-selected decode,
checks all fixture metadata, exercises delayed video with zero/nonzero input
starts, literal filenames and failure paths, and creates derived delayed-video
inputs and PNG outputs only in its own subdirectory under
`tests/fixtures/generated/`. That subdirectory is cleaned on success or failure;
the five base fixtures are read without modification.

The same command runs T03 integration tests against silent, mono and stereo
clips at different sizes/rates, fractional-rate video with early/delayed 44.1 kHz
audio and nonzero starts, background looping, gain controls and destination safety.
It also checks one-frame 60/120 fps clips converted to 1/30 fps, and PCM music with
80ms/one-second timestamp gaps, including audible content after each gap and a
loop boundary. Decoded tone pulses and video flashes check sync, and source hashes
ensure that the base fixtures remain unchanged. Unit tests also cover failed render cleanup,
metadata verification and destination races without requiring media tools.

Timeline editing, project files, a final rendering architecture, playback and GUI media
integration are not implemented.
