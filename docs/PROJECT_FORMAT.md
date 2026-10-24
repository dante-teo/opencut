# Project format (T07)

OpenCut projects are UTF-8 JSON objects with `schemaVersion: 1`. The suggested
filename is `name.opencut.json`; the API does not require an extension. This is
the shared headless data model, independent of Electron, React and FFmpeg.
T05 provides creation, validation and persistence APIs. T06 exposes creation,
information and validation through the [CLI](CLI.md#projects). T07 adds media
import/list/info/remove APIs and CLI commands. Timeline editing commands,
undo/redo, project rendering and desktop project integration are deferred.

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
and null duration/FPS. No image track type or editing policy is introduced.
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
Clip overlaps and gaps may be represented; T05 defines no compositing or mixing
behavior. Collection order is preserved; no render ordering is implemented.

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

## Version evolution

The top-level safe-integer version is checked before reading a version's structure.
This schema version is independent of the application version from `opencut --version`.
Version 1 is the sole supported version. T07 deliberately extends this prerelease
version with optional asset metadata: existing T05/T06 files still load unchanged,
but older strict readers cannot read assets containing the new metadata field.
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
