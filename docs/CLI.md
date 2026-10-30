# CLI reference (T25)

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
- `project render <project-file> --output <file.mp4> [--quality <draft|balanced|high>] [--resolution <project|720p|1080p>] [--overwrite] [--json]`: composite video/image layers with mixed audio tracks to H.264/AAC MP4.
- `project --help` and `project create|info|validate|render --help`: show project usage.
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
- `clip audio <project-file> <clip-id> [--volume <0..1>] [--muted <true|false>] [--json]`: configure clip audio. `clip add` accepts the same optional audio flags.
- `clip split <project-file> <clip-id> --at <frame> [--json]`: split strictly inside a clip.
- `clip remove <project-file> <clip-id> [--json]`: remove only that clip.
- `clip visual <project-file> <clip-id> [--x <px>] [--y <px>] [--scale <n>] [--opacity <0..1>] [--fit <contain|cover|stretch>] [--json]`: configure a visual clip. `clip add` accepts these flags too.
- `canvas set <project-file> [--width <px>] [--height <px>] [--background-color <#RRGGBB>] [--json]`: configure the canvas.
- `timeline|track|clip|canvas --help`: show editing usage and time semantics.
- `edit apply <project-file> <batch.json> [--dry-run] [--expected-revision <n>] [--json]`: commit an atomic batch.
- `edit undo|redo <project-file> [--dry-run] [--expected-revision <n>] [--json]`: restore a transaction.
- `edit history <project-file> [--json]`: inspect the current revision and persistent history.
- `edit --help`: show transaction usage and batch format.
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
object followed by a newline, except `project render` and `cache proxy`, which stream JSONL progress
and terminal events. Cache management prints a terminal `{event:"result",result:...}` object. Diagnostics never go to stdout.
Errors go to stderr. With `--json`, the error is
`{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"..."}}`;
argument errors also include `error.hint`. Without `--json`, errors remain text.

## Shared projects in Electron (T22)

On macOS/Linux, existing editing commands automatically route through Electron
when it owns the project. Timeline, media, project and history queries see that
same session. CLI edits update the open window through events without reopening;
GUI edits are immediately available to CLI queries. Both use one revision and
undo/redo history. A named project's edits are saved before success is returned.
Untitled GUI projects still require their first Save before CLI access.

CLI edits and undo/redo preserve the open timeline's zoom, horizontal/vertical
scroll, Snap toggle and snap threshold. Explicitly opening or reopening a project
resets timeline view settings. Source preview is invalidated independently when
CLI changes arrive.

Use **Open project** to select an older backup, including a copy with the same
project ID or a backup restored at the same path. Its lower revision and stored
history become current in both interfaces. Query `edit history` again before
issuing revision-guarded edits; do not reuse a revision observed before reopening.

Use `edit history` and `--expected-revision` when acting on a prior query. Batch
apply still requires `expectedRevision`. Even without that flag, a proposal
prepared against an active session is rejected if another edit wins first.
`REVISION_CONFLICT`, `SESSION_BUSY` and `PROJECT_LOCKED` mean reload/reconsider
and retry after the competing operation finishes. A second GUI cannot acquire
the same project. Dry-run validates against the same authority without changing
project bytes, history or the visible timeline.

After `SESSION_DISCONNECTED`, `SESSION_CHANGED` or a timeout, query history and
content before retrying: a lost response may follow a successful commit. The CLI
never silently retries a session mutation on disk. After Electron exits/crashes,
new CLI invocations resume independent work on the last complete saved project.

The permanent `<project-file>.opencut-lock` sidecar holds an OS-backed SQLite
lock, not project data. **Do not delete this sidecar:** a crash automatically
releases ownership. A stale socket is replaced by the next session owner.
Legacy `.lock` files still block updates; remove those only after confirming all
old writers have stopped. Do not mix old and T22 writer versions. Local filesystems
are required; Windows session transport and network filesystems are unsupported.
Messages are limited to 64 MiB, with a 30-second idle timeout. The security boundary
is the current OS account. See [the session decision](adr/0011-shared-project-session.md).

Exit codes: **0** success, **2** invalid command/arguments, **1** failed project
validation, invalid project data, media, filesystem, prerequisite or execution failure.
Project-render cancellation exits **130** for SIGINT or **143** for SIGTERM.
Unknown commands/options, extra positional arguments and options that do not apply
to the command fail. Repeated options use the last value, matching Node's parser
and existing media commands. `--name` applies to project creation and track creation;
`--width`, `--height` and `--fps` apply to project creation and composition with
the distinct bounds below. `--timestamp` applies only to extraction; `--output`
applies to extraction, composition and project rendering. Help with `--json` returns `{ "help": "..." }`;
version with `--json` returns `{ "name": "OpenCut", "version": "0.1.0" }`.
The application version is separate from the project file's `schemaVersion`;
use the latter to identify the supported project format.

## Projects

