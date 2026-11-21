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
To reuse encoded picture for audio revisions, save the approved export with
`--picture-version save`. Keep its ID and export the audio revision with the
same cache and video settings and `--picture-version <id>`. Save a new
version when an edit changes audio used by graphics. For graphics analyzing
a Professional Dialogue Mix, changes to `--audio-channels`,
`--audio-rate`, or `--audio-bitrate` also require a new picture version.
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

## 3:4 4K60 delivery

Set the definition's 3:4 canvas to 60 fps and render with
`--width 2880 --height 3840 --fps 60 --codec hevc`. Output scaling applies to
the composed picture. Use per-source recipes for AI interpolation or
super-resolution when requested.

## Data authoring and graphics discovery

Use `.video.json` wherever a video command accepts `.video.ts`.
`opencut doctor --json` reports graphics capabilities and prerequisites.
`opencut timeline inspect DEFINITION --frame N --json` reports requested
graphic samples and dependency identity. Use `--params` in watch, preview,
render or package to apply a declared variant. See the
[CLI reference](../../../docs/CLI.md#json-and-motion-definitions).
