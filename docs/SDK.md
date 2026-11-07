# OpenCut TypeScript SDK

`@opencut/sdk` is a Node ESM workspace package with a public root export and
TypeScript declarations. Add `"@opencut/sdk": "workspace:*"` to a workspace
consumer's dependencies and run `pnpm install` and `pnpm build:packages` from
the checkout root. The repository's examples already have that dependency.
The package is distributed in this workspace. Use the package root for all
SDK imports. External agents can use the portable
[Skill reference](../skills/video-editor/references/sdk.md) with a
[staged runtime](README.md#external-agent-validation).

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
clip add/move/trim/split/remove, clip audio/visual settings and canvas settings.
See the [batch command reference](CLI.md#transactions-undo-and-redo) for
operation fields and validation. Pass explicit IDs to refer to a new track or
clip later in the same group. Inspect the draft for generated IDs.

| API                                                                                 | Behavior                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openProject(path, options?)`                                                       | Reads the authoritative named project snapshot, including an open desktop session. Accepts an optional expected revision.                                            |
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
existing T22 writer and session transport for publication. A successful save
to an open project updates Electron and shares its undo/redo history.
An editor's signal cancels a local save before publication or an Electron save
before submission. A session disconnect during commit can leave the outcome
unknown. Read back project content and history before retrying. See the
[project session decision](adr/0011-shared-project-session.md) for live session limits.

## Preview and render

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
