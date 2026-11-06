# OpenCut CLI through T29

For a complete CLI-only edit with tested timing, layers, audio and persistent history,
see the [T14 workflow](workflow.md).

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
node apps/cli/dist/index.js media import /path/to/new.opencut.json /path/to/video.mp4 --json
node apps/cli/dist/index.js media list /path/to/new.opencut.json --json
node apps/cli/dist/index.js media info /path/to/new.opencut.json ASSET_ID --json
node apps/cli/dist/index.js media remove /path/to/new.opencut.json ASSET_ID --json
```

`opencut` is the workspace-local executable, not a globally installed command.
No arguments and `--help`/`-h` show usage; `--version`/`-v` print the application
version. Help takes precedence when both options are present.

Direct invocation writes results to stdout and errors to stderr. pnpm scripts
may add their own lifecycle logs, so use the Node/bin form for exact output.
`project render --json` streams JSONL progress and terminal events; other commands
retain single JSON results.
Exit codes: 0 success, 2 invalid arguments, 1 project validation/data,
media/filesystem/prerequisite or execution failure. Render cancellation exits 130
for SIGINT or 143 for SIGTERM. Unknown options/commands,
extra arguments and inapplicable options fail. Repeated options use the last value.
Errors are structured on stderr with `--json`:
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Help and version also accept `--json`, returning
`{ "discoveryVersion": 1, "help": "...", "commands": [...], ... }` and
`{ "name": "OpenCut", "version": "0.1.0" }` respectively.
The application version and project `schemaVersion` identify different contracts;
use `schemaVersion` when checking project-format compatibility.

## Agent discovery and timeline previews (T29)

Start with `node apps/cli/dist/index.js help --json`. It describes every command,
arguments, required options, defaults, units, constraints, prerequisites,
capability availability and exit codes. `help preview --json` scopes the list.
`schemas` contains versioned JSON Schema definitions for T29 results/errors;
`resultSchema` links each new command to its schema. Existing JSONL commands are
marked explicitly. SDK, scripting runtime and MCP are unavailable.

```sh
node apps/cli/dist/index.js project inspect /path/to/project.opencut.json --json
node apps/cli/dist/index.js timeline inspect /path/to/project.opencut.json --frame 20 --json
node apps/cli/dist/index.js preview frame /path/to/project.opencut.json --frame 20 --output /path/to/new-frame.png --json
node apps/cli/dist/index.js preview contact-sheet /path/to/project.opencut.json --from 0 --to 66 --count 4 --columns 2 --size 160 --output /path/to/new-sheet.png --json
node apps/cli/dist/index.js preview clip /path/to/project.opencut.json --from 12 --to 42 --size 160 --quality high --output /path/to/new-preview.mp4 --json
```

Inspection/preview `--json` and `--help`/`-h` also work before the group or
between group and action. These regression-tested forms are equivalent to the
usual option placement:

```sh
node apps/cli/dist/index.js project --json inspect /path/to/project.opencut.json
node apps/cli/dist/index.js timeline --json inspect /path/to/project.opencut.json --frame 20
node apps/cli/dist/index.js preview --json -h frame
```

Inspection-only options remain restricted to their supported commands.
`--version` is used alone, optionally with `--json`.

These forms are native-tested on a 66-frame, 30 fps layered project. Use your
inspected duration/rate to choose valid ranges. Project inspection returns full
content and revision without undo snapshots; media can be offline. Timeline
inspection uses the shared evaluator for bottom-to-top layers, gain/mute, gaps
and exact source-time mappings. Unknown audio metadata describes candidates,
not confirmed decoded streams. Inspection at end/after is supported.

All new time flags use safe integer project-frame indices; `--to` is exclusive.
Previews require an inside frame or `0 <= from < to <= timeline frame count`.
Frames default to project size; `--size 64..1920` caps the finished canvas side
without upscaling. Sheets default to the full timeline, min(8, range frames)
samples, min(4, count) columns and size 320. They support at most 16 samples and
size 640; count cannot exceed range length. Labels show exact frame/approximate
seconds; JSON lists exact times and tile coordinates. Clips require from/to,
allow at most 30 seconds, and default to size 640 and quality draft; quality also
accepts balanced/high. They retain project FPS, composition and mixed audio.

All five results carry `inspectionVersion: 1` and revision information; previews
also identify project, output path, frame rate and dimensions. Use discovery's
schemas for exact fields. Each success is one JSON document on stdout;
`preview clip --json` sends progress JSONL to stderr, followed by a structured
error there on failure. Check exit status before consuming output: 0 success,
2 invalid arguments/range, 1 project/media/file/runtime/prerequisite failure.
Cancellation uses 130/143 and cleans temporary files. SIGKILL cannot clean up.

Visual previews use the original-media export compositor headlessly, without
Electron. PNGs preserve RGB composition without H.264 compression, flattening
canvas alpha over black. Sharp only assembles sheet tiles and font labels.
All referenced visual sources must be available, even outside the range; clip
previews validate audio too. Existing export limits apply to the whole project
(64 clips, 600 seconds, aligned frames, even dimensions, 1–120 fps, video/image
required). Empty/audio-only projects can be inspected but cannot render previews.
Late-frame extraction may decode preceding frames. Previews never alter project,
history or source media, and never overwrite outputs. Use new files in an existing
writable directory. Read back/inspect generated media before reporting success.
See the [complete contract and test command](../../../docs/CLI.md#agent-discovery-and-visual-inspection-t29).

## Projects

Project create/info/validate run without Electron, FFmpeg or ffprobe. Project render requires FFmpeg and ffprobe. Each takes an explicit
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
`createdAt`, `updatedAt`), `settings` (`width`, `height`, rational `frameRate`, optional `backgroundColor`) and
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

## Project media assets

`media import <project-file> <file> [--json]` imports one video, audio or image by
reference and probes it with external ffprobe. No copying or source mutation
occurs. Both CLI paths resolve from cwd. Source symlinks resolve to their real
targets; stored forward-slash references prefer project-relative paths (including
`..`). Project directory symlinks resolve to their physical parent consistently
for import, list/info and project media validation. References
fall back to absolute paths for different roots or unrepresentable
relative paths. Invalid formats, missing/unreadable files and unsupported streams
fail without changing project data.

For `/links/project -> /work/project`, a stored `../media/video.mp4` resolves
to `/work/media/video.mp4` through either directory path. Import/remove report
the canonical project `path`; list/info/validate retain the requested absolute
project `path`. Resolved media paths are reported separately. Use `asset.id` as
the asset identity across these results. A directory symlink is allowed; mutation
guards still reject a symlink at the project filename.

Import JSON: `{ path, imported, asset, source, referencedBy }`. `path` is the
absolute project path. Asset fields are `id`, `name`, `file`, `mediaTypes`, optional
rational `duration`, and optional `metadata`. Metadata is persisted with `kind`
(`video`, `audio`, `image`), `formatName`, `durationSeconds`, `width`, `height`,
`videoCodec`, `audioCodec`, average `frameRate`, `frameRateRatio` and `hasAudio`.
Unknown/inapplicable values are null; still images have null duration and FPS
and use visual (`video`) media types. Known positive duration is also stored as
rational seconds rounded to microseconds. Old assets may lack metadata entirely.
Metadata is a snapshot; availability checks do not refresh it.

Reimporting a normalized path, symlink or hard link to the same file returns its
existing stable ID and `imported: false`; it does not probe or rewrite the project.
Distinct copies with equal contents are separate assets. No hash deduplication,
metadata refresh, copy-import or relink option exists.

`media list <project-file> [--json]` returns `{ path, assets }`, with each entry
containing `{ asset, source, referencedBy }`.
`media info <project-file> <asset-id> [--json]` returns
`{ path, asset, source, referencedBy }`.
`source` has `assetId`, resolved `path`, `status`, `message`; statuses match project
validation (`available`, `missing`, `unreadable`, `not_file`, `unsupported_path`).
`referencedBy` lists clip IDs. Both commands are read only and use stored metadata
without ffprobe. Offline sources do not prevent inspection (exit 0); run project
validate when unavailable media must fail the workflow. Unknown IDs fail with exit 1.

`media remove <project-file> <asset-id> [--json]` removes only an unreferenced
project entry and returns `{ path, removedAssetId }`. Offline assets can be removed.
Any referencing clip blocks removal and is named in the diagnostic. Original
files are never deleted; there is no force flag.

Imports/removals validate data, update `updatedAt`, sync temporary JSON and replace
the existing project atomically by same-directory rename. Updates require a
writable directory and a regular project file with one hard link; project
symlinks/hard links are refused. A permanent `.opencut-lock` sidecar provides OS-backed ownership; competing writers are rejected;
detected outside changes also fail. Handled failures preserve the prior JSON
and clean owned temporary files. Forced termination may leave unused
`.opencut-update-*` directories, but releases OS ownership automatically.
Never delete the permanent `.opencut-lock` sidecar. Power-loss durability and arbitrary outside writers are
not covered by the atomicity guarantee.

Only import needs ffprobe; list/info/remove need no media tools. All support
scoped `--help`, readable output and `--json`. Import/remove also accept
`--dry-run` and `--expected-revision N`. Errors use
the existing text stderr contract even with JSON: exit 2 for invalid arguments,
exit 1 for runtime/data failures, and no JSON success result on failed commands.
Check the exit status, then read back list/info after a successful update.

## Timeline editing

Read [the full timeline editing contract](../../../docs/CLI.md#timeline-editing) before
editing: it specifies every command, exact time semantics, JSON fields and errors.
Use `timeline list PROJECT --json` to discover track and clip IDs. Add tracks with
`track add PROJECT --type video|audio --name NAME --json`; remove empty ones with
`track remove PROJECT TRACK_ID --json`.

Place an imported asset with
`clip add PROJECT ASSET_ID --track TRACK_ID --at FRAME --in FRAME --out FRAME --json`.
All three times are required and use nonnegative safe integer **project-rate frame
indices**, including source points. They are not source-file frame indices or
seconds. Stored and returned times are exact rational seconds. Out is exclusive.
Use the stored rational asset duration to choose an in-bounds source out point:
frame 60 at 30000/1001 fps is 2.002 seconds and exceeds a two-second asset. See the
[exact source-bound example](../../../docs/CLI.md#timeline-editing).

`clip move PROJECT CLIP_ID [--track TRACK_ID] [--at FRAME] --json` preserves source
mapping. `clip trim PROJECT CLIP_ID [--in FRAME] [--out FRAME] --json` fixes timeline
start and changes duration at 1x. Each requires at least one change option.
`clip split PROJECT CLIP_ID --at FRAME --json` uses an absolute timeline position
strictly inside the clip, returns `{ path, left, right }`, preserves source mapping
and total duration, keeps the left ID and creates a right UUID.
`clip remove PROJECT CLIP_ID --json` leaves a gap.

`clip add` also accepts `--volume <0..1>` and `--muted <true|false>`.
`clip audio PROJECT CLIP_ID [--volume <0..1>] [--muted <true|false>] --json`
updates either property (at least one required). Volume is linear amplitude gain:
0 is silence, 0.5 halves amplitude, 1 is unchanged; omitted volume defaults to 1.
Muted defaults to false and overrides gain without changing it. Split copies both
properties; move/trim retain them. Both flags work on video and audio clips and
share dry-run, revision and undo/redo behavior. Batch `clip.add` and `clip.audio`
use numeric `volume` and boolean `muted` with the same bounds/defaults.

Same-track video/audio overlaps fail; touching boundaries and cross-track overlaps
are allowed. Known asset durations are enforced; unknown-duration/image ranges
must be explicit and have no inferred finite source bound. No ripple edits,
source refresh/decoding occurs. T09 transactions and undo/redo are described below.
Populated track removal fails until all its clips are moved or removed.
Offline edits require no media tools. Mutations use the existing guarded atomic
save path, while no-op moves/trims and inspection preserve bytes/timestamps.
Check exit status before parsing stdout; failed commands keep text stderr and no
JSON success result. Read back `timeline list` after mutations. Pre-T08 documents
with same-track overlaps fail validation and need explicit JSON correction.

List JSON is `{ path, frameRate, duration, tracks }`; each track has model fields
and time-ordered `clips` with derived rational `duration` and `timelineEnd`.
Other mutation JSON is `{ path, track }`, `{ path, clip }`,
`{ path, removedTrackId }`, or `{ path, removedClipId }`, as appropriate.

## Transactions, undo and redo

Read [the complete transaction contract](../../../docs/CLI.md#transactions-undo-and-redo)
for the strict batch fields, operation table, result fields and filesystem limits.

- `edit history PROJECT --json` returns `{ path, revision, undo, redo }`.
  Legacy projects start at revision 0. Each summary entry is
  `{ id, label, committedAt }`; the next undo/redo is the last stack entry.
- `edit apply PROJECT BATCH.json [--dry-run] [--expected-revision N] --json`
  applies one transaction. Both paths are explicit and cwd-relative or absolute.
- `edit undo PROJECT [--dry-run] [--expected-revision N] --json` and
  `edit redo PROJECT [--dry-run] [--expected-revision N] --json` restore snapshots.

A batch is `{ "expectedRevision": N, "label": "Optional description",
"operations": [...] }`. Use the revision read from history. A supplied CLI
revision must equal the batch revision. Operations are strict `track.add/remove`
and `clip.add/move/trim/split/remove/audio/visual` and `canvas.set` objects; unknown fields fail. Times are safe
nonnegative integer project-frame indices. For example, on revision 0:

```json
{
  "expectedRevision": 0,
  "operations": [
    { "type": "track.add", "id": "v1", "name": "Video", "mediaType": "video" },
    {
      "type": "clip.add",
      "id": "c1",
      "assetId": "EXISTING_ASSET_ID",
      "trackId": "v1",
      "at": 0,
      "in": 0,
      "out": 30
    }
  ]
}
```

Explicit IDs let later operations refer to new tracks/clips; split uses optional
`rightId`. Each operation validates against the preceding result, including
intermediate overlap/reference/source-bound checks. Failure leaves project bytes,
revision and both stacks unchanged. Empty batches fail. Media imports/removals
remain individual commands, each entering this same history; duplicates and no-op
edits add nothing. Undo/redo restore exact content/IDs/timestamps without probing
or changing media. Revisions increase on every changed apply/undo/redo. Changed
edits clear redo; no-ops, including batches whose edits cancel out, and failed edits
retain it. Cancelling batches also preserve revision and timestamps. Empty undo/redo fails.

Use `--expected-revision N` on individual track/clip/media mutations or undo/redo
when acting on prior inspection. Stale revisions fail; reload and reassess before
retrying. Without the flag, these commands use the locked current state. Apply
always requires the batch revision. All these mutations accept `--dry-run`.
Dry-run previews without modifying project bytes/mtime or history; its temporary
OS writer lock is released; its permanent sidecar remains. Import dry-run still needs ffprobe. Generated preview IDs
and timestamps are provisional. Individual commands retain their original JSON
shapes and show proposed results during dry-run.

Apply/undo/redo returns `{ path, dryRun, baseRevision, changed, revision, undo,
redo }`, with `results` on apply (operation `type` plus existing result fields).
For dry-run, revision/history describe the projected state, not the saved state.
History lives inside the atomic project JSON and survives reloads. It retains two
full content snapshots per changed edit without automatic pruning. Do not hand-edit
content behind history; mismatches are refused instead of restoring over it.
Check exit status before parsing stdout: 0 success, 1 data/runtime/file/conflict,
2 invalid CLI arguments. Errors are structured on stderr with `--json` and produce no success JSON.
After real apply/undo/redo, read back history and timeline/media state.

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

## Project rendering

`project render <project-file> --output <file.mp4> [--quality <draft|balanced|high>] [--resolution <project|720p|1080p>] [--overwrite] [--json]` reads a saved project
snapshot and composites video/image tracks with mixed audio to H.264/yuv420p and AAC MP4. It requires FFmpeg 8+
with libx264 and standard filters, plus ffprobe on PATH. The project's resolution
and exact rational frame rate determine the default output. Original video audio is preserved
by default. Independent audio clips on any number of audio tracks can overlap
original audio and each other across tracks. Transitions, audio effects,
keyframes and fades remain outside the current editing model. Project viewer
composites the same saved layer configuration; source preview plays originals.

T28 [desktop export](../../../docs/EXPORT.md) also offers HEVC and
output-frame-rate conversion.
The CLI keeps project-rate H.264 and its existing quality/resolution flags; there
are no CLI codec or output-frame-rate flags. Desktop exports always refuse existing
files; CLI replacement requires explicit `--overwrite` and successful verification.

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
even dimensions. `backgroundColor` accepts `#RRGGBB`, `#RRGGBBAA` or `transparent`, default `#000000`.
Preview retains canvas alpha. H.264 flattens the composition over black.
`clip visual` accepts any nonempty subset of `--x`, `--y`, `--scale`, `--opacity`
and `--fit`; `clip add` accepts the same flags. These mutations support dry-run,
revision guards, atomic save and undo/redo. Omitted properties retain stored values.

