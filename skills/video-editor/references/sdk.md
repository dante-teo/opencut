# OpenCut TypeScript SDK and script runner

Use Node.js 24.12+ within 24.x. Import only from the public `@opencut/sdk`
package root. The CLI and SDK share the same projects, edits and compositor.
Use the supplied SDK package and TypeScript declarations. In an OpenCut
workspace package, the dependency is `"@opencut/sdk": "workspace:*"`.
In a standalone deployment, place the script where Node can resolve the
deployed `node_modules/@opencut/sdk`. Use `.mts` outside an ESM package.
Native Node TypeScript execution strips erasable types without type checking.

## Standalone SDK

| API                                                                        | Use                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `openProject(path, { expectedRevision? })`                                 | Open a named project, including the authoritative snapshot of an open desktop session.                                             |
| `createProject(path, { name, settings? })`                                 | Stage a new project. Set width, height and `frameRate: { numerator, denominator }` in `settings`.                                  |
| `editor.project.inspect()`, `inspectTimeline(frame)`, `history()`          | Read staged project, evaluated timeline and history. Staged content retains the base revision until saved.                         |
| `project.importMedia(file)`, `checkMedia()`, `removeMedia(assetId)`        | Link a source and get its `asset.id`, check availability, or remove an unused reference.                                           |
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

Use `project.apply({ type: 'text.add', at: 30, duration: 90, text: { content: 'OpenCut\n中文字幕' } })`
to stage editable text. The SDK exports `TextLayer` for typed style data.
Use `text.set` to revise an existing layer. See the
[CLI batch reference](cli.md#edit-safely) for the shared fields and units.

Preview calls resolve to the output `path`, `width` and `height`. The sheet
result also includes its grid and tile dimensions. Keep your explicit frame
list alongside the result when you need to associate each tile with a frame.
Render options include `quality: 'draft' | 'balanced' | 'high'`,
`resolution: 'project' | '720p' | '1080p'`, `codec: 'h264' | 'hevc'`, and
`outputFrameRate: { numerator, denominator }`. The defaults are balanced H.264
at the project size and rate. Use `signal` to cancel or `onProgress` to observe
encoding. Await the render result before using the file. The result includes
`path`, `width`, `height`, `frameRate`, `frameCount`, `durationSeconds` and
probed `metadata`.

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
