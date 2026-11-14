# Project format (T15)

OpenCut projects are UTF-8 JSON objects with `schemaVersion: 1`. The suggested
filename is `name.opencut.json`; the API does not require an extension. This is
the shared headless data model, independent of Electron, React and FFmpeg.
T05 provides creation, validation and persistence APIs. T06 exposes creation,
information and validation through the [CLI](CLI.md#projects). T07 adds media
import/list/info/remove APIs and CLI commands. T08 adds shared timeline editing
operations and CLI commands. T09 adds atomic transactions and persistent undo/redo.
T12 composites video/image tracks and mixes multiple audio tracks through `project render`; T15 reads and saves the same files from Electron. See [render limits and timing](CLI.md#project-rendering).
T13 adds per-export quality/resolution presets, progress and cancellation without
changing schema version 1. Render controls, progress events and job state are not
serialized into project settings or editing history. Exporting with a resolution
preset leaves the saved canvas dimensions and clip coordinates unchanged.
T23 [timeline evaluation](TIMELINE_EVALUATION.md) derives active media and source
times from these same fields. Evaluation results are transient and do not change
schema version 1, project content or history.

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
existing assets without recorded metadata remain valid. An online import adds
optional asset `provenance` containing `provider` (`commons` or `openverse`),
`creator` (a name or null), `sourceUrl`, `license`, and `licenseUrl`. Both URLs
are HTTPS. The asset's `file` points to the downloaded media used for
playback and export.

## Fields and invariants

| Entity   | Fields and constraints                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project  | Required `schemaVersion`, `metadata`, `settings`, `assets`, `tracks`, `clips`. Empty collections are valid.                                                                                                                                                            |
| Metadata | Stable `id`, nonblank `name`, UTC `createdAt` and `updatedAt` timestamps with millisecond precision. `updatedAt` must not precede `createdAt`.                                                                                                                         |
| Settings | Positive safe-integer pixel `width` and `height`; positive rational `frameRate` in frames per second. Optional `backgroundColor` in #RRGGBB/#RRGGBBAA or transparent. These are project settings, independent of any export codec restrictions.                        |
| Asset    | Stable `id`, nonblank `name`, `file` reference, nonempty unique `mediaTypes` containing `video`, `audio` or both. Optional positive rational `duration` in seconds and optional probe `metadata`. Omit unknown duration.                                               |
| Track    | Stable `id`, nonblank `name`, `type` of `video` or `audio`.                                                                                                                                                                                                            |
| Clip     | Stable `id`, `trackId`, and rational `timelineStart`, `sourceIn`, `sourceOut` in seconds. Media clips reference a compatible `assetId` and support optional `volume` and `muted`. Text clips carry a `text` object. Video tracks support optional `visual` transforms. |

IDs start with an ASCII letter or digit and contain only letters, digits,
underscores and hyphens. They must be unique across metadata, assets, tracks and
clips. UUIDs are suitable; `createProject` generates one for the project unless
an ID is supplied. Saving/loading preserves IDs. References never use array
indices, so reordering assets or tracks does not break clips. A clip selects the
referenced track's media type; video with audio may be referenced by separate
video and audio clips.

**Detach audio** marks the new audio clip with `detachedAudio: true`. It keeps
the video source's timing and renders silence after the audio stream ends. The
audio stream must still exist. Moving the clip onto a video track or replacing
its source with audio-only media clears this flag.

Project files store each distinct embedded font once in the optional root
`embeddedFonts` array. A title's `text`, the subtitle track style, or a cue's
style can use `"embeddedFont": { "font": 0 }` to refer to that table, including
in undo and redo snapshots. `deserializeProject` resolves those references to
base64 strings. It also accepts older project files with inline font data.

All object fields are strict: unknown fields, missing required fields and numeric
strings are rejected. This prevents typos or unsupported data from being silently
discarded. Names and paths are preserved rather than trimmed. Temporary playback
URLs and machine-specific cache state are not embedded.

T07 adds optional strict asset `metadata`: `kind` (`video`, `audio`, `image`),
`formatName`, `durationSeconds`, pixel `width`/`height`, `videoCodec`, `audioCodec`,
average `frameRate`, `frameRateRatio` and `hasAudio`. These fields are
required when the object exists. Unknown or inapplicable values are `null`
where the field allows it. Dimensions are positive safe integers;
duration is finite/nonnegative and FPS is finite/positive when known. Images
use the existing `video` media type for visual content, with metadata kind `image`
and null duration/FPS. Images use explicit clip source ranges as model durations
on video tracks, without an inferred finite source bound.
Import also stores positive known duration as rational seconds rounded to
microseconds for the existing source-bound validator. The optional
`metadata.videoDuration` field stores the probed video stream duration in
rational seconds rounded to microseconds when available. Probe metadata is a snapshot;
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

A valid frame rate and safe frame index do not guarantee a representable frame
time. For example, frame 100 at `3000000000000001/100000000000000` fps is exactly
`10000000000000000/3000000000000001` seconds; its reduced numerator exceeds the
safe-integer limit, so `frameTime` throws `RangeError`. The rate itself is valid.
The desktop ruler calculates tick positions and labels directly with bigint
fractions and frame counts. Transient playhead positions use a bounded rational
approximation when the frame-count API or exact result cannot fit its integer
limits. This view-state fallback does not change the stored project, relax core
validation or make an unrepresentable exact edit persistable.

`compareTimes(a, b)` also uses bigint cross multiplication and returns -1, 0 or 1.
Never convert to floating-point seconds to compare boundaries or repeatedly add
decimal frame durations.

Source ranges are half open: `[sourceIn, sourceOut)`. `sourceOut` must be later
than `sourceIn` and no later than an asset's recorded duration, when known.
Source times are measured from the asset's logical start, not raw container PTS.
Video and audio clips can store an optional rational `speed`, for example
`"speed": { "numerator": 3, "denominator": 2 }` for 1.5×. It ranges from 1/4 to 4
and defaults to 1 when absent. The field is additive in schema version 1. Speed
is constant for the clip. The derived duration is `(sourceOut - sourceIn) / speed`
and the derived timeline end is `timelineStart + duration`. The source points
stay in source seconds. Exact source points can fall between project frames
at any speed, including the default 1×.

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
T12 rendering sorts clips by timeline position within each track, composites video
tracks bottom to top in track array order, and mixes original audio with
independent audio tracks. Title clip boundaries align with project frames.
Source zero is the first video frame or, for audio-only assets, the first
audio sample. See [the rendering contract](CLI.md#project-rendering).

T11 adds optional clip `volume` (finite linear amplitude gain 0–1, default 1) and
`muted` (boolean, default false). Omission remains omission on load/save, so old
version 1 projects and history snapshots round trip without inserted defaults.
`volume: 0` is silence; `volume: 0.5` halves amplitude; `volume: 1` is unchanged.
Muting overrides gain without changing the stored volume. These fields affect
both original video audio and audio-track clips. Splits copy them; trims/moves
preserve them. They are included in transaction snapshots and undo/redo.
T35 extends the same `volume` and `muted` fields to video and audio tracks.
Track and clip gains multiply, and either mute silences the clip. Video track
controls affect original audio independently of picture. Media clips may store
optional `fadeIn` and `fadeOut` objects with a positive rational `duration` in
seconds. Both fade durations are measured on the timeline and must fit the clip's timeline duration. Gain ramps
are linear. The default `from` and `to` amplitudes are 0 to 1 for a fade in and 1
to 0 for a fade out. A split inside a ramp stores the partial endpoint gains
on both pieces to preserve the envelope. When a ramp meets the clip body, its
gain is 1 there. A trim re-anchors fades with standard endpoints and reduces
the fade on the trimmed edge first if they no longer fit. When both source
points change together, the fade in is reduced first.

All T35 fields are optional in version 1. Missing fields keep existing defaults
without changing saved bytes on a read. Earlier strict readers reject the new
fields. The editor, CLI and SDK share transactions, undo and redo for these
settings. Meter readings are transient.

T12 adds optional settings `backgroundColor` (default black; `#RRGGBB`,
`#RRGGBBAA` or `transparent` as of T26) and clip
`visual: { x?, y?, scale?, rotation?, opacity?, fit? }` on video tracks. x/y are finite pixel
offsets [-32768, 32768] from centered placement; scale [0.01, 4] multiplies the
canvas fitting rectangle. Rotation is clockwise degrees in [−36000, 36000],
defaulting to 0, about the fitted rectangle center. Opacity [0, 1] multiplies source alpha. fit is contain
(default), cover or stretch. Defaults x/y 0 and scale/opacity 1 are applied only
during evaluation, preview and export. Transparent margins reveal lower tracks/background. Source ranges
on still images specify static display duration. These optional fields preserve
version 1 compatibility and participate in split, batches and undo/redo. Use
`setClipVisual`, `setCanvas`, or batch `clip.visual` / `canvas.set` to edit them;
see the [CLI semantics](CLI.md#project-rendering) for rounding and render limits.

For example, add `"volume": 0.25, "muted": false` to a clip object. Schema version
remains 1 as an additive prerelease extension; earlier readers reject these new
fields. Rendering rounds absolute audio boundaries to 48 kHz samples, fills gaps with silence and ends at the longest clip across
all tracks. Same-track overlap validation remains unchanged.

T20 exposes these existing clip audio/visual fields and project-frame timing in
the desktop inspector. It adds no schema fields or version changes. GUI property
changes use the same transactions/history as CLI edits and persist with Save;
source preview does not apply clip audio/visual settings. Numeric timing editors
require exact, safely representable project-frame boundaries.

T33 adds asset-free text clips in version 1. A clip has exactly one of
`assetId` or `text`. `text` stores the content and optional typography,
rotation and effects. The clip's `visual` stores x/y/scale/rotation/opacity.
Title style rotation remains part of the typography and composes with clip rotation. Text is
valid on video tracks and follows their stacking and overlap rules. Clip audio
and `visual.fit` apply to media clips. The text range uses the existing
`sourceOut - sourceIn` duration with a source in point of zero on creation.
Trimming or splitting can produce a nonzero source in point. It changes
timing while the same static text stays visible.

Existing project and history data load without a migration. Earlier readers
reject projects containing text clips. No asset entry, file reference or
generated raster is persisted for a text clip. See
[text layer fields](CLI.md#text-layers-t33).

### Visual keyframes (T37)

Video-track media and title clips can store a sparse `keyframes` object in
schema version 1. Each present property holds a nonempty array in ascending time
order, with unique times. Static values in `visual` supply the fallback for
omitted channels and for projects saved before T37.

```json
{
  "x": [
    {
      "time": { "numerator": 0, "denominator": 1 },
      "value": -120,
      "easing": "ease-in-out"
    },
    {
      "time": { "numerator": 3, "denominator": 2 },
      "value": 120,
      "easing": "linear"
    }
  ]
}
```

Allowed channels are `x`, `y`, `scale`, `rotation` and `opacity`, with the
same value bounds as their static counterparts. Times are exact clip-local
seconds from zero through duration, inclusive. An endpoint key can shape the
last segment while the clip's active timeline interval remains half-open. The
nearest key's value holds outside the channel's key span. Rotation interpolates
the specified numbers directly, so 0 to 360 is one clockwise turn.

Each key stores the easing for the segment to its right. For normalized time
`t`, linear is `t`, ease-in is `t²`, ease-out is `1 − (1 − t)²`, and
ease-in-out is quadratic on each half of the segment. A trimmed or split segment
can store `curve: [from, to]`, a strictly increasing subdomain of `[0, 1]`.
Sampling renormalizes the original easing within that subdomain to preserve
its shape over the surviving interval.

A clip move preserves local times. Source trims retain and rebase the animation
over the surviving interval and synthesize cut keys where needed. Extensions
hold the nearest surviving value. Undo restores removed keys. A split slices
the same curve on both sides and rebases the right clip to zero. Speed changes
multiply local times by old speed divided by new speed. Project history stores
these changes in the same snapshots as other clip edits.

### Subtitle track

T34 adds an optional top-level `subtitles` object with a shared `style` and
a `cues` array. Each cue stores `id`, `text`, `start` and exclusive `end`.
Cue IDs are unique across project entities, and cues can overlap. Exact rational
seconds are independent of the project frame rate. Subtitle cues extend the
timeline duration. Their rendering layers and display lanes are derived and
excluded from project storage. The track is included in history snapshots.
Version 1 files without this field retain their existing behavior. Earlier
OpenCut builds with strict schema validation can reject files containing the
new field. See [subtitle commands and fields](CLI.md#editable-subtitles-t34).

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

T19 desktop imports made before the first save store absolute source references,
since the project directory is not known yet. Saving preserves those references;
it does not rebase them, copy media, or change the schema. Imports made after a
project has a saved path use the normal relative-preferred policy above. After
moving the project, absolute references still depend on their original source
paths.

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
validates and syncs a temporary file, then publishes it with an exclusive hard
link in an existing directory. When hard links are unavailable, it copies the
prepared file to an exclusive destination. The fallback can expose the file
while copying, and a forced termination can interrupt that copy. Both paths
refuse existing files and symlinks. T07 adds
`updateProjectFile(path, async (project, path) => ({ project, result }))` for
existing regular, singly-linked files. It locks cooperating writers, validates
the returned project, syncs a temporary file and atomically renames it over the
destination. A no-op preserves bytes and timestamps; failed publication preserves
the prior file. The parent must be writable; project symlinks/hard links are
refused. Outside changes detected before rename cause a retry error. Handled
failures clean temporary data and release OS ownership. Forced termination may
leave unused `.opencut-create-*` or `.opencut-update-*` directories. If creation
was interrupted just after publication, the temporary directory can hold a
second hard link to the complete new project. Once the creating process has
exited, remove that temporary link before updating the project.
Local saves check cancellation immediately before the final link, copy or rename.
The permanent `.opencut-lock` sidecar stays in place and process death releases
its lock automatically. CLI and SDK project creation can use the copy fallback
on exFAT. Desktop first Save and updates to existing projects also require the
writer lock. See the [session filesystem limits](adr/0011-shared-project-session.md#failure-semantics-and-limits).
Power-loss durability and arbitrary noncooperating writers are outside the guarantee.
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
  setClipAudio,
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
const adjusted = setClipAudio(moved.project, added.clip.id, {
  volume: 0.25,
  muted: false,
});
const trimmed = trimClip(adjusted.project, added.clip.id, { sourceIn: at(30) });
const split = splitClip(trimmed.project, added.clip.id, at(90));
const timeline = listTimeline(split.project);
const leftRemoved = removeClip(split.project, split.left.id);
const allRemoved = removeClip(leftRemoved.project, split.right.id);
const trackRemoved = removeTrack(allRemoved.project, video.track.id);
```

Operations validate and copy the input before editing, return a validated new
`project`, and never mutate caller data on success or failure. Add functions
return the created `track` or `clip`; move/trim/audio/visual updates return `clip`;
canvas updates return `settings`; split returns
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
`setClipAudio(project, clipId, options)` requires at least one of `volume` or
`muted`; omitted properties keep their stored values. `addClip` accepts these
same optional properties. They apply equally to video and audio clips; they do
not automatically update other clips referencing the same asset. Muting and zero
gain leave clip duration and timeline coverage unchanged.

`setClipVisual(project, clipId, options)` accepts a nonempty subset of x, y,
scale, rotation, opacity and fit, typed as `ClipVisualOptions`. The clip must be on a video
track. Omitted or explicitly undefined properties retain their stored values;
`addClip` accepts the same properties inside its optional `visual` object. Splits
copy the visual object; moves/trims preserve it. Setting opacity to zero leaves
audio and duration intact.

`setCanvas(project, options)` accepts a nonempty subset of width, height and
backgroundColor. It returns `{ project, settings }` and preserves frameRate and
omitted settings. Both operations are pure and use the existing project validation
and timestamp rules. Model dimensions need only be positive safe integers; the
renderer separately enforces even dimensions and its pixel budget. To restore
visual defaults, pass x/y 0, scale/opacity 1 and fit contain; use `#000000` for a
black background. Default-valued properties remain explicitly stored.

```ts
import { setCanvas, setClipVisual } from '@opencut/core';

const portrait = setCanvas(project, {
  width: 1080,
  height: 1920,
  backgroundColor: '#183048',
});
const positioned = setClipVisual(portrait.project, clipId, {
  x: 300,
  y: -150,
  scale: 0.3,
  opacity: 0.75,
  fit: 'contain',
});
```

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

## Creator timeline editing (T39)

Tracks can store optional locked flags. Clips can store an optional linkId
shared by clips that move as a group. A project's optional markers array
holds records with a stable id, a nonnegative project frame, and a name.
All three fields are saved in history snapshots. Existing project files
without these fields still load. Earlier strict readers may reject them.
See [Timeline editing](TIMELINE_EDITING.md) for operation semantics.

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
millisecond UTC timestamp. Each snapshot contains the version 1 project
content fields (`schemaVersion`, `metadata`, `settings`, `assets`, `tracks`,
`clips` and optional content fields such as subtitles, transitions and markers),
with no nested history/revision. Snapshots receive the same structural
and semantic validation as current content, including project identity checks.
The next undo/redo is at the end of its stack. History operations check snapshot
continuity and the current content against the cursor; inconsistent/manual edits
are refused. Snapshots preserve ordering, metadata and unreduced rational forms.
Full snapshots trade disk space for reliable exact restoration without inverse
commands or event replay; no automatic pruning or event-sourcing system exists.

The filesystem-free main core exports:

- `parseEditTransaction(unknown)`: strict batch validation and typed `EditTransaction`.
- `previewTransaction(project, transaction)`: returns `{ project, results }` after
  validating the expected revision and applying the same T08 operations against
  evolving temporary state. It does not record history or advance revision.
- `executeTransaction(project, transaction)`: returns `{ project, results }` and
  commits all T08 operations once, validating the evolving state after each.
  Requires `expectedRevision`; optional `label` defaults to `edit apply`.
- `commitEdit(before, after, label?)`: record a single validated content change.
- `undoEdit(project, expectedRevision?)` / `redoEdit(project, expectedRevision?)`:
  return restored projects with updated stacks and increasing revision.
- `projectRevision(project)`, `checkProjectRevision(project, expectedRevision?)`,
  `projectSnapshot(project)` and `getEditHistory(project)`: revision checks,
  independent content snapshots and compact history summaries.

Preview results are transient. Primitive operations can refresh their
`metadata.updatedAt`; this does not make the preview a committed edit. History
continuity is checked when committing, undoing or redoing, so a successful preview
is not proof that a later commit will succeed. Submit the commands against the
authoritative project with its current revision through `executeTransaction`.
Desktop previews reuse a validated content-only snapshot to avoid repeatedly
copying historical snapshots; see [the desktop architecture](ARCHITECTURE.md#desktop-trust-boundary).

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
`dryRun`, `label` and `history`:

- `history: 'record'` (default) records the callback's content change as one
  transaction.
- `history: 'restore'` persists one already managed transaction from
  `executeTransaction`, `undoEdit` or `redoEdit`, without adding a second entry.
  Changed results must advance the on-disk revision by exactly one.
- `history: 'preserve'` persists several already committed in-memory edits and
  undo/redo steps together, retaining their separate entries. Changed results
  must have a revision strictly greater than the on-disk revision.

Both managed-history modes require unchanged project identity and consistent
history. An unchanged result preserves the existing file bytes and mtime.
For `expectedRevision`, pass the revision last read from disk, rather than the
new in-memory session revision. The desktop also compares its serialized disk
baseline inside the callback to refuse external changes at the same revision.
Batch execution independently checks its required expected revision against the
project being edited.

Dry-run plans and validates the same update but discards it before publication;
the callback result can describe the projected revision/history. Callbacks must
not perform external side effects. A temporary writer lock is acquired and
cleaned even for dry-run. The adapter publishes content, revision and history
in one synced atomic rename.

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
T09 adds optional editing history. T11 adds optional clip audio properties; T12
adds optional clip visual properties and canvas background color without
inserting defaults into existing clips or snapshots; older strict readers reject
these new fields. See [ADR 0008](adr/0008-positioned-audio-mixing.md) and
[ADR 0009](adr/0009-video-compositing-and-canvas.md). T26 extends the existing
`backgroundColor` field to alpha-bearing colors through the same `canvas.set`
operation and history. Earlier strict readers may reject those color values even
though the prerelease schema version remains 1. Preview preserves canvas alpha;
H.264 flattens it over black. [ADR 0012](adr/0012-realtime-layer-composition.md)
records the shared preview/export geometry and RGB rules.
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

T22 routes these Node reads/updates through an active Electron session when present;
otherwise updates acquire standalone ownership. The JSON schema and history remain
unchanged. See [the session decision](adr/0011-shared-project-session.md).

## Video transitions (T38)

Projects may store a top-level `transitions` array. Each record has a stable
`id`, a `kind`, and an integer `frames` count of at least two project frames.
A `cross-dissolve` references the outgoing and incoming clip IDs with `from`
and `to`. A `fade-in` or `fade-out` references one clip with `clipId`.
Older projects can omit the array. Undo and redo snapshots preserve it.

If the cut is on frame `C` and the duration is `N`, the cross-dissolve starts
on `C - floor(N / 2)` and occupies `N` consecutive frames. The incoming
video uses its pre-in handle before the cut and the outgoing video uses its
post-out handle after it. Source time follows each clip's existing affine
mapping, including speed. Each handle must cover the part of the window
outside its clip's nominal interval. The window must fit inside the two
clips' combined nominal interval. The outgoing asset needs a known duration.
Validation uses `metadata.videoDuration` when present and otherwise uses the
stored asset duration for the outgoing handle. Video stream duration checks
allow one microsecond of probe precision, as export does when checking the
current source. Import the original to record its duration and trim both
clips to leave handles.

Fade-in starts at the clip's first frame. Fade-out ends at its exclusive out
frame. All transition anchors must fall on project frame boundaries and
windows on the same track must be disjoint. The first and last sampled frames
are the exact endpoints. Between them, the weight is linear over `N - 1`
frame intervals. Cross-dissolve interpolates the premultiplied color and alpha
of the fitted layers. Fade-in and fade-out scale the video layer's alpha over
the existing lower layers and canvas background.

A transition never changes clip ranges, track order, project duration or
audio. A split keeps a start transition on the left piece and moves an end
transition to the right piece. A split inside a participating edge's window,
or any clip edit that invalidates a transition, fails atomically. Remove or
shorten the transition first. Removing a clip removes its attached
transitions in the same history entry.
