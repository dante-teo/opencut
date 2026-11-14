# OpenCut CLI

Use the supplied executable for structured output. If OpenCut was built from a
checkout, call `node /absolute/path/to/apps/cli/dist/index.js` directly.
Relative command paths resolve from the working directory. Keep source and output
paths separate and quote paths with spaces.

Use `media separate-dialogue PROJECT ASSET --output NEW_FOLDER --json` to
produce dialogue and background WAVs. The environment needs FFmpeg, ffprobe,
and a Python installation with ELUATE and its multilingual Bandit v2 model.
Set `OPENCUT_DIALOGUE_PYTHON` to select that interpreter. Listen to both stems
against the original mix before using them. Use `media relink` for an offline
asset, `media import-font` for title or cue fonts, `project freeze` for a held
frame and `project snapshot|package` for project copies. Check scoped help for
arguments and `help edit apply --json` for new batch operations.

## Discover and inspect

Use `project cache-preview PROJECT --size 960 --json` to render or reuse an
MP4 with mixed audio and VFR footage sampled on the project frame grid. Use
`project render` for a foreground export or `jobs submit` for a background
export. Use
`desktop control PROJECT REQUEST.json --json` for an open, saved project on
macOS or Linux. Discover the request
schema with `opencut help desktop control --json`. A `render-preview` reply
acknowledges the request. Poll `status` or use `project cache-preview` when
the workflow needs the completed file. Check the returned viewer revision
before reviewing a recent commit. If the control socket is unavailable,
headless preview and editing commands still work.

`subtitle.words` in an edit batch assigns exact cue-relative times to UTF-16
text ranges for animated word highlighting. SRT and WebVTT carry cue-level
timing and text. Verify word animation in a rendered preview or burn-in.

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
edits in the committed project file. Project and timeline inspection
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

For online sources, write a request JSON with `provider` (`commons` or
`openverse`), `kind`, `query` and optional `page`. Search and use a returned
stable result ID to import:

```sh
opencut online search REQUEST.json --json
opencut online import PROJECT REQUEST.json --result ID --directory MEDIA_DIRECTORY --expected-revision REV --json
```

Import searches again and downloads to a new external file. `--dry-run` probes
the download and discards it. A result with an available local file is reused;
importing an offline result creates a new asset. Use `media relink` to keep
existing clips connected to an offline asset.
After a disconnected commit reply, inspect the project and history before
retrying.

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

| Operation                  | Fields besides `type`                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `track.add`                | `name`, `mediaType` (`video` or `audio`), optional `id`                                                                                                                 |
| `track.audio`              | `id` and at least one of `volume` (linear 0–1), `muted` (boolean)                                                                                                       |
| `track.remove`             | `id` of an empty track                                                                                                                                                  |
| `clip.add`                 | `assetId`, `trackId`, `at`, `in`, `out`; optional `id`, `volume`, `muted`, `fadeIn`, `fadeOut`, `visual`                                                                |
| clips.move                 | ids, nonnegative frames, optional backwards and tracks (track ID map)                                                                                                   |
| clips.remove               | ids, optional ripple: selected-tracks or all-unlocked                                                                                                                   |
| clips.copy / clips.cut     | ids; results contains the same-project clipboard                                                                                                                        |
| clips.paste                | clipboard, at, optional insert scope and tracks                                                                                                                         |
| clips.duplicate            | ids and optional at (defaults to end of selection)                                                                                                                      |
| clips.link                 | ids and linked                                                                                                                                                          |
| clip.insert                | clip.add fields plus scope: selected-tracks or all-unlocked                                                                                                             |
| timeline.close-gap         | trackIds and at, inside a shared gap                                                                                                                                    |
| track.lock                 | id and locked                                                                                                                                                           |
| marker.add / marker.remove | at and name, or id for removal                                                                                                                                          |
| `clip.move`                | `id` and `at`, `trackId`, or both                                                                                                                                       |
| `clip.trim`                | `id` and at least one of `in`, `out`, `inTime`, `outTime`                                                                                                               |
| `clip.split`               | `id`, `at`, optional `rightId`                                                                                                                                          |
| `clip.remove`              | `id` of a clip outside a linked group                                                                                                                                   |
| `clip.speed`               | `id` and `speed` with integer `numerator` and `denominator`, from 1/4 to 4                                                                                              |
| `clip.audio`               | `id` and at least one of `volume`, `muted`, `fadeIn`, `fadeOut`                                                                                                         |
| `clip.visual`              | `id` and at least one of `x`, `y` (pixel offsets from center), `scale` (0.01–4), `rotation` (clockwise degrees), `opacity` (0–1), `fit` (`contain`, `cover`, `stretch`) |
| `text.add`                 | `at`, positive `duration`, `text` with `content`; optional `id`, video `trackId`, `visual` (x/y/scale/rotation/opacity)                                                 |
| `text.set`                 | `id` and at least one of `text` patch, `at`, `duration`                                                                                                                 |
| `canvas.set`               | At least one of `width`, `height`, `backgroundColor`                                                                                                                    |

Use `clip speed PROJECT CLIP_ID --speed 1.5 --json` to retime an existing
video or audio clip. Speed changes preserve source points, clip start, timeline
fade lengths and subtitle cue positions. A slower clip can collide with its
neighbor on the same track and the edit will fail. A faster clip can leave a gap.
For off-grid source trims, pass `inTime` or `outTime` as rational seconds in a
batch, or use `clip trim --in-time` and `--out-time` in the CLI. Use only one
format per edge. Exact trims render at default speed too. After retiming,
inspect both sides of a cut and review motion and sound in an exported preview.
Contiguous same-source, same-speed pieces on one track share a tempo pass.
Their individual fades, gain and mute still apply.