Visual defaults are x/y 0, scale 1, opacity 1, fit `contain`. Coordinates are pixel
offsets from the centered fitted layer: positive x moves right, positive y down.
Negative offsets use `--x=-120` / `--y=-80`. Before pixel-grid quantization, the fitted layer top left is
`(canvas.width - layer.width)/2 + x`, `(canvas.height - layer.height)/2 + y`.
Offsets are finite decimals in [-32768, 32768]. Scale is uniform in [0.01, 4] and
multiplies the canvas fitting rectangle before centering/translation. Each rectangle
side rounds to the nearest even pixel (minimum 2, ties upward), with a render limit
of 8192 per side. `contain` preserves display aspect ratio inside that rectangle;
its unused margins are transparent. `cover` preserves display aspect ratio, fills
the rectangle and crops centrally. `stretch` fills the rectangle independently in
x/y. All modes normalize sample aspect ratio to square pixels. Shared geometry
snaps crop and placement to the even 2-pixel grid before both preview and export. Content outside the canvas
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
to that grid with FFmpeg's `fps` filter before integer frame trimming. A source
frame can first appear on the project tick at or after its presentation timestamp.
A split therefore selects exactly the same sampled frames as the unsplit clip,
even when source and project rates differ. The configured fit, scale and position
are applied after sampling, preserving source alpha. At fractional EOF rounding, at most
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

