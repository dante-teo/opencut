# CLI reference (T08)

Build from the checkout root with `pnpm build`. The `opencut` executable is
workspace-local. Use the direct Node form for machine-readable stdout; pnpm
scripts can add lifecycle logs.

For a CLI-only build, run `pnpm build:packages` followed by
`pnpm --filter @opencut/cli build`. This builds the headless packages and CLI
without building or launching the desktop app.

```sh
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js --version
node apps/cli/dist/index.js project create /path/to/new.opencut.json --name "My project" --width 1920 --height 1080 --fps 30000/1001 --json
node apps/cli/dist/index.js project info /path/to/new.opencut.json --json
node apps/cli/dist/index.js project validate /path/to/new.opencut.json --json
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
- `project create <project-file> --name <name> [--width <px>] [--height <px>] [--fps <n|n/d>] [--json]`:
  create an empty version 1 project without overwriting.
- `project info <project-file> [--json]`: display validated metadata, settings and collection counts.
- `project validate <project-file> [--json]`: validate project structure, internal references and media availability.
- `project --help` and `project create|info|validate --help`: show project usage.
- `media import <project-file> <file> [--json]`: import a source reference and metadata.
- `media list <project-file> [--json]`: list stored assets and source availability.
- `media info <project-file> <asset-id> [--json]`: inspect a stable asset ID.
- `media remove <project-file> <asset-id> [--json]`: remove an unreferenced asset entry.
- `media --help` and `media import|list|info|remove --help`: show asset usage.
- `timeline list <project-file> [--json]`: inspect tracks, clips and exact timing.
- `track add <project-file> --type <video|audio> --name <name> [--json]`: append a track.
- `track remove <project-file> <track-id> [--json]`: remove an empty track.
- `clip add <project-file> <asset-id> --track <track-id> --at <frame> --in <frame> --out <frame> [--json]`: place an asset range.
- `clip move <project-file> <clip-id> [--track <track-id>] [--at <frame>] [--json]`: move without changing source points.
- `clip trim <project-file> <clip-id> [--in <frame>] [--out <frame>] [--json]`: change source points with a fixed timeline start.
- `clip split <project-file> <clip-id> --at <frame> [--json]`: split strictly inside a clip.
- `clip remove <project-file> <clip-id> [--json]`: remove only that clip.
- `timeline|track|clip --help`: show editing usage and time semantics.
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

All commands print readable output by default. `--json` prints one JSON
object followed by a newline, without progress or diagnostics on stdout.
Errors always go to stderr as text, including with `--json`.

Exit codes: **0** success, **2** invalid command/arguments, **1** failed project
validation, invalid project data, media, filesystem, prerequisite or execution failure.
Unknown commands/options, extra positional arguments and options that do not apply
to the command fail. Repeated options use the last value, matching Node's parser
and existing media commands. `--name` applies to project creation and track creation;
`--width`, `--height` and `--fps` apply to project creation and composition with
the distinct bounds below. `--timestamp` applies only to extraction; `--output`
applies to extraction and composition. Help with `--json` returns `{ "help": "..." }`;
version with `--json` returns `{ "name": "OpenCut", "version": "0.1.0" }`.
The application version is separate from the project file's `schemaVersion`;
use the latter to identify the supported project format.

## Projects

Project commands run independently of Electron and need no FFmpeg/ffprobe.
`<project-file>` is always an explicit file location, with no implicit project discovery
or directory creation. Relative paths resolve from the process working directory;
results report absolute paths. Quote paths with spaces. Any filename extension is
accepted; `.opencut.json` is suggested. Use `--` before a positional path beginning
with `-`. Paths must be nonblank and contain no control characters.

Creation requires a nonblank `--name`. Defaults are 1920×1080 at 30/1 fps, matching
the T05 core model. Width and height must be positive safe integers (up to
9007199254740991), with no even-dimension or encoder-specific restriction.
`--fps` accepts a positive safe integer or a rational with positive safe integer
components, such as `24` or `30000/1001`. Decimal rates such as `29.97` are rejected;
use an exact ratio. Ratios are preserved as supplied. These project settings are
data-model values, not a promise that a future renderer supports every value.
The core generates a stable UUID and UTC creation/update timestamps. Assets,
tracks and clips start empty. Inputs are validated before opening the destination.
The parent must exist; existing files, directories and symlinks, including dangling
symlinks, are refused. No force/overwrite mode exists. A disk write failure can
leave a partially written newly created file. Media import/remove use the separate
atomic update path described below.

Creation and info JSON have the same shape:

```json
{
  "path": "/path/to/demo.opencut.json",
  "schemaVersion": 1,
  "metadata": {
    "id": "example-project",
    "name": "Demo",
    "createdAt": "2026-10-25T00:00:00.000Z",
    "updatedAt": "2026-10-25T00:00:00.000Z"
  },
  "settings": {
    "width": 1920,
    "height": 1080,
    "frameRate": { "numerator": 30, "denominator": 1 }
  },
  "statistics": { "assets": 0, "tracks": 0, "clips": 0 }
}
```

Info validates project data before returning metadata and counts. Offline media
does not prevent info from succeeding; info performs no media availability checks.
Neither info nor validate modifies project data, timestamps, references or media.

Validation JSON contains `path`, `valid`, `structureValid`, `issues` and `media`.
`structureValid` includes schema, supported version, unique IDs, asset/track
references, compatible media types, timestamps and source ranges. Each issue has
a JSON-pointer `path`, `code` and actionable `message`. Invalid JSON or structure
returns `structureValid: false` and an empty `media` array. Once data is valid,
every asset is checked for regular-file readability, with paths anchored to the
project file's directory. Each media entry has `assetId`, resolved `path`, `status`
and `message`. Statuses are `available`, `missing`, `unreadable`, `not_file` and
`unsupported_path`. Validation checks no codecs, decoding, timing or stream content.

`valid` is true only when structure and every availability check pass. Missing
media leaves the project data usable (`structureValid: true`), but validation
returns exit 1 so automation can detect unresolved references. Invalid projects
still produce a report on stdout, including with `--json`, plus diagnostics on
stderr. Check the exit status and report. Missing/unreadable project files and
other execution failures produce only stderr diagnostics with no stdout report.
See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for the shared core API and file contract.

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

## Timeline editing

T08 uses the shared, filesystem-free core operations. The CLI is a parsing and
persistence adapter. Every command takes an explicit project path, resolved from
cwd, and supports `--json` and `--help`. No Electron, FFmpeg, ffprobe, decoding or
source-file availability is needed for editing. Asset metadata is a stored snapshot.
Use `media import` first to obtain `asset.id`; track/clip creation returns stable
UUIDs. Subsequent operations take those IDs, never array indices.

All CLI time arguments (`--at`, `--in`, `--out`) are **nonnegative safe integer
frame indices at the project's frame rate**, including source in/out points.
They are not source-file frame numbers or decimal seconds. At 30000/1001 fps,
frame 30 is exactly 1001/1000 seconds. Integer seconds, sample positions or source
frame indices must be converted deliberately when using these CLI flags. The core
API also accepts arbitrary exact rational seconds, preserving existing subframe
and sample offsets. Neither interface rounds, snaps or inspects actual VFR frames.
Out points and timeline ends are exclusive. One-frame clips are valid.

Choose source points against the stored rational `asset.duration`, rather than
rounding decimal metadata to a nearby frame. For a two-second asset at
30000/1001 fps, frame 60 is 2.002 seconds and fails the source bound; the largest
allowed integer out point is frame 59. In general, use the floor of duration
multiplied by the project frame rate, computed from their exact rational
components. A source end between project frames remains representable directly
through the rational core API. The workflow below assumes the asset permits at
least source frame 90.

```sh
node apps/cli/dist/index.js media import /work/demo.opencut.json /media/camera.mp4 --json
node apps/cli/dist/index.js track add /work/demo.opencut.json --type video --name "Video 1" --json
node apps/cli/dist/index.js track add /work/demo.opencut.json --type audio --name "Audio 1" --json
# Substitute the returned ASSET_ID, TRACK_ID and CLIP_ID:
node apps/cli/dist/index.js clip add /work/demo.opencut.json ASSET_ID --track TRACK_ID --at 30 --in 15 --out 75 --json
node apps/cli/dist/index.js timeline list /work/demo.opencut.json --json
node apps/cli/dist/index.js clip move /work/demo.opencut.json CLIP_ID --at 60 --json
node apps/cli/dist/index.js clip trim /work/demo.opencut.json CLIP_ID --in 30 --out 90 --json
node apps/cli/dist/index.js clip split /work/demo.opencut.json CLIP_ID --at 90 --json
node apps/cli/dist/index.js clip remove /work/demo.opencut.json CLIP_ID --json
# Remove the other clip returned by split before removing its populated track:
node apps/cli/dist/index.js clip remove /work/demo.opencut.json RIGHT_CLIP_ID --json
node apps/cli/dist/index.js track remove /work/demo.opencut.json TRACK_ID --json
```

- `track add` requires a nonblank name and type `video` or `audio`, and appends the track.
  Removing a populated track fails with its clip IDs; explicitly move or remove them first.
- `clip add` requires an existing asset and compatible track plus all three time
  options. Video tracks accept video/image assets; audio tracks require audio.
  An AV asset may be placed independently on either type. No linked clip is created.
- `clip move` requires `--track`, `--at` or both. Omitted values stay unchanged.
  Source points, duration, asset ID and clip ID are preserved.
- `clip trim` requires `--in`, `--out` or both. Omitted points stay unchanged.
  **Timeline start stays fixed**; changing the source range changes duration at 1x.
  Extending a range is allowed within the asset bound and available track space.
- `clip split --at` uses an **absolute timeline position**, strictly between the
  clip's timeline start and end. Left keeps the original ID; right gets a new UUID.
  The exact source split is `sourceIn + (at - timelineStart)`. Both pieces reference
  the same asset and track; their source ranges are contiguous, and total duration
  and timeline coverage are unchanged. The right entry is inserted after the left.
- `clip remove` leaves a gap and preserves all assets, tracks and other clips.

Clips play at 1x. Source ranges must be nonnegative, nonempty and end no later
than the asset's recorded rational duration when known. **Unknown-duration assets,
including images, require explicit ranges and have no inferred finite source bound.**
Editing does not establish that unknown or stale ranges are decodable; validate
media separately. Images use their selected range as a duration at the model level.

**Same-track overlaps are forbidden for video and audio.** Touching exclusive
boundaries, gaps, and overlap across different tracks are allowed. Add, move and
trim reject collisions instead of shifting clips or choosing another position.
Splits create exactly adjacent pieces. Loading, saving and project validation
apply the same overlap rule, including unsorted hand-edited documents. Pre-T08
files with same-track overlaps are now invalid; resolve their positions/ranges in
JSON before using edit commands. There is no silent migration. Derived durations
and ends must fit safe rational JSON components; arithmetic overflow fails without
rounding. No ripple, implicit track creation, speed changes, linked AV operations,
undo/redo, multi-command transactions, project rendering or GUI integration exists.

`timeline list` returns `{ path, frameRate, duration, tracks }`. All times are
`{ numerator, denominator }` in exact seconds; `duration` is the maximum clip
end, or zero for an empty timeline. Tracks retain insertion order and contain
`id`, `name`, `type`, and `clips` ordered by timeline start. Each listed clip
contains the stored `id`, `assetId`, `trackId`, `timelineStart`, `sourceIn`,
`sourceOut`, plus derived `duration` and `timelineEnd`. Derived fields are not saved.

Mutation JSON results are:

| Command              | Result                     |
| -------------------- | -------------------------- |
| `track add`          | `{ path, track }`          |
| `track remove`       | `{ path, removedTrackId }` |
| `clip add/move/trim` | `{ path, clip }`           |
| `clip split`         | `{ path, left, right }`    |
| `clip remove`        | `{ path, removedClipId }`  |

`track` and `clip` use the stored model fields; mutations do not include derived
timing. Mutation paths are canonical absolute paths; list retains the requested
absolute path. Successful changes update `metadata.updatedAt` without going
backwards; exact no-op moves/trims preserve bytes and timestamps. Read back
`timeline list` after mutations. Inspection never writes. Mutations reuse the
[asset atomic-save guarantees](#project-media-assets): writer lock, validation
before publishing, synced temporary JSON and same-directory rename, refusal of
project-file symlinks/hard links, and outside-change detection. Invalid edits
leave original project bytes intact and clean owned locks/temporaries.

Errors preserve the existing CLI contract: text diagnostics on stderr even with
`--json`, no success JSON on failed commands, exit 1 for invalid edits/data/I/O,
and exit 2 for malformed or inapplicable arguments. Check exit status before
parsing stdout. Diagnostics identify IDs or JSON-pointer fields, source bounds
and colliding clips. Core errors expose machine-readable codes and validation
issues; see [the API contract](PROJECT_FORMAT.md#timeline-editing-api).

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

## Project media assets

```sh
node apps/cli/dist/index.js media import /path/to/demo.opencut.json /path/to/video.mp4 --json
node apps/cli/dist/index.js media list /path/to/demo.opencut.json --json
node apps/cli/dist/index.js media info /path/to/demo.opencut.json ASSET_ID --json
node apps/cli/dist/index.js media remove /path/to/demo.opencut.json ASSET_ID --json
```

Replace `ASSET_ID` with the stable `asset.id` from import or the asset list.

`media import <project-file> <file> [--json]` imports one video, audio or image.
It probes with the existing external ffprobe utility and stores a source reference,
name, stable UUID, media types and metadata. Files are read in place without
copying, moving or modifying them. Unsupported formats, streams without video/audio,
missing sources and unreadable sources fail before a project update is published.
Metadata probing does not guarantee full-file decodability.

Both input arguments resolve from the working directory. Source symlinks resolve
to their real target; stored references prefer normalized forward-slash paths
relative to the project directory, including `..`. Project directory aliases
resolve to the physical parent directory consistently for import, asset inspection
and project media validation. Different filesystem roots or
unrepresentable relative paths use absolute references. Quote spaces and literal
punctuation; use `--` before positional paths beginning with `-`.
Reimporting the same path, normalized alias, symlink or hard link returns the
existing asset with `imported: false`, without probing or changing project bytes
or timestamps. Different files with identical bytes remain distinct assets;
there is no content hashing or metadata refresh operation.

For example, if `/links/project` points to `/work/project`, importing
`/work/media/video.mp4` into `/links/project/demo.json` stores
`../media/video.mp4`. List, info and project validation resolve that reference
to `/work/media/video.mp4` through either project-directory path. Directory
symlinks are supported; mutations still refuse a symlink at the project filename.
Import/remove return the canonical project `path`; list/info/validate retain the
requested absolute project `path` and report resolved media locations separately.

Import JSON contains `path` (project), `imported`, `asset`, `source` and
`referencedBy`. `asset` contains the persisted project asset described in
[PROJECT_FORMAT.md](PROJECT_FORMAT.md#fields-and-invariants). Its optional
`metadata` records `kind` (`video`, `audio`, `image`), `formatName`,
`durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `frameRate`,
`frameRateRatio` and `hasAudio`. Unknown or inapplicable metadata is `null`.
Still images have no duration or frame rate; their `mediaTypes` contains `video`
to represent visual media in the existing model. Animated GIF/APNG with known
duration are video assets. Imported positive duration also becomes the model's
rational `duration`, rounded to microseconds. Metadata survives project reloads.