For `clip.add`, nest visual fields in `visual`. Set fade durations in project
frames with `fadeIn` and `fadeOut` in a batch, or `--fade-in` and `--fade-out`
on `clip add` and `clip audio`. Zero clears a fade. The sum of both durations
must fit the clip. Clip and track gains multiply, and either mute silences the
clip. Use `timeline inspect` to read effective gain and a decoded preview clip
or export to check the resulting audio. Every intermediate operation
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

For a title, add an operation such as
`{"type":"text.add","id":"title","at":30,"duration":90,"text":{"content":"OpenCut\n中文字幕","fontSize":64},"visual":{"y":200}}`.
Without `trackId` the operation creates a top video track. Its end is exclusive.
Set `fontFamily`, `fontSize`, `fontWeight` (100–900 by 100), `color`,
`alignment` (left/center/right), optional `wrapWidth` and clockwise `rotation`
in degrees on `text`. Effects are `stroke: {color,width}`,
`shadow: {color,x,y,blur}` and `background: {color,padding}`. Use `null`
in a patch to clear an effect or wrap width. Sizes and offsets use project
pixels. Colors accept `#RRGGBB`, `#RRGGBBAA` or `transparent`. Set
position, scale, clip rotation and opacity with `clip.visual`. Use the bundled default
Noto Sans SC for portable English and Chinese layout. Missing font families
use this fallback. Check the final `completed` event's optional `warnings`
array for substitutions and report any that affect the requested typography.

## Editable subtitles

Use `subtitle import PROJECT FILE.srt --expected-revision N --json` or
pass a WebVTT file. Import appends cues in one undo step. List IDs, timings
and shared style with `subtitle list PROJECT --json`. Use `edit apply` with
`subtitle.add`, `subtitle.set`, `subtitle.move`, `subtitle.split`,
`subtitle.merge`, `subtitle.remove` or `subtitle.style`. Discover their
fields in the `edit apply input` schema. Times are rational seconds with
exclusive ends. The shared style includes font, size, color, outline,
position and background. Check active cues using `timeline inspect` at
frames before, inside and after each interval, including overlaps. Subtitle
layers report a static source time of zero.

`subtitle export PROJECT --output NEW.vtt --json` writes a UTF-8 sidecar
with text and millisecond timing. A `.srt` destination selects SubRip.
`project render` burns subtitles in by default. Use `--no-subtitles` for
clean video. Check the resulting sidecar by reading it back and verify
burn-in by decoding frames. Burn-in supports 256 sampled cues per range.

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
checks media decoding, title clip alignment and export constraints. Use even
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

## Keyframe operations

In an `edit apply` batch, use `clip.keyframe.add` with `id`, `property`,
`time`, `value` and optional `easing`. Use `clip.keyframe.set` with `id`,
`property`, `time` and optional `newTime`, `value` or `easing`.
`clip.keyframe.remove` takes `id`, `property` and `time`.

Properties are `x`, `y`, `scale`, `rotation` and `opacity`. Use exact
`{ numerator, denominator }` seconds relative to the clip start. Zero and the
clip duration are valid key times. The outgoing easing is `linear`,
`ease-in`, `ease-out`, or `ease-in-out`. A channel holds its nearest key
outside its key span and uses the static value once all its keys are deleted.
Trims discard cut keys, splits preserve the curve over both pieces, and a speed
change rescales the local times. Use `timeline inspect` for sampled values and
decode the rendered output to confirm placement and opacity.

## Video transitions

```bash
opencut transition add project.json incoming --kind cross-dissolve --from-clip outgoing --frames 12 --json
opencut transition add project.json opening --kind fade-in --frames 6 --json
opencut transition add project.json ending --kind fade-out --frames 6 --json
opencut transition set project.json TRANSITION_ID --frames 16 --json
opencut transition remove project.json TRANSITION_ID --json
```

Use `timeline list --json` to find stored transition IDs. The dissolve spans
the cut using trimmed source handles. Use at least two project frames and
leave enough source on both sides at the clips' playback speeds.

## System diagnostics

Use `opencut system inspect --json` to check host hardware, memory and local
VideoToolbox capabilities without a project. Treat reported processor
configurations and model status as diagnostics; the CLI has no AI editing
commands, and a configuration reported as supported may still fail at runtime.

## Durable render jobs

`jobs submit PROJECT --expected-revision N --idempotency-key KEY --json` captures
the saved revision and lets the CLI exit. Use `jobs list --json` to recover a job
ID, then `jobs status JOB_ID --json` for progress, attempt logs, errors and the
verified output path. `jobs cancel JOB_ID` requests cancellation and
`jobs retry JOB_ID --attempt N` retries the captured inputs. Check `error.retryable`
before retrying a failed or interrupted attempt. After a worker crash or reboot,
`jobs start` wakes the queue. For `PUBLICATION_UNCERTAIN` or `RECOVERY_BLOCKED`,
resolve the reported filesystem issue before retrying with the same attempt
number. Check the returned state because recovery may publish the original
verified result without starting a new render. A project edit after submission
leaves the captured revision and render content intact.