For a complete create/import/trim/split/gap/render sequence and its expected frame
count, see the [worked example](../../../docs/CLI.md#worked-render-example).

For a complete video/image batch with portrait canvas settings, overlay duration,
transforms and expected output timing, see the
[layered portrait example](../../../docs/CLI.md#layered-portrait-render-example).

## Prerequisites and paths

`probe` requires external `ffprobe` on PATH; extraction also requires `ffmpeg`
with PNG support. Install prerequisites manually. Probe/extraction subprocesses have a 60-second
limit and bounded output (4 MiB for probe; 64 MiB for extraction). Runtime failures
produce no JSON on stdout; errors are structured on stderr with `--json`. These probe/extraction commands provide
human-readable output when `--json` is omitted.

For filenames starting with `-`, place options before `--` and the filename,
or use an absolute path. For an output name starting with `-`, use
`--output=-frame.png` or an absolute path. Quote paths in the calling shell.
The complete [CLI/API contract](../../../docs/CLI.md) describes all fields and
limits. Electron integrates project management, editing and preview; project
export remains a CLI operation.

## Shared project sessions (T22)

Existing commands transparently use the active Electron session on macOS/Linux.
GUI edits and CLI edits share durable history and revision checks, and the open
timeline updates without reopening. After a session disconnect, query history
and content before retrying: an acknowledged response may have been lost after
commit. Do not delete the permanent ownership sidecar. See
[the complete session and recovery contract](../../../docs/CLI.md#shared-projects-in-electron-t22).

## Preview proxies and cache (T25)

```sh
node apps/cli/dist/index.js cache status --json
node apps/cli/dist/index.js cache proxy /path/source.mp4 --json
node apps/cli/dist/index.js cache proxy /path/source.mp4 --regenerate --json
node apps/cli/dist/index.js cache frame /path/source.mp4 --timestamp 1.5 --json
node apps/cli/dist/index.js cache configure --disk-mib 2048 --memory-mib 64 --json
node apps/cli/dist/index.js cache cleanup --json
node apps/cli/dist/index.js cache clear --json
```

Use `--directory <dedicated-cache-dir>` or `OPENCUT_MEDIA_CACHE` to select a cache;
the default is `~/.cache/opencut/media-v1`. Proxy generation reports JSONL progress
and a terminal result. `proxy:false` with a reason means verification policy kept
the original. SIGINT/SIGTERM cancellation exits 130/143 after cleanup. `cache frame`
returns a PNG data URL for the presentation interval covering the requested instant,
including CFR/VFR media. Unresolvable timing or extraction failure exits 1.
Limits apply to derivative disk bytes and encoded PNG memory,
not native Chromium memory. Exports always use original project references.
See [supported timing, budgets and management](../../../docs/MEDIA_CACHE.md).