Project commands run independently of Electron. Create/info/validate need no FFmpeg/ffprobe; render requires both tools.
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
data-model values; T12 rendering supports the explicit limits below.
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
- `clip add` optionally accepts `--volume` and `--muted`. `clip audio` updates
  an existing video or audio clip and requires at least one of these flags.
  Volume is decimal linear amplitude gain from 0 to 1, default 1; 0 is silence,
  0.5 halves amplitude and 1 is unchanged. `--muted true|false` defaults to false;
  mute overrides gain without changing the stored volume. Omitted properties
  remain omitted in old files. Split copies both properties; trim/move retain them.
  Audio edits support the same history, dry-run and revision guards as other edits.
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
rounding. No ripple, implicit track creation, speed changes, linked AV operations
or GUI project integration exists. T09 adds transactions and undo/redo
as described below.

`timeline list` returns `{ path, frameRate, duration, tracks }`. All times are
`{ numerator, denominator }` in exact seconds; `duration` is the maximum clip
end, or zero for an empty timeline. Tracks retain insertion order and contain
`id`, `name`, `type`, and `clips` ordered by timeline start. Each listed clip
contains the stored `id`, `assetId`, `trackId`, `timelineStart`, `sourceIn`,
`sourceOut`, plus derived `duration` and `timelineEnd`. Derived fields are not saved.

Mutation JSON results are:

| Command                    | Result                     |
| -------------------------- | -------------------------- |
| `track add`                | `{ path, track }`          |
| `track remove`             | `{ path, removedTrackId }` |
| `clip add/move/trim/audio` | `{ path, clip }`           |
| `clip split`               | `{ path, left, right }`    |
| `clip remove`              | `{ path, removedClipId }`  |

