# OpenCut CLI

Use the supplied executable for structured output. If OpenCut was built from a
checkout, call `node /absolute/path/to/apps/cli/dist/index.js` directly.
Relative command paths resolve from the working directory. Keep source and output
paths separate and quote paths with spaces.

## Discover and inspect

```sh
opencut help --json
opencut help edit apply --json
opencut help preview --json
opencut project inspect "$PROJECT" --json
opencut media list "$PROJECT" --json
opencut timeline inspect "$PROJECT" --frame 30 --json
```

Use `opencut help edit apply` for readable usage alone. When processing JSON,
read the scoped `commands` entry and look up only the schema you need.
Use discovery's `commands`, `options`, `prerequisites`, `limits`, and
`jsonOutput` for the installed version. A command's `resultSchema`, when
present, points into `schemas`. Supported capabilities can still fail when a
local tool or file is unavailable. Inspection reads saved content, including
edits in an active named desktop session. Project and timeline inspection
work without decoding. `timeline inspect` shows active clips, visual layers
from bottom to top, exact source times and audio mix candidates. A candidate
does not prove a stream decoded or was audible.

## Edit safely

`project create` takes an explicit new project path, name, and optional canvas
and rate. Pick the aspect ratio and project rate before arranging media.
`media import PROJECT FILE --json` links an existing source and returns
`asset.id`. Import each source separately, optionally with
`--expected-revision` and `--dry-run`. Re-importing the same file reuses the
asset ID. Read `project inspect` again after imports.

Use integer frame indices measured at the project FPS. At 30 fps, frame 45 is
1.5 seconds. A source range `in: 15, out: 45` covers one second from 0.5 s up
to 1.5 s. Inspection returns rational seconds as `{numerator, denominator}`.
With fractional FPS, keep the exact rate and calculate with the ratio.
`at` is an absolute timeline frame for placement, moves and splits. Trimming
keeps the timeline start fixed. Split strictly inside the clip. Edits leave
neighboring clips where they are. Clips may touch on a track. Overlaps need
separate tracks, with later visual tracks drawn above earlier ones.

For a group of timeline edits, write a batch JSON with `expectedRevision` from
the latest inspection, a nonempty `operations` array, and an optional `label`.
Supply explicit new IDs to refer to a track or clip later in the batch.

| Operation      | Fields besides `type`                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `track.add`    | `name`, `mediaType` (`video` or `audio`), optional `id`                                                                                 |
| `track.remove` | `id` of an empty track                                                                                                                  |
| `clip.add`     | `assetId`, `trackId`, `at`, `in`, `out`; optional `id`, `volume`, `muted`, `visual`                                                     |
| `clip.move`    | `id` and `at`, `trackId`, or both                                                                                                       |
| `clip.trim`    | `id` and `in`, `out`, or both                                                                                                           |
| `clip.split`   | `id`, `at`, optional `rightId`                                                                                                          |
| `clip.remove`  | `id`                                                                                                                                    |
| `clip.audio`   | `id` and at least one of `volume` (linear 0–1), `muted` (boolean)                                                                       |
| `clip.visual`  | `id` and at least one of `x`, `y` (pixel offsets from center), `scale` (0.01–4), `opacity` (0–1), `fit` (`contain`, `cover`, `stretch`) |
| `canvas.set`   | At least one of `width`, `height`, `backgroundColor`                                                                                    |

For `clip.add`, nest visual fields in `visual`. Every intermediate operation
must be valid. A dry run validates the whole batch without saving. Its revision
and generated IDs are provisional. Use the same batch for the commit. Check
`changed` and re-inspect. Use `edit history` to identify the next undo/redo entry
at the end of the corresponding stack. Use `edit undo` or `edit redo` with a
fresh `--expected-revision` only when that entry matches the intended recovery.
Revision numbers increase even on undo.

```sh
opencut edit apply "$PROJECT" "$BATCH" --dry-run --json
opencut edit apply "$PROJECT" "$BATCH" --json
opencut project inspect "$PROJECT" --json
```

## Visual review and export

```sh
opencut preview frame "$PROJECT" --frame 30 --output review.png --json
opencut preview contact-sheet "$PROJECT" --from 0 --to 60 --count 4 --columns 2 --output sheet.png --json
opencut preview clip "$PROJECT" --from 0 --to 60 --size 320 --output review.mp4 --json
opencut project validate "$PROJECT" --json
opencut project render "$PROJECT" --output final.mp4 --json
opencut probe final.mp4 --json
ffmpeg -v error -xerror -nostdin -i final.mp4 -map 0:v:0 -map '0:a:0?' -f null -
```

These examples assume the timeline reaches at least frame 60. Preview ends are
exclusive. Sheets sample uniformly, so also extract explicit frames immediately
before and after a cut or layer change. Open the PNGs with the agent's image
viewer. Review crop, placement, visibility and the intended shot. Listen to
the preview or export if audio playback is available. `extract-frame` reads a
source file in seconds and is useful for checking source or exported media.
`preview frame` composites the project in project frames.

`project validate` checks project data and source readability. Rendering also
checks media decoding, timeline alignment and export constraints. Use even
canvas dimensions for MP4. Previews and exports use original media. Preview
outputs and SDK renders require fresh paths. Keep the CLI render default of
refusing replacement. Parse render stdout line by line and require a final
`completed` event and exit 0 before probing the destination. Encoding progress
can reach 100 percent before verification and publication.

## Troubleshoot and recover

| Symptom                                             | Recovery                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exit 2 or invalid arguments                         | Read scoped help. Check required flags, frame units, and whether negative visual offsets need `--x=-40` syntax.                                                                             |
| Revision conflict or busy writer                    | Re-inspect the authoritative project and history. Reconcile newer edits before recomputing the batch. Check the outcome before retrying after a disconnect.                                 |
| Missing source or missing media tools               | Use `media list` to find the resolved path. Restore the intended source at that path and validate again. Check that FFmpeg and ffprobe are on PATH and the required encoders are available. |
| Invalid range, split, overlap or incompatible track | Check the exact source duration, neighboring clip endpoints and track type. Adjust the plan and dry-run again.                                                                              |
| Export or preview destination already exists        | Use a fresh filename. Keep the earlier artifact until the new one is verified.                                                                                                              |
| Empty picture, wrong layer or silent audio          | Inspect the affected frame for gaps, track order, source time, opacity, mute and volume. Check the decoded preview.                                                                         |
| Cancelled render                                    | Use SIGINT or SIGTERM and wait for the process to exit. Recheck the output path before retrying.                                                                                            |

Most `--json` successes are one stdout document. `project render` and
`cache proxy` stream JSONL. On errors, read the exit code and structured
`error.code`, `error.message` and optional `error.hint` on stderr. Preview
progress or script logs may precede the final diagnostic. Failed renders can
also emit a terminal stdout event, and failed validation can return a report
on stdout. Keep source media and existing project history intact during recovery.
