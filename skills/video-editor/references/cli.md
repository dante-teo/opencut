# OpenCut CLI

Run `opencut doctor --json` in the environment that will render. Read
`media.hint` if `media.ready` is false. For optional Bandit v2
dialogue separation, follow the [model setup](../../../docs/INSTALL.md#optional-ai),
then use `opencut models inspect --json` to check readiness. If
`separate-dialogue --json` reports `MISSING_DEPENDENCY`, inspect the ELUATE
runtime and checkpoint status. See [dialogue separation](../../../docs/CLI.md#dialogue-separation).

Use `opencut --help` to list the primary workflow. Use `opencut render --help`
for export controls or `opencut preview --help` for review commands. See the
repository's [CLI overview](../../../docs/CLI.md) for command examples.

Use `--quality fast|quality|maximum` for render, batch, and all preview
commands. Preview defaults to `fast`, and final render and batch default
to `quality`. `maximum` uses the same AI algorithms as `quality`.
Timeline inspection also defaults to `quality` and accepts `--quality`.
Use `system inspect --json` to see the profile settings and worker limits.

Use `opencut recipes validate DEFINITION` and `opencut recipes inspect
DEFINITION --json` for recipe checks without transcoding. `opencut render`
automatically processes referenced recipes and reuses completed steps. The
`render --json` result reports `completed` and `cache-hit` recipe steps. Use
`--recipe-cache` to choose a cache and `--recipe-workers` and the other
[recipe flags](../../../docs/CLI.md#media-recipes) to set processing limits.

For revisions, pass the same `--picture-cache <directory>` on the initial
export and each subsequent `render`. OpenCut can reuse lossless picture
ranges after a timeline shift, including ranges with captions that shift
together with picture. Audio is mixed on the revised timeline. Read
`pictureRanges` in JSON for the status of each half-open project-frame range.
See [picture cache options](../../../docs/CLI.md#reuse-picture-between-exports).
Use `--music-candidate <track-id>` and `--music-loudness matched|authored`
with `render` or `preview clip` to select and compare authored music
candidates. Before final delivery, confirm the selected track and any
previous-use notice in the render report.

On macOS, `opencut system inspect --json` reports the VideoToolbox processor
and tested formats and dimensions. Recipe inspection checks declarations
and input streams. Use normal `validate` with the same recipe limits as
`render` to check whether the referenced AI recipe can actually build.
For enhancement, check `low-latency-super-resolution`,
`video-super-resolution`, or `temporal-noise-filter` in the system report.
Check a short preview of the actual input to confirm whether the requested
processor can start. See the [installation checks](../../../docs/CLI.md#check-the-installation).

Render a variant with `opencut render DEFINITION --params params.json -o final.mp4`.
Use the same parameter file with one-shot validation, inspection, preview
commands including `preview contact-sheet`, and subtitle export. Pass an array of `{ id, params, output? }` entries to
`opencut batch DEFINITION --variants variants.json --output-dir outputs --json`.
Read `variants` on stdout for the final status of each selected ID. Filter
stderr for objects with `event: "batch-progress"`.
The default filename is `<id>.mp4`. Use `--only id,id` for selective retries,
`--concurrency` for active job slots, and `--fail-fast` to cancel outstanding
work after a failure. See the [batch file contract and budgets](../../../docs/CLI.md#batch-rendering).

Use `opencut build inspect DEFINITION --json` with the original
`--recipe-cache`, `--params`, `--quality` and `--no-subtitles` selection to see recorded
processing and render states. Retry with the same cache to reuse stages
marked `reusable`. An interrupted MP4 encode starts over. When a verified
MP4 exists, `lastAttempt` reports a newer retry separately from the output.
When JSON stderr reports `error.code: "SOURCE_CHANGED"`, inspect
`error.sourceChange`. Use `--retry-source-change` on `validate`, `render`
or `preview contact-sheet` for one retry after OpenCut verifies that the
bytes stayed the same and the file is stable. For changed or unknown bytes,
let any writes finish and restore any missing input before rerunning.
If `error.sourceChange.completedPictureRanges` lists cached ranges, recheck
their reuse with `render plan`. See [source change recovery](../../../docs/CLI.md#source-changes-during-a-command).

`opencut package DEFINITION --output BUNDLE` creates a portable directory.
Use `--root DIR` if the inputs share a wider root, `--resource PATH` per
extra authoring file relative to that root, and `--params FILE` to select
a variant. Only share
files you have permission to redistribute. Run `opencut package verify BUNDLE`
after moving it, then render `BUNDLE/opencut.bundle.video.ts`. Keep that
filename at the bundle root. Verification rejects symlinks at the entry and
in packaged dependency paths. The new host needs a compatible OpenCut,
FFmpeg, and any required native models.

For mix-enabled definitions, run `opencut mix analyze <definition.video.ts> --json`
to inspect loudness and get editable automation. To reuse the curves, copy the
report’s `automation` into `professionalMix.automation` in the definition or
`mix.automation` in a settings file passed to `--mix-settings <mix.json>`. Use
`--mix-comparison before` for a loudness-matched comparison and
`--mix-cache <directory>` to reuse AI-enhanced stems across runs. See [Professional Dialogue Mix](../../../docs/AUDIO_MIX.md).

For frame QA, run `opencut preview contact-sheet DEFINITION --frames 59,60
--output sheet.png` or use a finished MP4 as the input. Add
`--around cuts,captions,picture` with `--render-report report.json` for
boundary sampling. With an MP4, use the fingerprinted `render --json`
report for that export. OpenCut writes a JSON manifest beside the PNG.
See [frame-targeted contact sheets](../../../docs/CLI.md#frame-targeted-contact-sheets).
For processed footage, use the same timeline grid and output size in both
comparisons. Get source and delivered rates with `probe`, the processed
rate with `inspect`, and the sampled time with `timeline inspect` or the
contact-sheet manifest. Use `probe EXPORT --expect-fps 60 --json` for a
60 fps delivery. See [interpolation and upscale verification](../../../docs/CLI.md#verify-interpolation-and-upscale).

For cleanup planning run `opencut inspect dependencies DEFINITION --json`.
Supply `--artifact-root` for additional directories and
`--render-report` for a published export. Use `classification`, `byteTotals`
and the recorded owners to distinguish regenerable artifacts, deliveries and
unclassified files. An `unverified-export` reference could point to a
missing or replaced output.

Run `opencut render plan DEFINITION --output final.mp4 --json` with the
intended cache and render options to check recipe and picture range reuse
and current free space before rendering. The plan checks overwrite safety
and required encoders. Scratch usage is estimated.
After export, use `opencut verify export final.mp4 --against approved.mp4
--render-report final.render.json --output verification` to save paired
samples, full frame-clock results and luma checks. Use `--timestamps` to
compare the preview and export at the same presentation times, including
when their frame rates differ. Set `--expect-fps` for the delivery rate.
Add `--audio-master master.mp4` when delivery requires exact audio packet
content and timing. See the
[CLI verification reference](../../../docs/CLI.md#post-export-verification).

## Scripted audio revisions

Keep the MP4 and the JSON report from a render with revision evidence.
After an audio edit, check preflight before reusing the encoded picture.

```sh
opencut render edit.video.ts -o review.mp4 --revision-evidence --json > review.render.json
opencut remix edit.video.ts --picture-from review.mp4 --render-report review.render.json \
  -o revised.mp4 --preflight --json
```

If preflight reports `status: "reuse"`, run the same remix command without
`--preflight` and save its JSON report for the next revision. Read the
reported frame ranges and reasons if the decision is blocked. See
[replacing audio using an existing export](../../../docs/CLI.md#replace-audio-using-an-existing-export).

### Use a saved picture version

For the picture-cache workflow, save the encoded picture while delivering
the review export. Retain the absolute cache path and `pictureVersion.id`
from the render JSON.

```sh
cache="$PWD/render-cache"
opencut render edit.video.ts -o review.mp4 --picture-cache "$cache" \
  --picture-version save --json > review.render.json
```

After the audio edit, keep the same video settings. Use the render plan
to confirm `savedPicture.status: "reuse"` before rendering.

```sh
id=$(jq -er '.pictureVersion.id' review.render.json)
opencut render plan edit.video.ts -o revised.mp4 --picture-cache "$cache" \
  --picture-version "$id" --json > revised.plan.json &&
opencut render edit.video.ts -o revised.mp4 --picture-cache "$cache" \
  --picture-version "$id" --json > revised.render.json
```

If the cache entry is missing or invalid, restore the original cache or
render with `--picture-version save` and retain the new ID. Save a new
version when burned-in captions change or an audio edit affects graphics.
With a Professional Dialogue Mix driving graphics, changes to
`--audio-channels`, `--audio-rate`, or `--audio-bitrate` also affect
picture reuse. Use the new plan's `pictureRanges` to see which lossless
ranges can be reused. Read progress events on stderr, including
`audio-analysis`, `audio-mastering` and `muxing`, and the final report
on stdout. See [packet verification](../../../docs/CLI.md#audio-only-revisions).

## Vertical 4K60 delivery

Use the [9:16 TypeScript example](../../../examples/video/vertical-4k60.video.ts)
to deliver 2160 × 3840 at 60 fps with optional step cards and a synced
external soundtrack. Set the frame rate in the definition for local picture
revisions and retain the approved MP4 and render report.
[Export command and parameters](../../../docs/CLI.md#vertical-4k60-delivery)

## 3:4 4K60 delivery

Set the definition's 3:4 canvas to 60 fps and render with
`--width 2880 --height 3840 --fps 60 --codec hevc`. Output scaling applies to
the composed picture. Use `--encoder auto` to try hardware with a reported
software fallback or `--encoder videotoolbox` to require hardware. For
`render --json`, read the final result on stdout and progress lines on
stderr. See [encoder selection](../../../docs/CLI.md#encoder-selection-and-render-progress).
Use per-source recipes for AI interpolation or
super-resolution when requested.

## Conversion and graphics discovery

Use `opencut convert name.video.json` to write a `.video.ts` file beside the
resolved JSON source. See [legacy conversion](../../../docs/CLI.md#convert-a-legacy-definition)
for the output name and `--json` result.
`opencut doctor --json` reports graphics capabilities and prerequisites.
Use `opencut timeline inspect DEFINITION --frame N --metadata-only --json`
for authored timing and crop without a writable cache.
`opencut timeline inspect DEFINITION --frame N --json` reports requested
graphic samples and dependency identity. Use `--params` in watch, preview,
render or package to apply a declared variant. See the
[CLI reference](../../../docs/CLI.md#motion-definition-diagnostics).
