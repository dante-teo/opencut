# OpenCut TypeScript SDK

Use `defineVideo()` for whole-video authoring and `compileVideo(file)` to
compile a TypeScript or JSON definition into an in-memory project.
See [Video as code](VIDEO_DEFINITIONS.md) for the authoring format and examples.
Use `migrateProject(source, output, { signal })` to convert a saved snapshot
into a new `.video.json` or `.video.ts` definition. See
[conversion semantics](VIDEO_DEFINITIONS.md#convert-a-saved-project).

`@opencut/sdk` is a Node ESM workspace package with a public root export and
TypeScript declarations. Add `"@opencut/sdk": "workspace:*"` to a workspace
consumer's dependencies and run `pnpm install` and `pnpm build:packages` from
the checkout root. The repository's examples already have that dependency.
The package is distributed in this workspace. Use the package root for all
SDK imports. External agents can use the portable
[Skill reference](../skills/video-editor/references/sdk.md) with a
[staged runtime](README.md#external-agent-validation).

## Video definition preview

```ts
import { compileVideo, previewVideo, watchVideo } from '@opencut/sdk';

const video = await compileVideo('review.video.ts', { preview: true });
const preview = previewVideo(video);
console.log(preview.inspect());
console.log(preview.inspectFrame({ numerator: 1, denominator: 2 }));
await preview.frame(12, 'frame.png');
await preview.contactSheet({ startFrame: 0, endFrame: 24 }, 'sheet.png');
await preview.clip({ startFrame: 6, endFrame: 36 }, 'sample.mp4');

const watcher = await watchVideo('review.video.ts', {
  onStatus(event) {
    if (event.status === 'ready') console.log(event.current?.playback.path);
    if (event.status === 'error') console.error(event.error);
  },
});
// Call await watcher.close() when review ends, or pass an AbortSignal.
```

Numbers passed to `frame` and `inspectFrame` are project-frame indices.
Rational positions are timeline seconds. `compileVideo` exposes a frozen
`project`, `frameCount`, and `resolveRender()` for the shared renderer. Use
`preview: true` to apply the subtitle limit to the chosen render range.
Outputs require new files in an existing directory.
Preview output makes a private copy of each media file the renderer decodes.
If a needed source changed after compilation, compile the definition again.

Watch events include a monotonic `generation`, a build status, and `current`
with the last playable revision. Pass `current.video` to `previewVideo` to
inspect that revision or produce outputs from its media snapshots. The watcher
owns the scratch files. Consume a revision before it is superseded or copy its
playback MP4 to retain it. `close()` cancels work and removes scratch files.

## Open, edit and save

```ts
import { openProject } from '@opencut/sdk';

const editor = await openProject('project.opencut.json');
const { project } = editor;
const { asset } = await project.importMedia('b-roll.mp4');
project.apply(
  { type: 'track.add', id: 'b-roll', mediaType: 'video', name: 'B-roll' },
  {
    type: 'clip.add',
    id: 'cutaway',
    trackId: 'b-roll',
    assetId: asset.id,
    at: 45,
    in: 0,
    out: 30,
  },
);
console.log(project.inspectTimeline(45));
const plan = await editor.save({ dryRun: true });
console.log(plan);
await editor.save({ label: 'Insert cutaway' });
```

The example assumes the source contains at least 30 project frames. `at`, `in`
and `out` are integer project frames. `at` is an absolute timeline position
and `out` is an exclusive source boundary. Inspection returns exact rational
seconds. The `EditOperation` union provides autocomplete for track add/remove,
clip add/move/trim/split/remove, clip audio/visual settings, track audio, text
and subtitle edits, and canvas settings.
See the [batch command reference](CLI.md#transactions-undo-and-redo) for
operation fields and validation. Pass explicit IDs to refer to a new track or
clip later in the same group. Inspect the draft for generated IDs.

| API                                                                                 | Behavior                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openProject(path, options?)`                                                       | Reads the committed project file independently of Electron. Accepts an optional expected revision.                                                                   |
| `createProject(path, settings, options?)`                                           | Stages a new project. Save publishes at a new path in an existing writable directory. Supply `name` and optionally canvas/frame-rate settings.                       |
| `project.inspect()`, `project.inspectTimeline(frame)`                               | Returns the versioned project or frame inspection of staged content. Pending content edits retain the base revision until publication.                               |
| `project.importMedia(file)`, `project.checkMedia()`, `project.removeMedia(assetId)` | Probes and links sources in place, checks their availability, and removes unused asset entries. Re-importing the same source reuses its ID.                          |
| `project.apply(...operations)`                                                      | Validates the whole group with the shared editing commands. A failed group leaves the draft as it was before the call.                                               |
| `project.history()`, `project.undo()`, `project.redo()`                             | Reads history summaries and stages a single undo or redo. Save that step separately from other edits.                                                                |
| `editor.save({ label?, dryRun? })`                                                  | Checks the opened snapshot and saves all staged content edits as one history entry. A dry run reports the proposed save and retains the draft for later publication. |

Use `EditorOptions.dryRun` on open or create to simulate every save and
disable file-producing SDK operations for that handle. A no-op save of an
existing project preserves its revision, bytes and redo history. New projects
start at revision zero, or one if creation includes staged edits.
Creating a new project can use the exclusive-copy fallback on exFAT. Saving
edits to an existing project requires a filesystem that supports the writer
lock. See the [project file persistence contract](PROJECT_FORMAT.md#api-and-errors).

The draft is local to the editor. Await an import, preview, render or save
before starting another operation on the same draft. Open a fresh editor to
discard staged work or load a new base after a conflict. The SDK uses the
headless writer for atomic publication. A successful save advances the project
revision and its undo/redo history. Electron follows the committed file.

Use `project.relinkMedia(assetId, file)` to replace a source reference,
`project.importFont(titleOrCueId, file)` to embed a font, and
`project.freezeFrame(clipId, at, frames, outputPng)` to write a PNG and stage
the timeline edit. A locked track is rejected before any PNG is created.
Call `editor.save()` to publish a successful edit. Its PNG is written
immediately and remains if you discard the SDK draft.
`project.separateDialogue(assetId, directory)` writes two WAV files using the
[local model](CLI.md#dialogue-separation). Use `project.copyProject(destination, true)`
for a portable package or omit `true` for a project snapshot. Save
pending edits before making a copy.
An editor's signal cancels a local save before publication or an Electron save
before submission. A session disconnect during commit can leave the outcome
unknown. Read back project content and history before retrying. See the
[project session decision](adr/0011-shared-project-session.md) for live session limits.

## Clip playback speed

```ts
import { parseClipSpeed } from '@opencut/sdk';

editor.project.apply({
  type: 'clip.speed',
  id: 'clip-id',
  speed: parseClipSpeed('3/2'),
});
await editor.save({ label: 'Set clip to 1.5×' });
```

The operation accepts a `ClipSpeed` ratio with integer `numerator` and
`denominator` from 1/4 to 4. It preserves the clip's source bounds, timeline
start and fade lengths. Use `clip.trim` with `inTime` or `outTime` (rational
seconds) for source points between project frames, including at default
speed. Splits use project-frame positions and preserve the exact source cut. Inspect the draft with
`inspectTimeline(frame)` to check the mapped source time.

## Audio

Use the existing typed operations on the draft, then save the mix as one edit.

```ts
editor.project.apply(
  {
    type: 'clip.audio',
    id: 'music-clip',
    volume: 0.5,
    fadeIn: 15,
    fadeOut: 30,
  },
  { type: 'track.audio', id: 'music-track', volume: 0.5, muted: false },
);
await editor.save({ label: 'Mix music' });
```

The fade lengths are project frames. Set a length to zero to clear the fade.
Lengths must fit within the clip together. The two gains multiply and either
mute silences the clip. `project.inspectTimeline(frame)` returns the effective
gain at that frame. To measure audible output, decode the rendered audio.

## Preview and render

`project.cachePreview(size?)` renders or reuses the full timeline of the
current draft, including staged edits. The result's `revision` is the draft's
base revision. `project.controlDesktop(request)` sends typed playback, seek,
selection and viewer commands to the open review app on macOS or Linux.
The reply identifies the viewer revision. Editing and saving work independently. See the
[desktop control contract](CLI.md#rendered-preview-and-desktop-control).
`project.apply({ type: 'subtitle.words', id, words })` sets exact cue-relative
word timing for preview and burn-in.

Use the same `project.apply` method for editable titles. `TextLayer` is
exported from `@opencut/sdk` for typed style data.

```ts
project.apply({
  type: 'text.add',
  id: 'title',
  at: 15,
  duration: 75,
  text: { content: 'OpenCut\n中文字幕', fontSize: 64, fontWeight: 700 },
  visual: { y: 200 },
});
project.apply({ type: 'text.set', id: 'title', text: { rotation: -5 } });
await editor.save({ label: 'Add title' });
```

See the [CLI text layer contract](CLI.md#text-layers-t33) for units, defaults,
style options and fallback. A named font missing on this host produces a
`warnings` entry in the SDK render result.

- `project.previewFrame(frame, output, options?)` writes a composited PNG.
- `project.previewContactSheet(frames, output, options?)` writes a labeled PNG
  with 1–16 explicit project-frame samples, in the order provided. The tile
  size defaults to 320 pixels on its longest side. Use `columns` to set the grid.
- `project.render(output, options?)` writes the complete timeline to MP4.
  The default is H.264 with balanced quality at the project canvas and rate.
  Options include quality, resolution, codec, output frame rate, progress
  callback and cancellation signal.

These methods render the staged snapshot with the production compositor and
original media. They require FFmpeg and ffprobe and inherit the
[export limits](EXPORT.md). Supply new output files in existing directories.
The SDK uses exclusive output publication. Use the existing
[`preview clip` CLI command](CLI.md#agent-discovery-and-visual-inspection-t29)
for short range MP4 previews from a saved project. The SDK exposes saved-project
operations and snapshot previews. Desktop playback, selection, untitled projects
and cache controls stay in their existing interfaces.

## Durable background renders

Use `LocalJobs` from `@opencut/sdk` to submit a saved project revision and inspect
the resulting job from another process. Save pending draft edits before
submitting if they belong in the export. The job records the saved revision at
submission, and `status(id)` reports the verified file in `result.path` when the
state is `completed`. See the [durable jobs guide](JOBS.md#typescript-sdk) for a
TypeScript example, idempotency keys, and attempt-based retries.

## Editable subtitles

```ts
import { openProject, parseSubtitleTime } from '@opencut/sdk';

const editor = await openProject('project.opencut.json');
const { project } = editor;
await project.importSubtitles('captions.srt');
const cue = project.inspect().subtitles?.cues[0];
if (cue) {
  project.apply(
    { type: 'subtitle.set', id: cue.id, duration: parseSubtitleTime('2.25') },
    { type: 'subtitle.style', style: { fontSize: 48, color: '#fff4da' } },
  );
}
await editor.save({ label: 'Import and style subtitles' });
await project.exportSubtitles('captions.vtt');
await project.render('captioned.mp4');
await project.render('clean.mp4', { burnSubtitles: false });
```

Import stages a batch of cues in the draft. Export writes the current draft to
a new sidecar, with format inferred from the extension. Use `parseSubtitles`
and `serializeSubtitles` for in-memory conversion. The
[subtitle operations and precision contract](CLI.md#editable-subtitles-t34)
apply to both the SDK and the CLI.

## Creator examples

Run from the repository root after `pnpm build:packages` and
`pnpm --filter @opencut/cli build`. The examples use synthetic media from
`pnpm fixtures:generate`. Use fresh output names on subsequent runs.

```sh
F=tests/fixtures/generated
node examples/scripts/title-card.ts "$F/t30-title.json" "$F/still.png"
node apps/cli/dist/index.js run examples/scripts/rough-cut.ts --project "$F/t30-cut.json" --create "Rough cut" --json -- "$F/video-short.mp4" "$F/video-medium.mp4"
node apps/cli/dist/index.js run examples/scripts/review-and-export.ts --project "$F/t30-cut.json" --expected-revision 1 --json -- 30 "$F/t30-frame.png" "$F/t30-export.mp4"
```

`title-card.ts` demonstrates standalone SDK creation. `rough-cut.ts` assembles
one-second segments on a single track with one undo step. `review-and-export.ts`
reports the composition at a selected frame, writes a PNG and exports the
complete sequence. Add `--dry-run` before the separator to inspect the frame
without producing either output.

## Keyframe animation (T37)

Use the typed `EditOperation` union with `editor.project.apply`. This stages
the same operations as a CLI batch. Save to commit the draft to project history.

```ts
const start = { numerator: 0, denominator: 1 };
const end = { numerator: 1, denominator: 1 };
editor.project.apply(
  {
    type: 'clip.keyframe.add',
    id: clipId,
    property: 'scale',
    time: start,
    value: 0.5,
    easing: 'ease-in-out',
  },
  {
    type: 'clip.keyframe.add',
    id: clipId,
    property: 'scale',
    time: end,
    value: 1,
  },
);
await editor.save({ label: 'Animate scale' });
```

Use `clip.keyframe.set` with `newTime` to move a key and optional `value` or
`easing` to edit it. Use `clip.keyframe.remove` with the channel and exact time
to delete it. `inspect()` returns stored keys, while `inspectTimeline(frame)`
returns sampled transforms. `AnimatedProperty`, `KeyframeEasing`,
`VisualKeyframe` and `VisualKeyframes` are exported types. The
[CLI reference](CLI.md#keyframe-animation-t37) lists the operation fields and
[project format](PROJECT_FORMAT.md#visual-keyframes-t37) defines timing.

## Video transitions (T38)

Use `project.apply` with the shared transition operations. Supply an ID if
another edit will refer to the transition. Otherwise the editor generates
one. `project.inspect().transitions` returns the stored records and
`project.inspectTimeline(frame)` reports `transitionId` on visual samples
inside the window. Audio inspection follows the underlying clips.

```ts
editor.project.apply({
  type: 'transition.add',
  id: 'opening-cut',
  transition: {
    kind: 'cross-dissolve',
    from: 'opening',
    to: 'interview',
    frames: 12,
  },
});
await editor.save({ label: 'Add opening dissolve' });

editor.project.apply({ type: 'transition.set', id: 'opening-cut', frames: 16 });
await editor.save({ label: 'Lengthen opening dissolve' });

editor.project.apply({ type: 'transition.remove', id: 'opening-cut' });
await editor.save({ label: 'Remove opening dissolve' });
```

For a fade use `{ kind: 'fade-in', clipId: 'opening', frames: 8 }` or
`kind: 'fade-out'`. The [project format](PROJECT_FORMAT.md#video-transitions-t38)
describes validation and ownership.

## Group timeline editing

Use the shared [timeline operations](TIMELINE_EDITING.md) with
`project.apply(...operations)`. It returns one result per operation.
The results are detached from the draft, so changing a returned clip has no
effect on a subsequent save. Stage another operation to change the draft.

`project.copyClips(ids)` returns a typed clipboard without staging an edit.
`project.cutClips(ids)` returns the same clipboard format and stages removal.
Use that clipboard with `clips.paste` in the same project. Use `clips.remove`
for linked groups. A single `editor.save()` commits the staged edits together.

## Headless online media

Call `project.searchOnlineMedia({ provider, kind, query, page })`, then pass a
returned result ID to `project.importOnlineMedia(resultId, mediaDirectory)`.
The import downloads a new media file, probes it, stages an asset with license
and source attribution, and returns the asset. Call `editor.save()` to commit
the project edit. An existing result is reused while its local file is
available. Importing an offline result creates a new asset; use
`project.relinkMedia()` to preserve existing clip references. Headless search
results do not include a desktop preview URL.

On an editor opened with `{ dryRun: true }`, import still downloads and probes,
then discards the file without staging an edit. On a normal editor, keep the
downloaded file in place. External downloads are outside project undo and
redo, so a failed or abandoned save can leave a downloaded file. Inspect the
project and history after an uncertain save before retrying.
