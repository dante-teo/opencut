# Project format (T10)

OpenCut projects are UTF-8 JSON objects with `schemaVersion: 1`. The suggested
filename is `name.opencut.json`; the API does not require an extension. This is
the shared headless data model, independent of Electron, React and FFmpeg.
T05 provides creation, validation and persistence APIs. T06 exposes creation,
information and validation through the [CLI](CLI.md#projects). T07 adds media
import/list/info/remove APIs and CLI commands. T08 adds shared timeline editing
operations and CLI commands. T09 adds atomic transactions and persistent undo/redo.
T10 renders a single video track through `project render`; desktop project integration remains deferred. See [render limits and timing](CLI.md#project-rendering).

## Example

```json
{
  "schemaVersion": 1,
  "metadata": {
    "id": "project-demo",
    "name": "Demo",
    "createdAt": "2026-10-24T08:00:00.000Z",
    "updatedAt": "2026-10-24T08:00:00.000Z"
  },
  "settings": {
    "width": 1920,
    "height": 1080,
    "frameRate": { "numerator": 30000, "denominator": 1001 }
  },
  "assets": [
    {
      "id": "asset-camera",
      "name": "Camera",
      "file": { "type": "relative", "path": "media/camera.mp4" },
      "mediaTypes": ["video", "audio"],
      "duration": { "numerator": 1001, "denominator": 100 },
      "metadata": {
        "kind": "video",
        "formatName": "mov,mp4,m4a,3gp,3g2,mj2",
        "durationSeconds": 10.01,
        "width": 640,
        "height": 360,
        "videoCodec": "h264",
        "audioCodec": "aac",
        "frameRate": 29.97002997002997,
        "frameRateRatio": "30000/1001",
        "hasAudio": true
      }
    },
    {
      "id": "asset-music",
      "name": "Music",
      "file": { "type": "relative", "path": "media/music.wav" },
      "mediaTypes": ["audio"]
    }
  ],
  "tracks": [
    { "id": "track-video", "name": "Video", "type": "video" },
    { "id": "track-audio", "name": "Audio", "type": "audio" }
  ],
  "clips": [
    {
      "id": "clip-camera",
      "assetId": "asset-camera",
      "trackId": "track-video",
      "timelineStart": { "numerator": 0, "denominator": 1 },
      "sourceIn": { "numerator": 1001, "denominator": 30000 },
      "sourceOut": { "numerator": 1001, "denominator": 1000 }
    },
    {
      "id": "clip-music",
      "assetId": "asset-music",
      "trackId": "track-audio",
      "timelineStart": { "numerator": 0, "denominator": 1 },
      "sourceIn": { "numerator": 0, "denominator": 1 },
      "sourceOut": { "numerator": 1001, "denominator": 1000 }
    }
  ]
}
```

The camera asset illustrates T07 metadata. The music asset demonstrates that
existing assets without recorded metadata remain valid.

## Fields and invariants

| Entity   | Fields and constraints                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project  | Required `schemaVersion`, `metadata`, `settings`, `assets`, `tracks`, `clips`. Empty collections are valid.                                                                                                              |
| Metadata | Stable `id`, nonblank `name`, UTC `createdAt` and `updatedAt` timestamps with millisecond precision. `updatedAt` must not precede `createdAt`.                                                                           |
| Settings | Positive safe-integer pixel `width` and `height`; positive rational `frameRate` in frames per second. These are project settings, independent of any export codec restrictions.                                          |
| Asset    | Stable `id`, nonblank `name`, `file` reference, nonempty unique `mediaTypes` containing `video`, `audio` or both. Optional positive rational `duration` in seconds and optional probe `metadata`. Omit unknown duration. |
| Track    | Stable `id`, nonblank `name`, `type` of `video` or `audio`.                                                                                                                                                              |
| Clip     | Stable `id`, `assetId`, `trackId`, and rational `timelineStart`, `sourceIn`, `sourceOut` in seconds. The referenced asset must contain the track's media type.                                                           |

IDs start with an ASCII letter or digit and contain only letters, digits,
underscores and hyphens. They must be unique across metadata, assets, tracks and
clips. UUIDs are suitable; `createProject` generates one for the project unless
an ID is supplied. Saving/loading preserves IDs. References never use array
indices, so reordering assets or tracks does not break clips. A clip selects the
referenced track's media type; video with audio may be referenced by separate
video and audio clips.

All object fields are strict: unknown fields, missing required fields and numeric
strings are rejected. This prevents typos or unsupported data from being silently
discarded. Names and paths are preserved rather than trimmed. Temporary playback
URLs and machine-specific cache state are not embedded.

T07 adds optional strict asset `metadata`: `kind` (`video`, `audio`, `image`),
`formatName`, `durationSeconds`, pixel `width`/`height`, `videoCodec`, `audioCodec`,
average `frameRate`, `frameRateRatio` and `hasAudio`. All metadata fields are
required when the object exists; unknown/inapplicable values are `null`, except
the required kind and boolean audio presence. Dimensions are positive safe integers;
duration is finite/nonnegative and FPS is finite/positive when known. Images
use the existing `video` media type for visual content, with metadata kind `image`
and null duration/FPS. Images use explicit clip source ranges as model durations
on video tracks, without an inferred finite source bound.
Import also stores positive known duration as rational seconds rounded to
microseconds for the existing source-bound validator. Probe metadata is a snapshot;
availability checks do not refresh it or detect changed content at the same path.

## Exact time

Times are `{ "numerator": n, "denominator": d }` representing `n / d` seconds.
Components are JSON numbers restricted to safe integers (`0` through
`9007199254740991`); denominators are strictly positive. Frame-rate numerators
are also strictly positive. NaN, infinity, fractions in either component and
unsafe integers are invalid. Unreduced rational pairs are accepted and preserved.

`frameTime(frame, frameRate)` converts a nonnegative, zero-based frame boundary to
a reduced rational time. Frame 1 at 30000/1001 fps is exactly `1001/30000` seconds;
frame 30000 is exactly 1001 seconds. The helper uses bigint for intermediate
arithmetic and rejects a result that cannot fit in safe JSON integers.
`compareTimes(a, b)` also uses bigint cross multiplication and returns -1, 0 or 1.
Never convert to floating-point seconds to compare boundaries or repeatedly add
decimal frame durations.

Source ranges are half open: `[sourceIn, sourceOut)`. `sourceOut` must be later
than `sourceIn` and no later than an asset's recorded duration, when known.
Source times are measured from the asset's logical start, not raw container PTS.
Playback is implicitly 1×: clip duration is exactly `sourceOut - sourceIn`, and
its timeline end is `timelineStart + duration`. Neither derived value is stored,
so there is no redundant duration to drift out of sync.

Rational seconds support mixed frame rates, exact audio sample boundaries and
subframe offsets. Validation does not round or snap to the project frame grid.
Use `frameTime(frame, project.settings.frameRate)` for project frame boundaries,
or a known source rate for source frame boundaries. Resolving actual VFR frame
timestamps and enforcing future editing/snap policies belong to later work.
T08 rejects overlap on the same track for video and audio. Half-open intervals
may touch exactly; gaps and cross-track overlap are allowed. This rule applies
to validation, loading, serialization and every editing operation. Clip duration
and timeline end must also be representable by safe rational components;
arithmetic never rounds or silently overflows. Collection order is preserved;
T10 rendering sorts clips by timeline position on one video track and rejects
additional tracks. Cross-track compositing/mixing remains undefined. T10 requires
project-frame-aligned times and defines source zero as the first video frame;
see [the rendering contract](CLI.md#project-rendering).

## Media references and portability

`file` is `{ "type": "relative" | "absolute", "path": "..." }`.
Stored paths use forward slashes. Relative paths are resolved from the directory
containing the project file, never the process working directory. Spaces, Unicode,
`#` and `%` are literal filename characters, not URL encoding. URL schemes,
backslashes, control characters and ambiguous rooted relative paths are rejected.
Relative references reject colons anywhere in the path; absolute POSIX references
can preserve filenames containing colons.
`..` is allowed for sibling media folders; these references are not a sandbox or
a renderer filesystem capability.

Prefer `media/camera.mp4` for media inside a project bundle. Moving the bundle
keeps the reference valid without rewriting JSON. Sibling paths remain valid
when the containing folder structure moves together. Absolute POSIX paths
(`/Volumes/Media/camera.mp4`), drive paths (`C:/Media/camera.mp4`) and UNC paths
(`//server/share/camera.mp4`) are supported data, but depend on their original
locations and may need relinking. A foreign-platform absolute path is reported
as unsupported by the local availability check; loading the project still works.

The Node helpers `createMediaReference(mediaFilePath, projectFilePath)` and
`resolveMediaReference(reference, projectFilePath)` take absolute file locations
and handle POSIX/Windows path syntax lexically. The creation helper prefers a
relative reference, including `..`, on a shared filesystem root when that
reference passes validation. Otherwise it retains an absolute reference, including
for POSIX filenames containing colons. Windows input separators are normalized.
This is lexical path handling, not realpath/symlink canonicalization or proof of
Windows runtime support.

Filesystem-backed asset inspection and media availability checks resolve project
directory symlinks to the physical parent before resolving media references,
matching import/update behavior. `canonicalProjectFilePath(path)` provides this
parent canonicalization without following a symlink at the project filename;
updates still reject project-file symlinks and hard links.
When the native parent is absent or not a directory, canonicalization retains the
normalized path so availability checks can report missing media. Foreign-platform
paths remain lexical. This helper requires an absolute path and does not require
the project file itself to exist.

For example, the following uses an absolute reference even though the media and
project share a folder root:

```ts
import { createMediaReference } from '@opencut/core/node';

const file = createMediaReference(
  '/bundle/media/scene:take.mp4',
  '/bundle/project.json',
);
// { type: 'absolute', path: '/bundle/media/scene:take.mp4' }
```

Moving that project does not rewrite the absolute reference. The original media
location must remain available or the reference must be updated by the caller.

## API and errors

Import pure APIs and TypeScript types from `@opencut/core`:

```ts
import {
  createProject,
  deserializeProject,
  getProjectInfo,
  serializeProject,
  validateProject,
} from '@opencut/core';

const project = createProject({ name: 'Untitled' });
const json = serializeProject(project);
const loaded = deserializeProject(json);
const result = validateProject(loaded);
const info = getProjectInfo(loaded);
// info.statistics: { assets: 0, tracks: 0, clips: 0 }
```

Creation defaults to 1920×1080 at 30/1 fps, an empty timeline, a random project
ID and the current timestamp. Supply `id`, `createdAt` and complete `settings`
when reproducible creation is required. Creation and successful validation
produce independent data objects. Validation returns
`{ success: true, project }` or `{ success: false, error }`.

`getProjectInfo(project)` validates and returns independent `schemaVersion`,
`metadata`, `settings` and `statistics` data. Statistics count assets, tracks
and clips; no media probing or availability checking occurs.

Creation, inspection, serialization and deserialization validate and throw `ProjectFormatError`
on invalid input. Its `code` is `INVALID_JSON`, `INVALID_PROJECT` or
`UNSUPPORTED_VERSION`. `issues` contains `path`, `code` and actionable `message`
fields. Paths are JSON pointers, e.g. `/clips/0/assetId`; an empty path denotes
the document root. Structural errors are collected first; cross-reference,
uniqueness and range errors are collected after structural validation succeeds.
Malformed JSON retains its underlying syntax error as `cause`.

Serialization uses a fixed schema field order, two-space indentation, LF and a
trailing newline. Arrays, strings, timestamps and rational components keep their
values and order. Repeated serialization is byte-identical, including after a
deserialize/serialize cycle, regardless of input object key insertion order.
Serialization does not generate IDs or update timestamps.

Optional filesystem operations are in `@opencut/core/node`:

```ts
import {
  checkProjectMedia,
  readProjectFile,
  validateProjectFile,
  writeProjectFile,
} from '@opencut/core/node';

await writeProjectFile(project, '/absolute/path/demo.opencut.json');
const reopened = await readProjectFile('/absolute/path/demo.opencut.json');
const media = await checkProjectMedia(
  reopened,
  '/absolute/path/demo.opencut.json',
);
const report = await validateProjectFile('/absolute/path/demo.opencut.json');
// report.valid requires valid project data and every media reference available.
```

File I/O requires an absolute path for the current host. `writeProjectFile`
creates a new file exclusively in an existing directory and refuses existing
files and symlinks. It validates before opening the destination. T07 adds
`updateProjectFile(path, async (project, path) => ({ project, result }))` for
existing regular, singly-linked files. It locks cooperating writers, validates
the returned project, syncs a temporary file and atomically renames it over the
destination. A no-op preserves bytes and timestamps; failed publication preserves
the prior file. The parent must be writable; project symlinks/hard links are
refused. Outside changes detected before rename cause a retry error. Handled
failures clean temporary data and locks. Forced termination may leave a stale
`<project-file>.lock` or `.opencut-update-*` directory. Power-loss durability and
arbitrary noncooperating writers are outside the guarantee.
I/O failures throw `ProjectFileError` with `READ_FAILED`, `WRITE_FAILED` or
`UPDATE_FAILED`, `path` and the underlying
`cause`. Format/version failures from reads remain `ProjectFormatError`.
Invalid path arguments, including relative project-file locations or
foreign-platform paths passed to file I/O, throw `TypeError` before filesystem
access. Foreign-platform media references remain valid project data and are
reported by `checkProjectMedia` instead.

`checkProjectMedia` is explicitly separate from data validation and loading.
It returns one result per asset with `assetId`, resolved `path`, `status` and
`message`. Statuses are `available`, `missing`, `unreadable`, `not_file` or
`unsupported_path`. It checks regular-file readability (following symlinks), not
codecs, decodability, recorded duration or stream presence. Missing media does not
invalidate the project or delete clips. These operations do not write media,
relink references, install tools or invoke FFmpeg.

`validateProjectFile(absolutePath)` combines loading, data validation and media
availability into a read-only report: `path`, `valid`, `structureValid`, `issues`
and `media`. Malformed JSON, unsupported versions and structural/semantic errors
return `structureValid: false` with format issues and no media checks. Otherwise
`structureValid` is true and `valid` requires every media entry to be available.
Offline projects remain valid data and loadable even when this combined report
has `valid: false`. I/O errors still throw `ProjectFileError`; invalid path
arguments still throw `TypeError`. The CLI maps failed validation to exit 1.

Asset operations are also exported from `@opencut/core/node`:

```ts
import {
  importMediaAsset,
  listMediaAssets,
  getMediaAsset,
  removeMediaAsset,
} from '@opencut/core/node';

const imported = await importMediaAsset(
  '/work/project.json',
  '/media/camera.mp4',
);
const inventory = await listMediaAssets('/work/project.json');
const asset = await getMediaAsset('/work/project.json', imported.asset.id);
await removeMediaAsset('/work/project.json', imported.asset.id);
```

Project locations must be absolute native paths. Import source paths may be
absolute or cwd-relative. Import reuses T02 `probeMedia` and requires manually
installed ffprobe; the other operations do not invoke media tools. The main
core entry point stays free of filesystem and media-tool imports.
`AssetError.code` distinguishes `ASSET_NOT_FOUND`, `ASSET_REFERENCED`,
`SOURCE_UNAVAILABLE` and `INVALID_MEDIA`; tool failures retain `MediaError`.
See [the asset CLI contract](CLI.md#project-media-assets) for results, canonical
source references, duplicate identity, offline behavior and atomic-save limits.

## Timeline editing API

The main `@opencut/core` entry point exports filesystem-free operations:

```ts
import {
  addTrack,
  addClip,
  moveClip,
  trimClip,
  splitClip,
  removeClip,
  removeTrack,
  listTimeline,
  frameTime,
} from '@opencut/core';

const video = addTrack(project, { name: 'Video 1', type: 'video' });
const at = (frame: number) => frameTime(frame, project.settings.frameRate);
const added = addClip(video.project, {
  assetId: project.assets[0]!.id,
  trackId: video.track.id,
  timelineStart: at(30),
  sourceIn: at(15),
  sourceOut: at(75),
});
const moved = moveClip(added.project, added.clip.id, { timelineStart: at(60) });
const trimmed = trimClip(moved.project, added.clip.id, { sourceIn: at(30) });
const split = splitClip(trimmed.project, added.clip.id, at(90));
const timeline = listTimeline(split.project);
const leftRemoved = removeClip(split.project, split.left.id);
const allRemoved = removeClip(leftRemoved.project, split.right.id);
const trackRemoved = removeTrack(allRemoved.project, video.track.id);
```

Operations validate and copy the input before editing, return a validated new
`project`, and never mutate caller data on success or failure. Add functions
return the created `track` or `clip`; move/trim return `clip`; split returns
`left` and `right`; removal returns `removedTrackId` or `removedClipId`.
Optional `id` on add options and optional fourth `rightId` on `splitClip` support
explicit identities for core callers; all IDs must remain globally unique.
Otherwise a collision-checked UUID is generated. Core inputs use exact rational
seconds; CLI integer frame arguments are converted with `frameTime` at the
project frame rate. No core grid snapping is imposed.

Moves preserve source points. Trims keep timeline start fixed and require at
least one source point. Splits require an absolute timeline position strictly
inside the clip; left keeps its ID and right gets a new ID, preserving the same
asset, track, contiguous source mapping, total duration and timeline coverage.
Removing a populated track fails until its clips are moved/removed explicitly.
No operation changes neighboring clip positions or removes source files/assets.
Known duration bounds are enforced; explicit ranges for unknown-duration assets
are allowed without inferring physical source bounds. Offline editing is valid.

`listTimeline` returns `frameRate`, maximum clip-end `duration` (zero if empty),
and ordered `tracks` with time-sorted `clips`. Each listed clip includes derived
`duration` and `timelineEnd`; neither is persisted. `clipDuration(clip)` and
`clipTimelineEnd(clip)` expose these calculations for callers. `addTimes(a,b)`
and `subtractTimes(a,b)` return reduced rational times using bigint intermediate
arithmetic; malformed inputs, negative results and unsafe components fail.

Successful edits update `updatedAt` without moving it backwards. Exact no-op
moves/trims preserve the original metadata and rational representations.
`TimelineError.code` distinguishes `TRACK_NOT_FOUND`, `CLIP_NOT_FOUND`,
`TRACK_NOT_EMPTY`, `INVALID_EDIT` and `SPLIT_BOUNDS`. Validation errors remain
`ProjectFormatError` with JSON-pointer `issues`, including `duplicate_id`,
`invalid_reference`, `incompatible_media`, `invalid_range`, `source_bounds`,
`clip_overlap` and `time_overflow`. Direct arithmetic rejects unsafe results
with `RangeError`; malformed direct time arguments fail schema validation.

For persistence, call these operations inside the existing Node
`updateProjectFile(path, async (project) => ({ project, result }))` callback,
returning the edited project and the desired result. It validates before atomic
publication and preserves typed timeline/format errors. The CLI implements this
adapter; T09 records its edits through the shared transaction history. See
[the CLI editing contract](CLI.md#timeline-editing) for flags and JSON fields.

## Transactions and history API

T09 extends prerelease schema version 1 with optional top-level `editing`:
`{ revision, undo, redo }`. Its absence means revision 0 and empty stacks, so legacy
files load and serialize unchanged until their first changed edit. Revision is a
nonnegative safe integer, increasing once per changed apply, undo or redo; overflow
fails. Undo restores content, while revision records the new commit and never
returns to a historical value. Older strict binaries reject the optional field;
use a T09-capable reader for edited projects.

Both stacks contain strict `{ id, label, committedAt, before, after }` entries.
IDs use the normal stable-ID syntax, labels are nonblank and `committedAt` is a
millisecond UTC timestamp. Each snapshot contains exactly the version 1 project
content fields (`schemaVersion`, `metadata`, `settings`, `assets`, `tracks`,
`clips`), with no nested history/revision. Snapshots receive the same structural
and semantic validation as current content, including project identity checks.
The next undo/redo is at the end of its stack. History operations check snapshot
continuity and the current content against the cursor; inconsistent/manual edits
are refused. Snapshots preserve ordering, metadata and unreduced rational forms.
Full snapshots trade disk space for reliable exact restoration without inverse
commands or event replay; no automatic pruning or event-sourcing system exists.

The filesystem-free main core exports:

- `parseEditTransaction(unknown)`: strict batch validation and typed `EditTransaction`.
- `executeTransaction(project, transaction)`: returns `{ project, results }` and
  commits all T08 operations once, validating the evolving state after each.
  Requires `expectedRevision`; optional `label` defaults to `edit apply`.
- `commitEdit(before, after, label?)`: record a single validated content change.
- `undoEdit(project, expectedRevision?)` / `redoEdit(project, expectedRevision?)`:
  return restored projects with updated stacks and increasing revision.
- `projectRevision(project)`, `checkProjectRevision(project, expectedRevision?)`,
  `projectSnapshot(project)` and `getEditHistory(project)`: revision checks,
  independent content snapshots and compact history summaries.

These APIs copy validated inputs and leave callers' projects untouched on failure.
Primitive T08 functions remain pure transformations; use `executeTransaction` or
`commitEdit` when committing in memory. The Node adapter records a callback's
changed content automatically, including callbacks mutating their input in place.
A callback returning a stale project revision is rejected even without an explicit
expected-revision option.
No-op edits retain stacks and revision. Changed edits clear redo.

No-op detection compares the final content with the original while ignoring only
`metadata.updatedAt`, which intermediate operations refresh automatically. All
other fields, collection ordering and rational representations must match. A batch
that adds then removes a temporary track, or moves/trims a clip and restores its
original values, therefore retains the original timestamps and both history
stacks. The Node adapter preserves the original file bytes and mtime. Every
operation and the expected revision are still validated. History-chain validation
and undo/redo snapshots continue to compare and preserve exact timestamps.

`updateProjectFile(path, callback, options?)` accepts optional `expectedRevision`,
`dryRun`, `label` and `history`. The default `history: 'record'` adds one snapshot
transaction. For callbacks returning the result of `executeTransaction`, `undoEdit`
or `redoEdit`, pass `history: 'restore'` to persist their already managed history
without creating a second entry. Changed managed results must advance the current
revision by exactly one and have consistent history. Pass the revision from the caller's earlier read
as `expectedRevision` to reject stale work before invoking the callback. Batch
execution also checks its own required expected revision. Dry-run plans and
validates the same update but discards it before publication; the callback result
can describe the projected revision/history. Callbacks must not perform external
side effects. A temporary writer lock is acquired and cleaned even for dry-run.
The adapter publishes content, revision and history in one synced atomic rename.

`importMediaAsset` and `removeMediaAsset` also accept a final options object with
`expectedRevision` and `dryRun`, and record `media import` / `media remove` entries.
Import dry-run probes but never modifies the source; duplicates add no history.
The CLI documents the full operation JSON shape in
[transactions, undo and redo](CLI.md#transactions-undo-and-redo).

`EditError.code` distinguishes `INVALID_TRANSACTION`, `REVISION_CONFLICT`,
`REVISION_EXHAUSTED`, `NOTHING_TO_UNDO`, `NOTHING_TO_REDO` and `HISTORY_CONFLICT`.
Batch operation failures identify their one-based index/type in the message.
Format errors remain `ProjectFormatError`; filesystem errors retain
`ProjectFileError`. Detected outside changes during publication use
`REVISION_CONFLICT`. None of these APIs reads or changes original media content.

## Version evolution

The top-level safe-integer version is checked before reading a version's structure.
This schema version is independent of the application version from `opencut --version`.
Version 1 is the sole supported version. T07 deliberately extends this prerelease
version with optional asset metadata: existing T05/T06 files still load unchanged,
but older strict readers cannot read assets containing the new metadata field.
T08 tightens prerelease version 1 semantic validation to forbid same-track overlaps
and unsafe derived times without changing stored fields. Pre-T08 documents that
violate those rules are rejected with actionable issues; they require explicit
position/range correction, with no automatic migration or ripple adjustment.
Other safe-integer versions are rejected
with a clear supported-version message; missing, unsafe or malformed versions
are invalid structures. Future format changes must explicitly decide whether to
increment the schema version and add a tested migration at this boundary. No migration
registry, automatic upgrade, forward-field stripping or speculative extension
mechanism exists in T05.

Structural validation and inferred TypeScript types share the maintained
[Zod](https://zod.dev/) schema. Bigint arithmetic and Node's path/filesystem APIs
cover the remaining domain and I/O needs without another dependency.
See [ADR 0004](adr/0004-versioned-project-model.md) for the timing, validation and
filesystem-boundary rationale.