`media list <project-file> [--json]` returns `{ path, assets }`; each entry has
`asset`, `source`, `referencedBy`. `media info <project-file> <asset-id> [--json]`
returns `{ path, asset, source, referencedBy }`. `source` contains `assetId`,
resolved `path`, `status` and actionable `message`, using the same availability
statuses as project validation. `referencedBy` lists clip IDs. These commands
read stored metadata and check source readability without probing or writing.
They succeed for offline assets so their metadata remains inspectable; use
`project validate` when every source must be available. Legacy assets without
stored metadata remain inspectable. Unknown asset IDs fail with exit 1.

`media remove <project-file> <asset-id> [--json]` removes only an unreferenced
project entry, even if its source is missing. JSON is `{ path, removedAssetId }`.
Any referencing timeline clip blocks removal and is named in the error. No force
flag or original-file deletion exists.

Import and removal validate project data, update `updatedAt`, and publish complete
JSON by a same-directory atomic rename after syncing the temporary file. A
per-project exclusive `.lock` serializes cooperating writers; competing updates
fail with a retry message. Updates refuse project symlinks and hard-linked project
files and check for outside changes before publication. Handled failures preserve
the previous project and clean owned temporary files/locks. Forced termination
can leave `.opencut-update-*` and `<project-file>.lock`; remove a stale lock only
after confirming no writer is running. The rename prevents partial JSON visibility;
power-loss durability and coordination with arbitrary external writers are not
guaranteed. The containing directory must be writable.