`track` and `clip` use the stored model fields; mutations do not include derived
timing. Mutation paths are canonical absolute paths; list retains the requested
absolute path. Successful changes update `metadata.updatedAt` without going
backwards; exact no-op moves/trims preserve bytes and timestamps. Read back
`timeline list` after mutations. Inspection never writes. Mutations reuse the
[asset atomic-save guarantees](#project-media-assets): writer lock, validation
before publishing, synced temporary JSON and same-directory rename, refusal of
project-file symlinks/hard links, and outside-change detection. Invalid edits
leave original project bytes intact and clean owned temporaries; the ownership sidecar remains.

Errors use structured diagnostics on stderr with `--json`, no success JSON on
failed commands, exit 1 for invalid edits/data/I/O,
and exit 2 for malformed or inapplicable arguments. Check exit status before
parsing stdout. Diagnostics identify IDs or JSON-pointer fields, source bounds
and colliding clips. Core errors expose machine-readable codes and validation
issues; see [the API contract](PROJECT_FORMAT.md#timeline-editing-api).

## Transactions, undo and redo

`edit apply PROJECT BATCH.json [--dry-run] [--expected-revision N] [--json]`
applies a nonempty array of timeline operations as **one transaction**. The
project path is explicit, followed by the batch file path; both resolve from cwd.
Read `edit history PROJECT --json` first and use its `revision` as the batch's
required `expectedRevision`. Legacy projects without history have revision 0.
For example, with an existing imported asset `asset-camera` and revision 0:

```json
{
  "expectedRevision": 0,
  "label": "Place and split camera",
  "operations": [
    {
      "type": "track.add",
      "id": "video-main",
      "name": "Video",
      "mediaType": "video"
    },
    {
      "type": "clip.add",
      "id": "camera",
      "assetId": "asset-camera",
      "trackId": "video-main",
      "at": 0,
      "in": 0,
      "out": 60
    },
    {
      "type": "clip.split",
      "id": "camera",
      "at": 30,
      "rightId": "camera-right"
    }
  ]
}
```

```sh
node apps/cli/dist/index.js edit history /path/to/project.opencut.json --json
node apps/cli/dist/index.js edit apply /path/to/project.opencut.json /path/to/batch.json --dry-run --json
node apps/cli/dist/index.js edit apply /path/to/project.opencut.json /path/to/batch.json --json
node apps/cli/dist/index.js edit undo /path/to/project.opencut.json --expected-revision 1 --json
node apps/cli/dist/index.js edit redo /path/to/project.opencut.json --expected-revision 2 --json
```

Batch objects allow only `expectedRevision`, optional nonblank `label`, and
`operations`. Operation objects are strict; unknown fields/types fail. All IDs
follow the project ID rules. Time fields are nonnegative safe integer **project
frame indices**, including source points; the same exact rational conversion and
T08 validation apply. No media probing, source changes or rendering occurs.

| Operation `type` | Required fields besides `type`           | Optional fields                                     |
| ---------------- | ---------------------------------------- | --------------------------------------------------- |
| `track.add`      | `name`, `mediaType` (`video` or `audio`) | `id`                                                |
| `track.remove`   | `id`                                     | —                                                   |
| `clip.add`       | `assetId`, `trackId`, `at`, `in`, `out`  | `id`, `volume`, `muted`, `visual`                   |
| `clip.audio`     | `id`                                     | `volume`, `muted` (at least one)                    |
| `clip.visual`    | `id`                                     | `x`, `y`, `scale`, `opacity`, `fit` (at least one)  |
| `canvas.set`     | —                                        | `width`, `height`, `backgroundColor` (at least one) |
| `clip.move`      | `id`, at least one of `trackId` / `at`   | remaining destination field                         |
| `clip.trim`      | `id`, at least one of `in` / `out`       | remaining source field                              |
| `clip.split`     | `id`, `at`                               | `rightId`                                           |
| `clip.remove`    | `id`                                     | —                                                   |

Omitted new IDs become UUIDs. Supply explicit IDs when later operations in the
same batch must reference a newly added track/clip or the right side of a split.
Each operation sees the preceding result. Every intermediate state must be valid:
a temporary overlap or removing a populated track fails even if a later operation
would repair it. Any failure discards the entire batch without changing saved
content, revision, undo or redo. Diagnostics include the failing operation's
one-based index and type. An empty batch is invalid.

`edit undo PROJECT` restores the previous transaction's exact content, including
metadata timestamps, IDs, rational representations and collection ordering.
`edit redo PROJECT` restores that transaction's after-state without replaying
commands or regenerating IDs. Each apply/undo/redo that changes state increments
the revision once, even when undo returns to earlier content. New changed edits
clear redo; equivalent no-op moves/trims and batches whose edits cancel out leave
history, revision and file timestamps unchanged. Generated `updatedAt` changes alone
do not count as a content change. Undo/redo with no available entry fails with exit 1.

Existing `track`, `clip`, `media import` and `media remove` mutations each record
one transaction through the same writer. Duplicate imports and no-op edits add
nothing. Asset undo/redo restores references and stored metadata only; it never
modifies source files or re-probes. Batch operations cover the T08 timeline
operations; media imports/removals remain individual commands.

All mutations above accept `--expected-revision N` and `--dry-run`. The revision
must be a nonnegative safe integer. A stale revision fails with exit 1 before any
commit. For apply, a supplied CLI revision must match the required batch revision
(otherwise exit 2). Without the flag, individual commands and undo/redo operate on
the current revision under the writer lock. Use the flag when acting on a prior
read. A failed or stale edit retains the redo branch.

Dry-run executes the same validation, operations and history planning, returning a
preview without saving content or history. It preserves project bytes and mtime,
and cleans its temporary writer lock. Media import dry-run still requires ffprobe.
Generated preview IDs and timestamps are provisional and can differ on real apply.
Existing individual command JSON shapes remain unchanged during dry-run; their
fields describe the proposed result rather than a committed edit.

`edit history` returns `{ path, revision, undo, redo }` without writing.
Each entry is `{ id, label, committedAt }`; both arrays are stacks, with the next
undo/redo at the **last** position. Undo is oldest first; redo is reverse execution
order. Snapshot contents remain in the project file rather than history stdout.
Apply/undo/redo JSON returns `{ path, dryRun, baseRevision, changed, revision,
undo, redo }`, plus `results` for apply. Each result contains its operation `type`
and the existing T08 result fields without `path`. With dry-run, `revision` and
history describe the **projected** state and `baseRevision` is the saved revision.
`changed` is false for an equivalent transaction; it adds no history. Adding then
removing a temporary track, or moving/trimming a clip back to its original values,
is a no-op when all other stored content matches. The batch still validates every
operation and the expected revision, and returns the intermediate operation
`results`. Those results do not imply a saved change; check `changed` and read back
the final timeline/history. This also applies to dry-run output.

Snapshots and current content share one atomic JSON replacement: no sidecar
history can commit independently. History survives reopening and moving the
project bundle. It is retained without automatic pruning and increases file size
by two project-content snapshots per changed transaction. Do not hand-edit content
behind existing history: snapshot mismatch or a broken chain fails with a history
conflict instead of overwriting newer content on undo. Restore a valid backup.

The existing lock, symlink/hard-link refusal, outside-change detection and atomic
save guarantees apply. Cooperating writers serialize by rejection while busy;
retry after reloading. Detected outside replacements during an operation fail.
Arbitrary noncooperating writes in the final check/rename window and power-loss
durability remain outside the filesystem guarantee. Errors are structured on stderr
with `--json`; exit 0 means success, 1 means data/runtime/file/conflict
failure, and 2 means invalid CLI arguments. Failed commands emit no success JSON.

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
per-project OS-backed `.opencut-lock` serializes cooperating writers; competing updates
fail with a retry message. Updates refuse project symlinks and hard-linked project
files and check for outside changes before publication. Handled failures preserve
the previous project and clean owned temporary files. Forced termination
can leave unused `.opencut-update-*` directories; OS ownership is released
automatically. Keep the permanent `.opencut-lock` sidecar. The rename prevents partial JSON visibility;
power-loss durability and coordination with arbitrary external writers are not
guaranteed. The containing directory must be writable.

Only import requires ffprobe; list/info/remove require no media tools or Electron.
All four commands support human-readable output and scoped `--help`. No other
options apply. They follow existing CLI errors: exit 2 for invalid arguments,
exit 1 for project/media/filesystem/prerequisite failures, diagnostics on stderr
and no JSON success result on failure, including with `--json`.

## Project rendering

`project render <project-file> --output <file.mp4> [--quality <draft|balanced|high>] [--resolution <project|720p|1080p>] [--overwrite] [--json]` reads a saved project
snapshot and composites video/image tracks with mixed audio to H.264/yuv420p and AAC MP4. It requires FFmpeg 8+
with libx264 and standard filters, plus ffprobe on PATH. The project's resolution
and exact rational frame rate determine the default output. Original video audio is preserved
by default. Independent audio clips on any number of audio tracks can overlap
original audio and each other across tracks. No transitions, audio effects,
keyframes, fades or GUI project integration are implemented.

T12 accepts multiple video tracks, still images and any audio tracks. At least one
video/image clip is required; empty tracks are allowed. Same-track overlaps remain
forbidden: use separate tracks for simultaneous layers or audio. Only referenced
assets are probed; unused offline assets do not block a render. Relative sources
resolve from the physical project directory, including directory aliases.
Projects and original media are read only; history and revisions are unchanged.

Video tracks draw bottom to top in `project.tracks` array order, ignoring audio
tracks. New tracks append above existing layers; reorder the array in a project
without conflicting history to change stacking. Clips within each track are sorted
by timeline start. Every visible layer is composited at each frame, including when
lower tracks have gaps. Gaps reveal lower layers or the canvas background.
Duration ends at the last clip's exclusive end across all tracks. Audio tails show
the background. Muted, zero-volume and zero-opacity clips still contribute to duration.
There is no separately stored trailing duration. Every timeline start and source
in/out must align exactly with a project-frame boundary; subframe times are
rejected with an alignment error. The CLI's existing frame-based edits satisfy
this rule. Missing/unreadable media, invalid references/overlaps, unknown video
duration and source ranges exceeding freshly probed video bounds fail with
clip/path diagnostics. Stored import metadata is not treated as proof that the
current file still matches it.

Configure the canvas with:

```sh
node apps/cli/dist/index.js canvas set PROJECT --width 1080 --height 1920 --background-color '#183048' --json
node apps/cli/dist/index.js clip visual PROJECT CLIP_ID --fit contain --scale 0.5 --x=-120 --y 200 --opacity 0.75 --json
```

`canvas set` accepts any nonempty subset of width, height and `--background-color`.
Use 1080×1920 (9:16), 1920×1080 (16:9) or 1080×1080 (1:1), or other supported
even dimensions. `backgroundColor` is optional `#RRGGBB`, default `#000000`.
The background is opaque. H.264 output flattens all source transparency onto it.
`clip visual` accepts any nonempty subset of `--x`, `--y`, `--scale`, `--opacity`
and `--fit`; `clip add` accepts the same flags. These mutations support dry-run,
revision guards, atomic save and undo/redo. Omitted properties retain stored values.

Visual defaults are x/y 0, scale 1, opacity 1, fit `contain`. Coordinates are pixel
offsets from the centered fitted layer: positive x moves right, positive y down.
Negative offsets use `--x=-120` / `--y=-80`. The fitted layer top left is `(canvas.width - layer.width)/2 + x`,
`(canvas.height - layer.height)/2 + y`.
Offsets are finite decimals in [-32768, 32768]. Scale is uniform in [0.01, 4] and
multiplies the canvas fitting rectangle before centering/translation. Each rectangle
side rounds to the nearest even pixel (minimum 2, ties upward), with a render limit
of 8192 per side. `contain` preserves display aspect ratio inside that rectangle;
its unused margins are transparent. `cover` preserves display aspect ratio, fills
the rectangle and crops centrally. `stretch` fills the rectangle independently in
x/y. All modes normalize sample aspect ratio to square pixels. Positioning is
quantized to the 2-pixel output chroma grid by FFmpeg. Content outside the canvas
is clipped. Opacity [0, 1] multiplies source alpha; 0 hides visuals while retaining
audio. Opaque and alpha-bearing videos/images share these rules.

Import PNG/JPEG and other FFmpeg-supported still images as usual and place them
on video tracks. Their positive `out - in` range specifies a static display duration,
with no inferred source duration; a nonzero in point still selects the same image.
Splits retain the image and transforms. Animated GIF/APNG files with a known
duration are treated as timed video. Attached cover artwork on audio files is
not a visual source. No keyframes, transitions or GUI canvas controls are included.

JSON clips accept an optional `visual` object containing x/y/scale/opacity/fit.
`clip.add` batches accept that object; `clip.visual` batches take its properties
alongside `id`, for example `{ "type": "clip.visual", "id": "c1", "x": 20 }`.
`canvas.set` batches accept width/height/backgroundColor. Empty visual/canvas
operations fail. Visual properties require video tracks. New fields remain optional
in schema version 1 and omission round-trips without defaults, including history.

Audio uses the selected default stream (falling back to the first), resampled and
downmixed to 48 kHz stereo. Video source time zero is its first video frame;
audio-only source time zero is its first audio sample. Audio clips referencing video
assets use that video's time origin too. Relative stream delays, early audio and
timestamp gaps are normalized before source trimming. Short/missing video audio
and timeline gaps supply silence. An audio-track source missing its audio stream,
with unknown duration, or with source out beyond its current audio end fails with
clip diagnostics, even when muted. Music does not loop; add explicit clips/ranges.

An independent audio clip referencing a video asset plays alongside that video's
original audio; it does not detach, link or mute the video clip. To use only the
independent audio clip, mute the corresponding video clip with
`clip audio PROJECT VIDEO_CLIP_ID --muted true --json`. Audio settings and edits
apply to each clip independently, even when clips reference the same asset.

Per-clip `volume` is linear amplitude gain in [0, 1], default 1; `muted` is boolean,
default false. Configure either on `clip add` or later with
`clip audio PROJECT CLIP_ID --volume 0.25 --muted false --json`. Use
`--muted true` to silence original video audio or independent audio clips. JSON
batch `clip.add` and `clip.audio` use numeric `volume` and boolean `muted`.
Mixing sums gains without automatic normalization as tracks enter/leave. The
existing T03 safety limiter caps peaks at 0.95 with latency compensation; dense
mixes can therefore reduce loud peaks. A silent 48 kHz stereo AAC stream is
exported even when no source has audio, preserving video-only T10 projects.
Audio boundaries round absolute project-frame times to nearest 48 kHz samples
(half up), avoiding cumulative duration drift. Fractional frame/sample boundaries
can differ by at most one sample at a split; AAC may add one decoded padding
packet at EOF. MP4 timing excludes encoder delay and reports the planned duration
within 1.1 ms. No sample-exact lossless audio guarantee is made for AAC.

Source time zero is the selected video's first frame, as in T03 composition;
container/stream start offsets are normalized. Source in/out are positions on the
project-rate sampling grid, with an exclusive out point. Each source is converted
to that grid with FFmpeg's `fps` filter (nearest timestamp rounding) before integer
frame trimming. A split therefore selects exactly the same sampled frames as the
unsplit clip, even when source and project rates differ. The configured fit/scale/position is applied after sampling, preserving source alpha. At fractional EOF rounding, at most
one cloned frame completes the last frame interval. Global output timestamps are
regenerated from integer frame indices using the project's rational time base,
so composition cannot accumulate floating-point timing drift. This is CFR
resampling, not a promise to retain every frame of a VFR or differently rated source.

Supported limits: even sides 2–3840 with at most 3840×2160 total pixels (including 2160×3840 portrait), 1–120 fps, at most 64 clips across all tracks
and 600 seconds including gaps. Reduced frame-rate numerator/denominator must fit
positive signed 32-bit FFmpeg rational components. Unsupported settings fail;
rendering never substitutes defaults. Encoding and output decode/count verification
each have a 10-minute wall-clock limit and 4 MiB stdout/stderr limits. Each input
decoder uses one thread; encoding uses two. Whole-source sampling before trim
can be slow for late in-points. HDR/color management and cross-platform validation
remain outside this milestone.

### Render presets and progress

`--quality draft|balanced|high` selects H.264 encoding: `draft` uses
ultrafast/CRF 28, `balanced` uses veryfast/CRF 20 (the unchanged default), and
`high` uses medium/CRF 16. Audio remains 192 kb/s, 48 kHz stereo AAC.
`--resolution project|720p|1080p` defaults to the project dimensions. `720p`
fits the finished canvas inside 1280×720 (720×1280 for portrait); `1080p`
uses 1920×1080 (1080×1920 for portrait). Orientation is retained; aspect ratio
is preserved up to rounding each side down to an even pixel, minimum 2. Fitting
uses an integer scale ratio until the final division, so exact even dimensions
stay exact: 704×396 with `1080p` becomes 1920×1080, and 1248×702 with `720p`
becomes 1280×720. Portrait equivalents swap the output dimensions. Square output
is 720×720 or 1080×1080. Presets may upscale smaller projects. Compositing still uses
project coordinates, then scales the finished canvas; transforms, timing and the
saved project are unchanged. Project render limits still apply before scaling.

Human progress is written to stderr; stdout contains the final saved-file message.
With `--json`, **project render streams JSON Lines**, one compact object per line.
Other commands retain their existing single JSON result. Use the direct Node
executable to avoid pnpm wrapper output. Parse each line separately and check the
exit status and terminal event; do not parse the entire stream as one JSON value.
FFmpeg's structured `-progress` output is sampled every 0.25 seconds when available:

```jsonl
{"event":"progress","phase":"rendering","percent":25,"processedFrames":30,"totalFrames":120,"elapsedSeconds":2,"remainingSeconds":6}
{"event":"progress","phase":"verifying","percent":100,"processedFrames":120,"totalFrames":120,"elapsedSeconds":8,"remainingSeconds":null}
```

Progress begins at zero before encoding. `processedFrames` is a monotonic, bounded
count of encoded frames; `percent` is that count divided by `totalFrames` × 100.
`elapsedSeconds` measures wall time since encoding began, including later
verification. `remainingSeconds` estimates encoding time from average throughput;
it is `null` before measurable progress, at encoder completion and during
verification. Startup/input probing has no percentage or ETA. A 100% encoding
event does not mean the file is ready: verification and atomic publication must
succeed first. Slow/stalled FFmpeg operations can delay progress records.

The terminal `completed` event contains `projectPath`, `path` (absolute), output
`width`/`height`, reduced rational `frameRate`, integer `frameCount`, planned
`durationSeconds`, selected `quality`/`resolution`, and measured `metadata` in the
probe schema. Runtime/preflight failures emit `{"event":"failed","message":"..."}`;
cancellation emits `{"event":"cancelled","message":"Render cancelled."}`.
Invalid arguments emit no events. With `--json`, stderr errors contain a structured
code/message, including useful FFmpeg diagnostics. No `completed` event is emitted for failed/cancelled jobs.

Choose a `.mp4` in an existing writable directory. Existing outputs (including
publication races) are refused by default. `--overwrite` explicitly permits
atomic replacement of a regular file after verification; source media and the
project file are protected, including filesystem aliases. Output symlinks and
directories are refused. New-file publication requires hard-link support;
replacement uses same-filesystem rename. FFmpeg only writes inside an owned
`.opencut-render-*` sibling directory on the destination filesystem.
Before publication, ffprobe verifies H.264/AAC codecs, 48 kHz stereo audio, zero
start, dimensions, exact frame rate, measured A/V duration and decoded frame count.
Failures/cancellation remove temporary output and preserve any previous export.

Send SIGINT (Ctrl-C) or SIGTERM to cancel input probes, encoding or verification.
The CLI forwards cancellation as SIGTERM to the active tool, escalates to SIGKILL
after two seconds if needed, waits for child closure, cleans up, and exits 130 for
SIGINT or 143 for SIGTERM. Publication is the commit point: a signal after atomic
publication cannot retract a successful export. SIGKILL of the CLI, power loss or
OS termination cannot run cleanup and may leave an owned temporary directory;
remove it only after confirming the associated render has stopped. No persistent
job queue or background service is involved. Exit 2 means invalid arguments;
exit 1 means invalid/unsupported projects, media, tools or I/O. Inspect/decode the
completed output before claiming delivery.

```sh
node apps/cli/dist/index.js project render PROJECT --output export.mp4 --quality high --resolution 1080p --json
# Explicitly replace an existing regular export only after a successful render:
node apps/cli/dist/index.js project render PROJECT --output export.mp4 --overwrite --json
```

Headless APIs: `planProjectRender(project)` from `@opencut/core` returns width,
height, backgroundColor, reduced frameRate, total frameCount, and ordered
`visualClips` / `audioClips`. Visual entries contain clipId, assetId,
timelineStartFrame, sourceStartFrame, frameCount, x/y, scale, opacity and fit;
array order is bottom to top. Audio entries contain the same identity/time fields,
plus volume, muted and required (true for audio-track clips).
`renderProjectFile(absoluteProjectPath, output, controls?)` from `@opencut/core/node` resolves
asset references and executes the plan without saving the project.
`renderVideoTimeline(options)` from `@opencut/media` takes resolved paths in place
of asset references, plus output. Both executors accept optional `quality`,
`resolution`, `overwrite`, an `AbortSignal` as `signal`, and a synchronous
`onProgress(event)` callback. Cancellation rejects with `RenderCancelledError`
from `@opencut/media` after child closure and cleanup. Callback errors also stop
encoding and clean up. Direct media callers supply `audioClips`
explicitly; omission produces silence. Legacy sequential `segments` are accepted
instead of `visualClips`, using default transforms; supplying both fails. The pure
planner now emits `visualClips` rather than its former sequential `segments` shape.
This API change is separate from saved-project compatibility: existing version 1
projects still load and render with their original defaults.

To add background music after importing it, use the returned asset and track IDs:

```sh
node apps/cli/dist/index.js media import /path/demo.opencut.json /path/music.wav --json
node apps/cli/dist/index.js track add /path/demo.opencut.json --type audio --name "Music" --json
node apps/cli/dist/index.js clip add /path/demo.opencut.json MUSIC_ASSET_ID --track AUDIO_TRACK_ID --at 30 --in 0 --out 60 --volume 0.25 --json
node apps/cli/dist/index.js clip audio /path/demo.opencut.json VIDEO_CLIP_ID --muted false --volume 1 --json
```

At 30 fps this places two seconds of music at timeline second 1. Read back
`timeline list`, render to a new path, and probe/decode the result to verify the mix.

### Worked render example

From a built checkout, create a 320×180 project at 30 fps. Choose a timed video
with at least two seconds of video and a new project/output in an existing directory.
Replace `ASSET_ID`, `TRACK_ID` and `CLIP_ID` with the corresponding `asset.id`,
`track.id` and `clip.id` from the preceding JSON results. Both clip additions use
the same asset and track.

```sh
node apps/cli/dist/index.js project create /path/demo.opencut.json --name "Timeline render" --width 320 --height 180 --fps 30 --json
node apps/cli/dist/index.js media import /path/demo.opencut.json /path/source.mp4 --json
node apps/cli/dist/index.js track add /path/demo.opencut.json --type video --name Video --json
node apps/cli/dist/index.js clip add /path/demo.opencut.json ASSET_ID --track TRACK_ID --at 0 --in 15 --out 45 --json
node apps/cli/dist/index.js clip split /path/demo.opencut.json CLIP_ID --at 15 --json
node apps/cli/dist/index.js clip add /path/demo.opencut.json ASSET_ID --track TRACK_ID --at 45 --in 45 --out 60 --json
node apps/cli/dist/index.js timeline list /path/demo.opencut.json --json
node apps/cli/dist/index.js project render /path/demo.opencut.json --output /path/demo-render.mp4 --json
node apps/cli/dist/index.js probe /path/demo-render.mp4 --json
```

The expected output is 60 frames (2 seconds): the first trimmed clip occupies
frames 0–29, split at frame 15; frames 30–44 are black; the second source range
occupies frames 45–59. All in/out values are project-frame indices; the source
ranges are 0.5–1.5 seconds and 1.5–2 seconds, with exclusive ends. Check the render
result's `frameCount`, dimensions, rate and measured metadata, then inspect/decode
the MP4. Validation success alone does not execute a render.

### Layered portrait render example

Start with a new project, a video containing at least three seconds of video,
and a still image. Run the following commands from a built checkout. Replace
`VIDEO_ASSET_ID` and `IMAGE_ASSET_ID` in the batch below with the imported
`asset.id` values. Read `edit history` and use its current revision; the shown 2
assumes a fresh project followed by these two distinct imports.

```sh
node apps/cli/dist/index.js project create /path/portrait.opencut.json --name "Layered portrait" --width 1080 --height 1920 --fps 30 --json
node apps/cli/dist/index.js media import /path/portrait.opencut.json /path/video.mp4 --json
node apps/cli/dist/index.js media import /path/portrait.opencut.json /path/overlay.png --json
node apps/cli/dist/index.js edit history /path/portrait.opencut.json --json
```

Save this batch to `/path/layers.json` after substituting the asset IDs and revision:

```json
{
  "expectedRevision": 2,
  "label": "Compose portrait layers",
  "operations": [
    { "type": "canvas.set", "backgroundColor": "#183048" },
    {
      "type": "track.add",
      "id": "main-video",
      "name": "Video",
      "mediaType": "video"
    },
    {
      "type": "track.add",
      "id": "image-layer",
      "name": "Overlay",
      "mediaType": "video"
    },
    {
      "type": "clip.add",
      "id": "main-clip",
      "assetId": "VIDEO_ASSET_ID",
      "trackId": "main-video",
      "at": 0,
      "in": 0,
      "out": 90
    },
    {
      "type": "clip.add",
      "id": "image-clip",
      "assetId": "IMAGE_ASSET_ID",
      "trackId": "image-layer",
      "at": 30,
      "in": 0,
      "out": 30,
      "visual": {
        "x": 300,
        "y": -150,
        "scale": 0.3,
        "opacity": 0.75,
        "fit": "contain"
      }
    }
  ]
}
```

```sh
node apps/cli/dist/index.js edit apply /path/portrait.opencut.json /path/layers.json --dry-run --json
node apps/cli/dist/index.js edit apply /path/portrait.opencut.json /path/layers.json --json
node apps/cli/dist/index.js timeline list /path/portrait.opencut.json --json
node apps/cli/dist/index.js project render /path/portrait.opencut.json --output /path/portrait.mp4 --json
node apps/cli/dist/index.js probe /path/portrait.mp4 --json
```

The result is 90 frames at 30 fps: a three-second 1080×1920 video. The image is
above the video only during [1, 2) seconds; its source alpha is multiplied by 0.75.
The main video retains its original audio. Contain fitting leaves the background
visible around landscape footage. Inspect frames before, during and after the
image interval (for example at 0.5, 1.5 and 2.5 seconds) and check the output's
dimensions, frame rate and measured duration.

## Headless media API

Workspace consumers declare `"@opencut/media": "workspace:*"` as a dependency
and build the headless packages before importing it. The package exports
`probeMedia(file)`,
`extractFrame(file, timestampSeconds, output)`, `composeMedia(options)`,
`renderVideoTimeline(options)`,
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
install, download or bundle media executables. Project create/info/validate, help/version, ordinary unit tests,
and basic desktop playback do not need them. Independent desktop frame stepping
needs ffprobe for average source FPS; with a project open the player steps at the
project rate and reuses stored import metadata.

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

T09 unit/CLI tests cover multi-operation commits, intermediate validation and rollback,
exact undo/redo across reloads, branch invalidation, individual-command history,
dry-run bytes/mtime preservation, stale revisions, simultaneous writers, outside
replacement and failed atomic publication. Sources remain unchanged.

T10 unit/CLI tests cover exact planning, unsupported projects/settings, output protection,
publication races, failed encoding/verification cleanup and missing tools. Native
integration tests render saved fixture projects through the built CLI and independently
probe/decode output. They check order, trim endpoints, split equivalence, leading/interior
black boundaries, mixed source rates, fractional-rate PTS spacing, nonzero source starts,
directory aliases, stale bounds and source/project preservation. Owned `t10-*` native
test directories are cleaned on success or failure. Desktop project integration remains
deferred; the existing T03 path-based composition command remains available.

T11 native integration checks independently decode AAC samples, measure tone
frequencies and amplitude ratios for overlapping sources, gains, muting, silence,
audio tails and gaps. Visual flashes and audio pulses verify trimmed/split sync;
60 one-frame fractional-rate splits, delayed audio and nonzero container starts
cover timing. Fresh audio bounds/missing-stream failures and fixture/project hashes
are checked. Owned `t11-*` directories are cleaned on success or failure.

T12 native integration tests check overlapping videos, track ordering, transforms,
opacity, PNG and video alpha, image duration/splits, background gaps/audio tails,
9:16/16:9/1:1 fitting and non-square source pixels. Independent pixel samples,
frame counts/PTS, codecs, dimensions, SAR and audio amplitude measurements verify
outputs and guard against duplicated audio. CLI/history and invalid settings are
also tested offline. Owned `t12-*` directories are cleaned after each run.

T13 tests cover structured progress chunk boundaries, monotonic percentages/frame
counts, shutdown escalation/timeouts, cancellation before work and during
encoding/verification, output conflicts and verified atomic replacement. Native
fixture checks stream JSONL from actual FFmpeg renders, independently probe/decode
quality/resolution presets, send SIGINT/SIGTERM during live encoding, check child
termination and temporary cleanup, and preserve previous exports after encoding
failure/cancellation. Source/project hashes remain unchanged. Owned `t13-*`
directories are cleaned after each run.

## Complete end-to-end workflow

Run `pnpm e2e --keep` to build and execute the T14 CLI-only 18-second workflow,
retaining a verified MP4, project, representative frames, ffprobe/frame/audio
measurements and CLI process transcript in a unique generated directory. Run
`pnpm test:e2e` for two independent runs with automatic cleanup. Missing fixtures
are generated only when their directory is absent; existing fixtures are validated
and never overwritten. The [official Agent Skill workflow](../skills/video-editor/references/workflow.md)
contains the complete public command recipe, timing and verification contract.
It also covers [20-second portrait photo stories and collages](../skills/video-editor/references/workflow.md#photo-slideshows-and-vertical-edits),
including static transforms, imported caption/music assets and cleanup boundaries.

## Preview proxies and cache management (T25)

```sh
node apps/cli/dist/index.js cache status --json
node apps/cli/dist/index.js cache proxy /path/source.mp4 --json
node apps/cli/dist/index.js cache proxy /path/source.mp4 --regenerate --json
node apps/cli/dist/index.js cache frame /path/source.mp4 --timestamp 1.5 --json
node apps/cli/dist/index.js cache configure --disk-mib 2048 --memory-mib 64 --json
node apps/cli/dist/index.js cache cleanup --json
node apps/cli/dist/index.js cache clear --json
```

Every cache command accepts `--directory <dedicated-cache-directory>`;
`OPENCUT_MEDIA_CACHE` overrides the shared default `~/.cache/opencut/media-v1`.
Use `cache --help` for arguments. Status lists derivative identity, source hashes,
limits, encoded PNG memory and actual derivative/staging disk bytes. `frame` returns
a PNG data URL for the frame covering the requested source instant, without writing
a user-selected output. It uses presentation timestamps for CFR/VFR media, rather
than rounding to average FPS or choosing the next frame. Unresolvable timing or
extraction failure exits 1. `proxy` streams existing render-progress events then
`{event:"result",result:{path,proxy,key,reason?}}`.
Unsupported timing returns `proxy:false` and the original path with a reason;
encode/validation failures exit 1. SIGINT/SIGTERM cancel proxy/frame generation
with exit 130/143 after child cleanup. Configure persists limits and evicts old
entries; cleanup removes stale/corrupt/orphaned entries, and clear removes all owned
derivatives. These commands never change project JSON or source media. A missing
source cannot be made available by a proxy. See [the cache contract](MEDIA_CACHE.md).
