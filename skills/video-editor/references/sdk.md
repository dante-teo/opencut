# OpenCut TypeScript SDK and script runner

Use Node.js 24.12+ within 24.x. Import only from the public `@opencut/sdk`
package root. The CLI and SDK share the same projects, edits and compositor.
Use the supplied SDK package and TypeScript declarations. In an OpenCut
workspace package, the dependency is `"@opencut/sdk": "workspace:*"`.
In a standalone deployment, place the script where Node can resolve the
deployed `node_modules/@opencut/sdk`. Use `.mts` outside an ESM package.
Native Node TypeScript execution strips erasable types without type checking.

## Whole-video definitions

Use `defineVideo()` to type a definition and `compileVideo(file, { signal })`
to obtain its `path`, frozen `project` and computed `frameCount`. Use
`compileVideo(file, { signal, preview: true })` when previewing a selected
range. The renderer checks the subtitle limit for that range. Use
`migrateProject(source, output, { signal })` with a new `.video.json` or
`.video.ts` destination to convert a saved project. See the
[whole-video workflow](video-definitions.md) for authoring and CLI examples.

## Standalone SDK

| API                                                                        | Use                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `openProject(path, { expectedRevision? })`                                 | Read the committed project file independently of Electron.                                                                         |
| `createProject(path, { name, settings? })`                                 | Stage a new project. Set width, height and `frameRate: { numerator, denominator }` in `settings`.                                  |
| `editor.project.inspect()`, `inspectTimeline(frame)`, `history()`          | Read staged project, evaluated timeline and history. Staged content retains the base revision until saved.                         |
| `project.importMedia(file)`, `checkMedia()`, `removeMedia(assetId)`        | Link a source and get its `asset.id`, check availability, or remove an unused reference.                                           |
| `project.searchOnlineMedia(input)`, `importOnlineMedia(id, directory)`     | Search Wikimedia Commons or Openverse and stage an imported result with provenance.                                                |
| `project.apply(...operations)`                                             | Stage a validated group using the [batch operation fields](cli.md#edit-safely). A failed group leaves the previous draft intact.   |
| `editor.save({ dryRun?, label? })`                                         | Validate publication or publish all staged edits as one undo step. Existing editors guard their opened snapshot.                   |
| `project.undo()`, `project.redo()`                                         | Stage one history step. Save it separately from content edits.                                                                     |
| `project.previewFrame(frame, output, { maxDimension? })`                   | Write a composited PNG from the staged draft.                                                                                      |
| `project.previewContactSheet(frames, output, { columns?, maxDimension? })` | Write a labeled PNG for 1–16 explicit project frames, in the requested order.                                                      |
| `project.render(output, options?)`                                         | Render the staged draft to a new MP4. Options include quality, resolution, codec, output frame rate, signal and progress callback. |

Await each async operation on a draft before starting another. For an existing
project, start with inspection and keep the opened revision. Dry-run the save,
then review the draft. A per-save dry run keeps the editor usable. Opening or
creating an editor with `{ dryRun: true }` makes every save simulated and
disables previews and renders on that handle.

Online search input includes `provider`, `kind`, `query` and optional `page`.
Use a returned result ID to import. Import downloads and probes an external
file before staging the asset. On a dry-run editor, it discards the download.
On a normal editor, save the draft and keep the downloaded file. An available
result is reused; importing an offline result creates a new asset. Use
`project.relinkMedia(assetId, file)` to preserve existing clip references.
After an uncertain save, inspect the project and history before retrying.

Use `project.apply({ type: 'text.add', at: 30, duration: 90, text: { content: 'OpenCut\n中文字幕' } })`
to stage editable text. The SDK exports `TextLayer` for typed style data.
Use `text.set` to revise an existing layer. See the
[CLI batch reference](cli.md#edit-safely) for the shared fields and units.

Preview calls resolve to the output `path`, `width` and `height`. The sheet
result also includes its grid and tile dimensions. Keep your explicit frame
list alongside the result when you need to associate each tile with a frame.
Render options include `quality: 'draft' | 'balanced' | 'high'`,
`resolution: 'project' | '720p' | '1080p'`, `codec: 'h264' | 'hevc'`, and
`outputFrameRate: { numerator, denominator }`. For custom dimensions, use
`outputSize: { width, height }` in project resolution mode. Use
`videoBitrateKbps`, `audioBitrateKbps`, `audioSampleRate`, and `audioChannels`
to set encoding targets. The defaults are balanced H.264
at the project size and rate. Use `signal` to cancel or `onProgress` to observe
encoding. Await the render result before using the file. The result includes
`path`, `width`, `height`, `frameRate`, `frameCount`, `durationSeconds` and
probed `metadata`.

`project.cachePreview(size?)` renders or reuses an MP4 of the staged draft.
Use `project.controlDesktop(request)` for an open, saved desktop project on
macOS or Linux. It controls review and playback. The reply identifies the viewer revision. See the
[CLI reference](cli.md#discover-and-inspect) for request discovery and status.

For example, insert a one-second cutaway on a new top track at frame 45 of an
existing 30 fps project. Choose IDs that are unused in the inspected project
and a source that is at least one second long.

```ts
import { openProject } from '@opencut/sdk';

const editor = await openProject('project.opencut.json');
const { project } = editor;
const { asset } = await project.importMedia('b-roll.mp4');
project.apply(
  {
    type: 'track.add',
    id: 'cutaway-track',
    name: 'Cutaway',
    mediaType: 'video',
  },
  {
    type: 'clip.add',
    id: 'cutaway',
    assetId: asset.id,
    trackId: 'cutaway-track',
    at: 45,
    in: 0,
    out: 30,
  },
);
console.log(await editor.save({ dryRun: true }));
await project.previewContactSheet([44, 45, 74], 'cutaway-review.png', {
  columns: 3,
  maxDimension: 320,
});
// Open the sheet and check the edit before saving.
```

After reviewing the image, call
`await editor.save({ label: 'Insert cutaway' })` on the same draft. For a
non-interactive agent, use separate review and commit invocations. On the commit
invocation, check the reviewed base revision with `openProject` and
`expectedRevision`, then rebuild the same edit before saving. Reopen the project
to confirm its revision and content. Preview and export files are independent
of the project save. For delivery, render the saved draft, then probe and decode
the published MP4 as described in the [CLI reference](cli.md#visual-review-and-export).

On errors, use the error's `code` when available and read its message.
After a conflict, reopen and reconcile. After a session disconnect during save,
read back the project and history before retrying. To discard pending changes,
open a fresh editor and leave the previous draft unsaved.

## Trusted script runner

```sh
opencut help run --json
opencut run edit.mts --project "$PROJECT" --expected-revision "$REV" --dry-run --json -- "$SOURCE"
opencut run edit.mts --project "$PROJECT" --expected-revision "$REV" --json -- "$SOURCE"
```

Default-export a function receiving `{ project, args, dryRun, signal }`.
You can use a type-only import of `OpenCutScript` from `@opencut/sdk` to type
the function. Arguments after `--` go to the function. Use the caller's
working directory for relative media and output paths. For a fresh project,
replace `--expected-revision` with `--create "Project name"`. This starts at
1920×1080 and 30 fps. Set other canvas dimensions with `canvas.set`, or use
standalone `createProject` when a different frame rate is needed.

Return JSON data and use `console` for logs. Await all work before returning.
The runner saves through the bound draft after the function and result
serialization succeed. On `dryRun`, skip file-producing operations. The
runner disables SDK previews and renders in this mode. Run trusted code only.
The draft transaction does not cover files written by the script or a separate
SDK handle.

## Subtitles

`await project.importSubtitles(file)` stages SRT or WebVTT cues. Find IDs
with `project.inspect().subtitles?.cues`, edit using `project.apply(...)`
with `subtitle.*` operations, and publish via the editor's `save()`.
`parseSubtitleTime('1.25')` produces rational seconds for cue fields.
`await project.exportSubtitles('new.vtt')` writes the current draft as a
sidecar. `project.render('new.mp4')` burns visible cues into the video by
default. Set `{ burnSubtitles: false }` for clean video at the same duration.
Use `subtitle.words` with exact cue-relative intervals to time word highlights
in preview and burn-in.

For a music clip, stage
`editor.project.apply({ type: 'clip.audio', id: musicClipId, volume: 0.5, fadeIn: 15, fadeOut: 30 })`.
Use `{ type: 'track.audio', id: musicTrackId, volume: 0.5, muted: false }`
to set the containing track's gain and mute. Fade durations are project frames,
must fit within the clip together, and clear at zero. Both gains multiply and
either mute silences the clip. Save the edits together and inspect the draft or
reopen the project to verify the settings.

## Clip speed

Import `parseClipSpeed` from `@opencut/sdk` and apply
`{ type: 'clip.speed', id: clipId, speed: parseClipSpeed('3/2') }`.
This keeps the source range and timeline start fixed. Check the resulting end
and validate neighboring clips before saving. Fades retain their timeline
durations and subtitle cues keep their positions. For exact off-grid source
trims, use `clip.trim` with `inTime` or `outTime` in rational seconds.
The same exact trim fields work at default speed.

## Keyframe animation

Stage keyframe operations with `project.apply` and save them with the existing
revision guard and history.

```ts
project.apply(
  {
    type: 'clip.keyframe.add',
    id: clipId,
    property: 'opacity',
    time: { numerator: 0, denominator: 1 },
    value: 0,
    easing: 'ease-in',
  },
  {
    type: 'clip.keyframe.add',
    id: clipId,
    property: 'opacity',
    time: { numerator: 1, denominator: 2 },
    value: 1,
  },
);
```

Use `clip.keyframe.set` with the original clip-local `time` and `newTime` to
move a key, or supply `value` or `easing` to edit it. Use
`clip.keyframe.remove` with `id`, `property` and `time` to delete it.
`inspect()` exposes stored keys and `inspectTimeline(frame)` exposes sampled
visual transforms. Check the sampled values and render representative frames
from the same revision.

## Video transitions

```ts
editor.project.apply({
  type: 'transition.add',
  id: 'intro-cut',
  transition: { kind: 'cross-dissolve', from: 'intro', to: 'main', frames: 12 },
});
await editor.save({ label: 'Add intro dissolve' });
```

A fade takes `{ kind: 'fade-in', clipId: 'intro', frames: 6 }` or
`kind: 'fade-out'`. Use `{ type: 'transition.set', id, frames }` to adjust the
duration and `{ type: 'transition.remove', id }` to delete it.
`project.inspect().transitions` lists the records.

Use `project.copyClips(ids)` to capture a typed same-project clipboard, or
`project.cutClips(ids)` to also stage removal. Pass the clipboard to `clips.paste`
and specify an explicit ripple or insert scope when shifting other clips.
`project.apply(...operations)` returns detached operation results. To change
the draft, stage another operation and save. A save commits the staged edits
as one history entry.

## Durable render jobs

Import `LocalJobs` from `@opencut/sdk`. Use
`await jobs.submit({ type: 'render', projectPath, expectedRevision }, { idempotencyKey })`
with a saved project. Save draft edits before submitting if they belong in
the export. Inspect `await jobs.status(id)` and use `result.path` once the state
is `completed`. Use `jobs.list()`, `jobs.cancel(id)` and `jobs.retry(id, attempt)` to
recover and manage jobs from another process. The retry attempt comes from the
status response. Inspect the retry response to see whether it recovered the
original attempt or queued another one. Reuse the same submission key and
request after a client timeout.