Only import requires ffprobe; list/info/remove require no media tools or Electron.
All four commands support human-readable output and scoped `--help`. No other
options apply. They follow existing CLI errors: exit 2 for invalid arguments,
exit 1 for project/media/filesystem/prerequisite failures, diagnostics on stderr
and no JSON success result on failure, including with `--json`.

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
install, download or bundle media executables. Project commands, help/version, ordinary unit tests,
and basic desktop playback do not need them. Desktop frame stepping needs ffprobe for average FPS.

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

`pnpm test` includes standalone project CLI integration tests for creation and
readback, integer/rational frame rates, populated-project statistics, malformed
JSON, unsupported versions, broken internal references and offline media. These
tests run with an empty `PATH` to check independence from media tools. They cover
invalid arguments, repeated-option overrides, literal paths, existing destinations,
symlinks and missing parent directories, and verify that inspection and validation
preserve project and source-file contents. Temporary project JSON and text
sentinels are created in owned OS temporary directories and cleaned up after tests.

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

T07 unit/CLI tests cover persisted metadata, legacy assets, duplicate identities,
offline/unreadable sources, invalid media, referenced-asset removal, failed atomic
publication, outside edits and competing writers. Directory-symlink regressions
check that import, list, info and validation resolve the same source, including
when a different readable file exists at the misleading lexical location.
Availability tests also preserve checks for project locations whose parent is
absent. Native tests import all five
fixtures through the built CLI, verify stored metadata and stable IDs after
reload, inspect assets after sources disappear, and verify source hashes before
and after import/removal. Native outputs stay in an owned `t07-*` directory under
`tests/fixtures/generated/`, cleaned on success or failure.

T08 unit/CLI tests cover track/clip operations, exact fractional-rate and sample
timing, split source mapping and total duration, exclusive boundaries, same-track
overlap rejection, offline edits, stable IDs, no-op writes and invalid edits that
preserve original bytes. Native tests use imported video/audio/image fixtures,
read back timeline JSON and project data, validate source bounds, and compare
source hashes. Native outputs stay in an owned `t08-*` directory under
`tests/fixtures/generated/`, cleaned on success or failure.

Project rendering and desktop project integration are not implemented. The existing composition prototype
continues to take media paths directly, independently of projects.
