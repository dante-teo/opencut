# CLI reference

Build from the checkout root with `pnpm build`. The `opencut` executable is
workspace-local. Use the direct Node form for machine-readable stdout; pnpm
scripts can add lifecycle logs.

For a CLI-only build, run `pnpm build:packages` followed by
`pnpm --filter @opencut/cli build`. This builds the headless packages and CLI
without building or launching the desktop app.

```sh
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js --version
node apps/cli/dist/index.js project create /path/to/new.opencut.json --name "My project" --width 1920 --height 1080 --fps 30000/1001 --json
node apps/cli/dist/index.js project info /path/to/new.opencut.json --json
node apps/cli/dist/index.js project validate /path/to/new.opencut.json --json
node apps/cli/dist/index.js probe tests/fixtures/generated/video-medium.mp4 --json
node apps/cli/dist/index.js extract-frame tests/fixtures/generated/video-medium.mp4 --timestamp 0.5 --output tests/fixtures/generated/frame.png --json
node apps/cli/dist/index.js compose tests/fixtures/generated/video-short.mp4 tests/fixtures/generated/video-medium.mp4 --music tests/fixtures/generated/audio-tone.wav --output tests/fixtures/generated/composition.mp4 --width 640 --height 360 --json
```

The media examples require the synthetic fixtures. Generate them explicitly
with `pnpm fixtures:generate` if absent; see the
[fixture contract](../tests/fixtures/README.md). The output parent directory must
already exist, and the output file must not exist.

## TypeScript scripts and SDK (T30)

```sh
node apps/cli/dist/index.js run script.ts --project project.opencut.json --json
node apps/cli/dist/index.js run script.mts --project new.opencut.json --create "My project" --json -- input.mp4
node apps/cli/dist/index.js help run --json
```

Default-export a synchronous or asynchronous `OpenCutScript` function from an
ESM `.ts` or `.mts` file. It receives `{ project, args, dryRun, signal }`.
Use `--` to pass arguments to the script. Relative paths resolve from the
invocation's working directory. The runner uses the pinned Node 24 runtime's
native type stripping. Use erasable types and explicit ESM import extensions.
Use `.mts` outside a `"type": "module"` package. The runner executes TypeScript
without type checking. See the [SDK reference](SDK.md) for types, usage and
tested creator examples.

`--project` identifies a saved project, including one currently open in
Electron. With `--create <name>`, it identifies a new destination in an existing
writable directory and starts with a 1920×1080, 30 fps canvas. The runner opens
or prepares the project before importing the script. `--expected-revision <n>`
checks the current revision before execution and applies only to existing
projects. Every save also checks the exact snapshot the script opened.

The runner publishes staged project edits as one undo step after the function
resolves and its return value serializes. An uncaught script error, invalid
result or revision conflict prevents project publication. `--dry-run` validates
the same staged edit and reports the proposed revision without saving. SDK
preview and render outputs are disabled for a runner dry run. Successful
previews and renders during normal runs publish their own files independently.

Stdout contains one JSON success document with `scriptVersion: 1`, `ok: true`,
canonical `path`, `projectId`, `baseRevision`, `revision`, `changed`, `created`,
`dryRun` and `result`. `created` and `revision` describe the proposed outcome
on a dry run. An omitted return value becomes `null`. Return JSON data and use
the global `console` for logs, which the runner sends to stderr. Direct stdout
writes from scripts or their subprocesses can interfere with JSON output.
With `--json`, the final stderr line on error follows the CLI error schema.
Exit status is 0 for success, 2 for invalid arguments and 1 for runtime, data,
file or session errors. Handled SIGINT and SIGTERM during script execution return
130 and 143. Await all work and pass `signal` to cancellable custom operations.
A save can finish if cancellation arrives after local publication starts or
after the request has been sent to an active Electron session.

Run only trusted local code. Scripts run with the invoking account's permissions
and can access Node APIs and start processes. The transaction covers edits made
through the bound `project` draft. Direct filesystem writes and separate SDK
sessions have their own effects. OpenCut never executes script references from
a project file.

## Agent discovery and visual inspection (T29)

Use the built executable directly so package-manager logs cannot enter JSON stdout:

```sh
node apps/cli/dist/index.js help --json
node apps/cli/dist/index.js help preview --json
node apps/cli/dist/index.js project inspect /path/to/project.opencut.json --json
node apps/cli/dist/index.js timeline inspect /path/to/project.opencut.json --frame 20 --json
node apps/cli/dist/index.js preview frame /path/to/project.opencut.json --frame 20 --output /path/to/new-frame.png --json
node apps/cli/dist/index.js preview contact-sheet /path/to/project.opencut.json --from 0 --to 66 --count 4 --columns 2 --size 160 --output /path/to/new-sheet.png --json
node apps/cli/dist/index.js preview clip /path/to/project.opencut.json --from 12 --to 42 --size 160 --quality high --output /path/to/new-preview.mp4 --json
```

These forms are exercised by `tests/integration/inspection.native.spec.ts` on a
30 fps synthetic project with a leading canvas gap, trimmed/split video,
a translucent transformed image layer and two mixed audio sources. At frame 20,
the base source maps to 17/30 seconds. The sheet samples frames 0, 21, 43 and 65;
the clip contains 30 frames (one second), with both streams starting at zero.
Choose ranges from your own project's inspected duration and frame rate.
The native test also verifies a 30000/1001 project and cancellation cleanup.
Run `pnpm test:media` with manually installed FFmpeg/ffprobe, or run just this
native file after a CLI build using
`node --import tsx --test tests/integration/inspection.native.spec.ts`.
`OPENCUT_T29_KEEP=1` retains that test's synthetic preview artifacts for inspection.

`help --json` and `--help --json` return `discoveryVersion: 1`, application
identity, every command's positional arguments and options, required flags,
defaults, units, constraints, prerequisites, capability statuses and exit codes.
`help GROUP [ACTION] --json` scopes the command list. The `help` field
contains the corresponding readable command or group usage. `globalOptions` includes version/help aliases.
`jsonOutput` distinguishes existing JSONL commands (`project render`, `cache proxy`)
from single-document results. A `resultSchema` key points into `schemas`, which
contains JSON Schema 2020-12 definitions for the five T29 results, script
results and errors.
Implemented capability status does not imply tools or media are available on this
machine; execution checks prerequisites. Discovery lists `run` and the workspace
SDK. MCP is unavailable.

Inspection and preview commands accept `--json` and `--help`/`-h` before the
command group, between the group and action, or after the action. For example:

```sh
node apps/cli/dist/index.js project --json inspect /path/to/project.opencut.json
node apps/cli/dist/index.js timeline --json inspect /path/to/project.opencut.json --frame 20
node apps/cli/dist/index.js preview --json -h frame
```

These forms return the same JSON results or scoped help as placing the flags at
the end. `tests/integration/inspection-cli.test.ts` covers option ordering,
scoped help and rejection of inspection-only options on unrelated commands.
The six inspection options `--frame`, `--from`, `--to`, `--size`, `--count` and
`--columns` apply only to their supported inspection/preview commands;
`--version` remains a standalone command (optionally with `--json`).

`project inspect` returns `inspectionVersion: 1`, canonical absolute `path`,
project `schemaVersion`, metadata, settings, asset references/metadata, ordered
tracks, clips, exact rational duration and current `revision`. It omits undo/redo
snapshots. It uses the same authoritative project read as other CLI queries,
including an open GUI session. No media tools or online sources are required;
use `media list` for source availability and resolved paths.

`timeline inspect --frame N` returns `inspectionVersion: 1`, canonical `path`,
`projectId`, `revision`, `frame`, `frameRate`, and the shared evaluator's `time`,
`duration`, `boundary`, `activeClips`, `visualClips`, `audioClips`, `mixingSources`,
`gap`, `visualGap` and `backgroundColor`. Times are exact rational seconds;
visual clips are ordered bottom to top and include normalized transform values.
Each active clip includes `sourceTime`, effective gain, mute and audio-presence
intent. Muted sources remain in `audioClips`; unknown audio metadata remains a
candidate. Inspection does not decode media or determine actual occlusion/alpha.
Half-open clip boundaries match playback/export. `boundary` is `inside`, `end`
or `after`; inspecting the end or later is supported and returns no active clips.

All new time flags (`--frame`, `--from`, `--to`) accept nonnegative safe integer
**project-frame indices**, never decimal seconds or source-file frame numbers.
`--to` is exclusive. A preview frame must be strictly before the timeline end.
Ranges must satisfy `0 <= from < to <= timeline frame count`.

- `preview frame` requires `--frame` and a new `.png` output. Default size is the
  project canvas; optional `--size 64..1920` caps its longest side.
- `preview contact-sheet` requires a new `.png` output. `--from` defaults to 0,
  `--to` to the timeline end, `--count` to min(8, range frames), `--columns` to
  min(4, count), and `--size` to 320. Count is 1–16 and cannot exceed the range
  length; columns are 1–count; size is 64–640. Uniform integer samples include
  the first and last included frame (a single sample uses the first). Every tile
  is labeled with its exact frame index and approximate seconds. JSON `samples`
  includes exact rational times and tile x/y coordinates; `tileWidth`,
  `tileHeight`, `cellWidth`, `labelHeight`, `columns` and `rows` describe the grid.
  Cell width is at least 96 pixels to keep labels readable for narrow canvases;
  image pixels start at each sample x/y and occupy tileWidth by tileHeight.
- `preview clip` requires `--from`, `--to` and a new `.mp4` output. Ranges are
  limited to 30 seconds. Default longest side is 640 and quality is `draft`;
  `--size 64..1920` and `--quality draft|balanced|high` configure output. It retains
  the project frame rate, full composition and synchronized mixed audio.

Size scales the finished canvas without upscaling and rounds sides down to even
pixels (minimum 2). All previews return `inspectionVersion: 1`, absolute `path`
and `projectPath`, `projectId`, `revision`, rational `frameRate`, width and height.
Frame results add `kind: "frame"`, `frame` and exact `time`. Clip results add
`kind: "clip"`, start/end frame and rational times, frame count, measured duration
and quality. Sheets add `kind: "contact-sheet"` and the range/grid/sample fields.
The `schemas` map in discovery is the precise field contract. T29 results use the
same JSON field names with or without `--json`.

Visual inspection runs headlessly, without Electron, using the production export
compositor and original sources. It preserves shared evaluation, RGB color,
source-over layers, geometry and sampling rules; it never previews just one
selected asset. PNGs avoid H.264 compression and chroma loss, but flatten canvas
transparency over black like MP4. Contact-sheet layout/labels use Sharp and a
system sans-serif font; Sharp does not render timeline layers. Font availability
and exact label appearance depend on the host.

Export limits still apply to the whole project: at least one video, image, text or subtitle cue,
frame-aligned title boundaries, at most 64 non-subtitle clips and 600 seconds, rational 1–120 fps,
even sides 2–3840 and at most 3840×2160 pixels. Referenced visual sources must be
readable even outside the requested range; clips also validate referenced audio.
Unused offline assets do not block rendering. Audio-only/empty projects remain
inspectable but cannot generate visual previews. T27's SDR/color, VFR, HDR and
long-run audio limitations still apply. Preview ranges trim the finished
composition; decoding preceding frames can make late-frame requests slower.
This is an inspection/export path, not a real-time playback benchmark.

Only explicit new output paths in existing writable directories are accepted;
previews never overwrite files, symlinks, project data, history or original media.
PNG files are probed and videos are probed and frame-count verified
before atomic publication. Contact sheets render tiles sequentially, retain at
most 16 bounded PNGs, and cap the final grid below 13 million pixels; their temporary
directory is removed on success or handled failure. Clip output is bounded by
30 seconds and existing renderer limits. Existing output files remain intact.
Handled cancellation removes temporary files before exit 130 (SIGINT) or 143
(SIGTERM); SIGKILL/power loss cannot run cleanup.

With `--json`, stdout contains one success document. Preview clip progress is
JSONL on stderr; its last stderr line on failure is the existing structured error
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Check exit status before using results: 0 success, 2 invalid command/option/range,
1 invalid project/media/prerequisite/file/runtime failure. Invalid requests never
publish partial destinations. JSON errors preserve existing CLI codes; argument
errors include a usage hint.

## Commands

- `project cache-preview PROJECT [--size 960] --json` and
  `desktop control PROJECT REQUEST.json --json` provide
  [rendered previews and live desktop control](#rendered-preview-and-desktop-control).
- `subtitle.words` in `edit apply` accepts a cue ID and a `words` array.
  Each entry has `from` and `to` UTF-16 text offsets and exact cue-relative
  `start` and `end` times. Intervals are half-open and cannot overlap.
  The active word animates and highlights in preview and burn-in.
  Timeline inspection includes `subtitleCueId` on these generated segments.
  SRT and WebVTT export still carries cue text and timing.

- `project freeze PROJECT CLIP --at FRAME --frames COUNT --output NEW.png`
  extracts the covering source frame and inserts a still. The edit shifts later
  clips on that track and participates in undo. The PNG is retained for redo.
  OpenCut removes the PNG after a confirmed edit rejection. If the commit
  outcome is unknown, inspect the project before retrying.
- `project snapshot PROJECT --output NEW.opencut.json` writes a separate copy
  of the current revision. `project package PROJECT --output NEW_FOLDER` also
  copies the media referenced by the current project and undo/redo history.
  Missing historical files remain offline when that revision is restored.
- `media relink PROJECT ASSET FILE` re-probes a source and keeps the stable
  asset ID. `media import-font PROJECT TITLE_OR_CUE FILE` embeds a TTF or OTF
  of up to 2 MiB. Both support dry runs and revision checks.
- `project render` accepts `--width` and `--height` together, `--fps N[/D]`,
  `--codec h264|hevc`, `--video-bitrate`, `--audio-bitrate`, `--audio-rate` and
  `--audio-channels`. Bitrates are in kb/s. See [export settings](EXPORT.md).
- `edit apply` supports `clip.replace`, `clip.detach-audio`, `clip.dissolve`,
  `clip.flash`, `clip.fade`, `clip.grade`, `clip.gain-keys`, `clip.effects` and
  `subtitle.effects`. `clip.visual` accepts `crop` as fractional edge insets.
  `subtitle.style` accepts optional cue `ids`. Discover their fields with
  `opencut help edit apply --json`.

- No arguments, `--help`, or `-h`: print usage. Help takes precedence over version.
- `help [GROUP [ACTION]] --json`: discover commands, arguments, capabilities and schemas.
- `--version` or `-v`: print the application version.
- `project create <project-file> --name <name> [--width <px>] [--height <px>] [--fps <n|n/d>] [--json]`:
  create an empty version 1 project without overwriting.
- `project info <project-file> [--json]`: display validated metadata, settings and collection counts.
- `project inspect <project-file> [--json]`: read revision-tagged settings, assets, tracks, clips and duration.
- `project validate <project-file> [--json]`: validate project structure, internal references and media availability.
- `project render <project-file> --output <file.mp4> [--quality <draft|balanced|high>] [--resolution <project|720p|1080p>] [--overwrite] [--no-subtitles] [--json]` composites video, image, text and subtitle layers with mixed audio tracks to H.264/AAC MP4.
- `project --help` and `project create|info|validate|render --help`: show project usage.
- `media import <project-file> <file> [--json]`: import a source reference and metadata.
- `media list <project-file> [--json]`: list stored assets and source availability.
- `media info <project-file> <asset-id> [--json]`: inspect a stable asset ID.
- `media remove <project-file> <asset-id> [--json]`: remove an unreferenced asset entry.
- `media --help` and `media import|list|info|remove --help`: show asset usage.
- `timeline list <project-file> [--json]`: inspect tracks, clips and exact timing.
- `timeline inspect <project-file> --frame <n> [--json]`: evaluate active layers, audio candidates and exact source-time mappings.
- `preview frame|contact-sheet|clip <project-file> --output <new.png|new.mp4> [options]`: generate headless composited inspection media; see [selection, quality and resource limits](#agent-discovery-and-visual-inspection-t29).
- `track add <project-file> --type <video|audio> --name <name> [--json]`: append a track.
- `track audio <project-file> <track-id> [--volume <0..1>] [--muted <true|false>] [--json]` controls the sound on a video or audio track.
- `track remove <project-file> <track-id> [--json]`: remove an empty track.
- `clip add <project-file> <asset-id> --track <track-id> --at <frame> --in <frame> --out <frame> [--json]`: place an asset range.
- `clip move <project-file> <clip-id> [--track <track-id>] [--at <frame>] [--json]`: move without changing source points.
- `clip trim <project-file> <clip-id> [--in <frame>] [--out <frame>] [--json]`: change source points with a fixed timeline start.
- `clip audio <project-file> <clip-id> [--volume <0..1>] [--muted <true|false>] [--fade-in <frames>] [--fade-out <frames>] [--json]` configures clip audio. `clip add` accepts the same optional audio flags.
- `clip split <project-file> <clip-id> --at <frame> [--json]`: split strictly inside a clip.
- `clip remove <project-file> <clip-id> [--json]`: remove only that clip.
- `clip visual <project-file> <clip-id> [--x <px>] [--y <px>] [--scale <n>] [--rotation <degrees>] [--opacity <0..1>] [--fit <contain|cover|stretch>] [--json]`: configure a visual clip. `clip add` accepts these flags too.
- `canvas set <project-file> [--width <px>] [--height <px>] [--background-color <#RRGGBB|#RRGGBBAA|transparent>] [--json]`: configure the canvas.
- `timeline|track|clip|canvas --help`: show editing usage and time semantics.
- `edit apply <project-file> <batch.json> [--dry-run] [--expected-revision <n>] [--json]`: commit an atomic batch.
- `edit undo|redo <project-file> [--dry-run] [--expected-revision <n>] [--json]`: restore a transaction.
- `edit history <project-file> [--json]`: inspect the current revision and persistent history.
- `edit --help`: show transaction usage and batch format.
- `probe <file> [--json]`: inspect a readable local file with ffprobe.
- `extract-frame <file> --timestamp <seconds> --output <file.png> [--json]`:
  extract one video frame with ffprobe and FFmpeg. Seconds must be a finite,
  nonnegative decimal number, such as `0`, `0.5`, or `12.25`.
- `compose <clip1> <clip2> [more clips] --music <audio> --output <new.mp4> [--json]`:
  concatenate video clips in argument order and mix their original audio with music.

Options can precede the input. For filenames beginning with `-`, put all options
before `--`, followed by the filename, or use an absolute path. For an output
name starting with `-`, use `--output=-frame.png` or an absolute path. Quote paths
containing spaces in the calling shell.

All commands print readable output by default. `--json` prints one JSON
object followed by a newline, except `project render` and `cache proxy`, which stream JSONL progress
and terminal events. Cache management prints a terminal `{event:"result",result:...}` object. Diagnostics never go to stdout.
Errors go to stderr. With `--json`, the error is
`{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"..."}}`;
argument errors also include `error.hint`. Without `--json`, errors remain text.

## Rendered preview and desktop control

`opencut project cache-preview "$PROJECT" --size 960 --json` renders or
reuses a full timeline MP4 with mixed audio. It returns `path`, `hit`, `key`,
`revision`, `frameCount`, and `frameRate`. `--size` caps the longest side at
64–1920 pixels and defaults to 960. Desktop **Render full timeline** uses
the same cache. It samples VFR footage by source presentation time onto the
project frame grid. Use `project render` for a durable export.

`opencut desktop control "$PROJECT" request.json --json` requires the saved
project to be open in OpenCut desktop on macOS or Linux. Run
`opencut help desktop control --json` for the request schema. For example, put
`{"action":"seek","frame":120}` in `request.json` to seek to project frame 120.
Use `{"action":"status"}` to read the current viewer, selection, playhead, and
project preview state. The `render-preview` action acknowledges the request
before rendering finishes. Query `status` for `state.preview.renderStatus` or use
`project cache-preview` to wait for and obtain the rendered file directly.

Other actions select clips or assets, switch viewers, seek within the source,
step, play, pause, toggle playback, return to live preview, search online
media, or import a search result by ID with an expected revision.

## Dialogue separation

`opencut media separate-dialogue PROJECT ASSET --output NEW_FOLDER --json`
writes `dialogue.wav` and `background.wav`. The model estimates the dialogue;
background is the normalized original mix minus that estimate. Both stems
use the same 48 kHz stereo sample grid and cover the input duration. Import
the files as audio assets to mix or export them. The desktop imports both files
automatically after separation.

Install [ELUATE](https://github.com/anaxoniclabs/ELUATE) in a local Python
environment and run `eluate setup` there to obtain its multilingual Bandit v2
checkpoint. Set `OPENCUT_DIALOGUE_PYTHON` to that environment's Python
executable before launching OpenCut or the CLI if it differs from `python3`.
OpenCut invokes the local inference API and requires FFmpeg and ffprobe.
The current integration accepts sources with a known duration of up to ten minutes.

## Shared projects in Electron (T22)

On macOS/Linux, existing editing commands automatically route through Electron
when it owns the project. Timeline, media, project and history queries see that
same session. CLI edits update the open window through events without reopening;
GUI edits are immediately available to CLI queries. Both use one revision and
undo/redo history. A named project's edits are saved before success is returned.
Untitled GUI projects still require their first Save before CLI access.

CLI edits and undo/redo preserve the open timeline's zoom, horizontal/vertical
scroll, Snap toggle and snap threshold. Explicitly opening or reopening a project
resets timeline view settings. Source preview is invalidated independently when
CLI changes arrive.

Use **Open project** to select an older backup, including a copy with the same
project ID or a backup restored at the same path. Its lower revision and stored
history become current in both interfaces. Query `edit history` again before
issuing revision-guarded edits; do not reuse a revision observed before reopening.

Use `edit history` and `--expected-revision` when acting on a prior query. Batch
apply still requires `expectedRevision`. Even without that flag, a proposal
prepared against an active session is rejected if another edit wins first.
`REVISION_CONFLICT`, `SESSION_BUSY` and `PROJECT_LOCKED` mean reload/reconsider
and retry after the competing operation finishes. A second GUI cannot acquire
the same project. Dry-run validates against the same authority without changing
project bytes, history or the visible timeline.

After `SESSION_DISCONNECTED`, `SESSION_CHANGED`, `COMMIT_OUTCOME_UNKNOWN`, or a
timeout, query history and content before retrying. A lost response can follow
a successful commit. The CLI
never silently retries a session mutation on disk. After Electron exits/crashes,
new CLI invocations resume independent work on the last complete saved project.

The permanent `<project-file>.opencut-lock` sidecar holds an OS-backed SQLite
lock, not project data. **Do not delete this sidecar:** a crash automatically
releases ownership. A stale socket is replaced by the next session owner.
Legacy `.lock` files still block updates; remove those only after confirming all
old writers have stopped. Do not mix old and T22 writer versions. Local filesystems
are required; Windows session transport and network filesystems are unsupported.
Messages are limited to 64 MiB, with a 30-second idle timeout. The security boundary
is the current OS account. See [the session decision](adr/0011-shared-project-session.md).

Exit codes: **0** success, **2** invalid command/arguments, **1** failed project
validation, invalid project data, media, filesystem, prerequisite or execution failure.
Render/preview cancellation exits **130** for SIGINT or **143** for SIGTERM.
Unknown commands/options, extra positional arguments and options that do not apply
to the command fail. Repeated options use the last value, matching Node's parser
and existing media commands. `--name` applies to project creation and track creation;
`--width`, `--height` and `--fps` apply to project creation and composition with
the distinct bounds below. `--timestamp` uses source seconds for extraction/cache;
T29 inspection/previews use integer project frames. `--output` applies to
extraction, composition, project rendering and timeline previews. Help with
`--json` returns the versioned discovery catalog, retaining its `help` text field;
version with `--json` returns `{ "name": "OpenCut", "version": "0.1.0" }`.
The application version is separate from the project file's `schemaVersion`;
use the latter to identify the supported project format.

## Projects

Project commands run independently of Electron. Create/info/validate need no FFmpeg/ffprobe; render requires both tools.
`<project-file>` is always an explicit file location, with no implicit project discovery
or directory creation. Relative paths resolve from the process working directory;
results report absolute paths. Quote paths with spaces. Any filename extension is
accepted; `.opencut.json` is suggested. Use `--` before a positional path beginning
with `-`. Paths must be nonblank and contain no control characters.

Creation requires a nonblank `--name`. Defaults are 1920×1080 at 30/1 fps, matching
the T05 core model. Width and height must be positive safe integers (up to
9007199254740991), with no even-dimension or encoder-specific restriction.
`--fps` accepts a positive safe integer or a rational with positive safe integer
components, such as `24` or `30000/1001`. Decimal rates such as `29.97` are rejected;
use an exact ratio. Ratios are preserved as supplied. These project settings are
data-model values; T12 rendering supports the explicit limits below.
The core generates a stable UUID and UTC creation/update timestamps. Assets,
tracks and clips start empty. Inputs are validated before opening the destination.
The parent must exist. Creation refuses existing files, directories and
symlinks, including dangling symlinks. The CLI publishes a prepared file with
an exclusive hard link where supported and falls back to an exclusive copy on
volumes such as exFAT. Forced termination during the copy can leave an
incomplete new file. Media import and removal use the separate atomic update
path and require the shared writer lock. See the
[project file persistence contract](PROJECT_FORMAT.md#api-and-errors).

Creation and info JSON have the same shape:

```json
{
  "path": "/path/to/demo.opencut.json",
  "schemaVersion": 1,
  "metadata": {
    "id": "example-project",
    "name": "Demo",
    "createdAt": "2026-10-25T00:00:00.000Z",
    "updatedAt": "2026-10-25T00:00:00.000Z"
  },
  "settings": {
    "width": 1920,
    "height": 1080,
    "frameRate": { "numerator": 30, "denominator": 1 }
  },
  "statistics": { "assets": 0, "tracks": 0, "clips": 0 }
}
```

Info validates project data before returning metadata and counts. Offline media
does not prevent info from succeeding; info performs no media availability checks.
Neither info nor validate modifies project data, timestamps, references or media.

Validation JSON contains `path`, `valid`, `structureValid`, `issues` and `media`.
`structureValid` includes schema, supported version, unique IDs, asset/track
references, compatible media types, timestamps and source ranges. Each issue has
a JSON-pointer `path`, `code` and actionable `message`. Invalid JSON or structure
returns `structureValid: false` and an empty `media` array. Once data is valid,
every asset is checked for regular-file readability, with paths anchored to the
project file's directory. Each media entry has `assetId`, resolved `path`, `status`
and `message`. Statuses are `available`, `missing`, `unreadable`, `not_file` and
`unsupported_path`. Validation checks no codecs, decoding, timing or stream content.

`valid` is true only when structure and every availability check pass. Missing
media leaves the project data usable (`structureValid: true`), but validation
returns exit 1 so automation can detect unresolved references. Invalid projects
still produce a report on stdout, including with `--json`, plus diagnostics on
stderr. Check the exit status and report. Missing/unreadable project files and
other execution failures produce only stderr diagnostics with no stdout report.
See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for the shared core API and file contract.

## Probe JSON

| Field              | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `path`             | Absolute input path                                                                      |
| `formatName`       | ffprobe container name, or `null`                                                        |
| `startTimeSeconds` | Container start timestamp in seconds, or `null`; stream starts use the same time base    |
| `durationSeconds`  | Container duration, falling back to the maximum known stream duration; `null` if unknown |
| `hasAudio`         | Whether any audio stream is present                                                      |
| `video`            | Default non-cover-art video stream, falling back to the first; `null` if absent          |
| `audio`            | Default audio stream, falling back to the first; `null` if absent                        |
| `streams`          | Every stream, including subtitles, data and attached pictures                            |

Each stream contains `index`, `type`, `codec`, `durationSeconds`,
`startTimeSeconds`, `timeBase`, `bitRate`, `language`, `isDefault`,
`isAttachedPicture`, `width`, `height`, `frameRate`, `frameRateRatio`,
`pixelFormat`, `sampleRate`, `channels`, and `channelLayout`. Missing or
inapplicable numeric/string fields are `null`. Stream indices refer to the
original input. Dimensions are coded pixel dimensions. `frameRate` is the average
FPS; `frameRateRatio` preserves its rational representation, such as
`30000/1001`. An average rate does not imply constant-rate video. Unknown or
invalid rates such as `0/0` become `null`. Still images can have unknown duration.
Inspection reads metadata; it does not verify that every frame is decodable.
Start timestamps may be negative; preserve their signs when calculating offsets.

## Frame JSON and file safety

The extraction result contains `path` (absolute output), `sourcePath` (absolute
input), `timestampSeconds` (requested time), and `streamIndex` (selected video).
It saves one PNG without modifying the source. The timestamp is relative to the
input start, rounded to FFmpeg's microsecond precision. FFmpeg seeks accurately
and selects the first available frame at or after that time. An exact frame at
every timestamp is not guaranteed.

A timestamp at or beyond the selected video's known end relative to the input
start is rejected: `video.startTimeSeconds - startTimeSeconds + video.durationSeconds`.
For example, a two-second video starting at 5s in a file starting at 0s ends at 7s;
5.5s is a valid request. An input starting at 10s with video starting at 15s and
lasting two seconds has the same 7s end relative to input start. When stream timing
or the input start is unavailable, the reported media duration is used if known.
Unknown bounds are checked by attempting extraction. Extraction fails if FFmpeg
produces no frame, including after a seek beyond the last available frame.
Audio-only media and files containing only attached cover art have no extractable
video stream. The result's
`timestampSeconds` retains the requested value before rounding to FFmpeg precision.

The destination must end in `.png`. Existing files, directories and symlinks are
refused; no overwrite option is provided. PNG bytes are decoded and checked for
the PNG signature before exclusive output creation, so subprocess failures leave
no output file. Disk write failures can leave an incomplete newly created output;
review it before removing it. Parent directories are not created automatically.

## Timeline editing

T08 uses the shared, filesystem-free core operations. The CLI is a parsing and
persistence adapter. Every command takes an explicit project path, resolved from
cwd, and supports `--json` and `--help`. No Electron, FFmpeg, ffprobe, decoding or
source-file availability is needed for editing. Asset metadata is a stored snapshot.
Use `media import` first to obtain `asset.id`; track/clip creation returns stable
UUIDs. Subsequent operations take those IDs, never array indices.

The `--at`, `--in` and `--out` arguments are **nonnegative safe integer
frame indices at the project's frame rate**, including source in/out points.
They are not source-file frame numbers or decimal seconds. At 30000/1001 fps,
frame 30 is exactly 1001/1000 seconds. Integer seconds, sample positions or source
frame indices must be converted deliberately when using these CLI flags. The core
API also accepts arbitrary exact rational seconds, preserving existing subframe
and sample offsets. Neither interface rounds, snaps or inspects actual VFR frames.
Out points and timeline ends are exclusive. One-frame clips are valid.

Choose source points against the stored rational `asset.duration`, rather than
rounding decimal metadata to a nearby frame. For a two-second asset at
30000/1001 fps, frame 60 is 2.002 seconds and fails the source bound; the largest
allowed integer out point is frame 59. In general, use the floor of duration
multiplied by the project frame rate, computed from their exact rational
components. A source end between project frames remains representable directly
through the rational core API. The workflow below assumes the asset permits at
least source frame 90.

```sh
node apps/cli/dist/index.js media import /work/demo.opencut.json /media/camera.mp4 --json
node apps/cli/dist/index.js track add /work/demo.opencut.json --type video --name "Video 1" --json
node apps/cli/dist/index.js track add /work/demo.opencut.json --type audio --name "Audio 1" --json
# Substitute the returned ASSET_ID, TRACK_ID and CLIP_ID:
node apps/cli/dist/index.js clip add /work/demo.opencut.json ASSET_ID --track TRACK_ID --at 30 --in 15 --out 75 --json
node apps/cli/dist/index.js timeline list /work/demo.opencut.json --json
node apps/cli/dist/index.js clip move /work/demo.opencut.json CLIP_ID --at 60 --json
node apps/cli/dist/index.js clip trim /work/demo.opencut.json CLIP_ID --in 30 --out 90 --json
node apps/cli/dist/index.js clip split /work/demo.opencut.json CLIP_ID --at 90 --json
node apps/cli/dist/index.js clip remove /work/demo.opencut.json CLIP_ID --json
# Remove the other clip returned by split before removing its populated track:
node apps/cli/dist/index.js clip remove /work/demo.opencut.json RIGHT_CLIP_ID --json
node apps/cli/dist/index.js track remove /work/demo.opencut.json TRACK_ID --json
```

- `track add` requires a nonblank name and type `video` or `audio`, and appends the track.
  Removing a populated track fails with its clip IDs; explicitly move or remove them first.
- `clip add` requires an existing asset and compatible track plus all three time
  options. Video tracks accept video/image assets; audio tracks require audio.
- `clip add` optionally accepts `--volume`, `--muted`, `--fade-in`, and `--fade-out`.
  `clip audio` updates an existing media clip and requires at least one of these flags.
  `track audio` requires at least one of `--volume` and `--muted`.
  Gains are decimal linear amplitude from 0 to 1 and default to 1. Clip and track
  gains multiply. Either mute silences the clip and keeps the stored gain.
  Fade lengths use whole project frames. Zero clears a fade. The sum of both
  fade lengths must fit the clip. Moving carries fades with the clip. Trimming
  re-anchors fades and shortens them as needed. Splitting preserves the envelope.
  Audio edits support the same history, dry-run and revision guards as other edits.
  An AV asset may be placed independently on either type. No linked clip is created.
- `clip move` requires `--track`, `--at` or both. Omitted values stay unchanged.
  Source points, duration, asset ID and clip ID are preserved.
- `clip trim` accepts `--in` and `--out` in project frames, or `--in-time` and
  `--out-time` in exact source seconds (decimal, timestamp or fraction). Set at
  least one boundary and use only one flag per boundary. Timeline start and
  speed stay fixed while the source range changes. Exact source points render at any supported speed, including the default 1×.
  Extending a range is allowed within the asset bound and available track space.
- `clip split --at` uses an **absolute timeline position**, strictly between the
  clip's timeline start and end. Left keeps the original ID; right gets a new UUID.
  The exact source split is `sourceIn + (at - timelineStart) × speed`. Both pieces reference
  the same asset and track; their source ranges are contiguous, and total duration
  and timeline coverage are unchanged. The right entry is inserted after the left.
- `clip speed PROJECT CLIP_ID --speed 3/2 --json` sets a constant multiplier on a
  video or audio clip. Decimals such as `1.5` are also accepted. The range is
  0.25× through 4×. The clip start, source in/out, and timeline fade durations
  are preserved. Changes that collide with another clip on the same track or
  invalidate existing fades are rejected. Use `--speed 1` to restore normal speed.
- `clip remove` leaves a gap and preserves all assets, tracks and other clips.

Clips default to 1×. Source ranges must be nonnegative, nonempty and end no later
than the asset's recorded rational duration when known. **Unknown-duration assets,
including images, require explicit ranges and have no inferred finite source bound.**
Editing does not establish that unknown or stale ranges are decodable; validate
media separately. Images use their selected range as a duration at the model level.

**Same-track overlaps are forbidden for video and audio.** Touching exclusive
boundaries, gaps, and overlap across different tracks are allowed. Add, move, trim and
speed edits reject collisions instead of shifting clips or choosing another position.
Splits create exactly adjacent pieces. Loading, saving and project validation
apply the same overlap rule, including unsorted hand-edited documents. Pre-T08
files with same-track overlaps are now invalid; resolve their positions/ranges in
JSON before using edit commands. There is no silent migration. Derived durations
and ends must fit safe rational JSON components; arithmetic overflow fails without
rounding. These commands preserve other clips and use explicit track and source edits. Desktop editing uses the shared core operations
and transactions; T09 history is described below.

`timeline list` returns `{ path, frameRate, duration, tracks }`. All times are
`{ numerator, denominator }` in exact seconds; `duration` is the maximum clip
end, or zero for an empty timeline. Tracks retain insertion order and contain
`id`, `name`, `type`, and `clips` ordered by timeline start. Each listed clip
contains the stored `id`, `assetId` or `text`, `trackId`, `timelineStart`, `sourceIn`,
`sourceOut`, optional `speed`, plus derived `duration` and `timelineEnd`. Derived fields are not saved.

Mutation JSON results are:

| Command                          | Result                     |
| -------------------------------- | -------------------------- |
| `track add`                      | `{ path, track }`          |
| `track remove`                   | `{ path, removedTrackId }` |
| `track audio`                    | `{ path, track }`          |
| `clip add/move/trim/audio/speed` | `{ path, clip }`           |
| `clip split`                     | `{ path, left, right }`    |
| `clip remove`                    | `{ path, removedClipId }`  |

`track` and `clip` use the stored model fields; mutations do not include derived
timing. Mutation paths are canonical absolute paths; list retains the requested
absolute path. Successful changes update `metadata.updatedAt` without going
backwards; exact no-op moves, trims and speed edits preserve bytes and timestamps. Read back
`timeline list` after mutations. Inspection never writes. Mutations reuse the
[asset atomic-save guarantees](#project-media-assets): writer lock, validation
before publishing, synced temporary JSON and same-directory rename, refusal of
project-file symlinks/hard links, and outside-change detection. Invalid edits
leave original project bytes intact and clean owned temporaries; the ownership sidecar remains.

Errors use structured diagnostics on stderr with `--json`, no success JSON on
failed commands, exit 1 for invalid edits/data/I/O,
and exit 2 for malformed or inapplicable arguments. Check exit status before
parsing stdout. Diagnostics identify IDs or JSON-pointer fields, source bounds
and colliding clips. Core errors expose machine-readable codes and validation
issues; see [the API contract](PROJECT_FORMAT.md#timeline-editing-api).

## Transactions, undo and redo

`edit apply PROJECT BATCH.json [--dry-run] [--expected-revision N] [--json]`
applies a nonempty array of timeline operations as **one transaction**. The
project path is explicit, followed by the batch file path; both resolve from cwd.
Read `edit history PROJECT --json` first and use its `revision` as the batch's
required `expectedRevision`. Legacy projects without history have revision 0.
For example, with an existing imported asset `asset-camera` and revision 0:

```json
{
  "expectedRevision": 0,
  "label": "Place and split camera",
  "operations": [
    {
      "type": "track.add",
      "id": "video-main",
      "name": "Video",
      "mediaType": "video"
    },
    {
      "type": "clip.add",
      "id": "camera",
      "assetId": "asset-camera",
      "trackId": "video-main",
      "at": 0,
      "in": 0,
      "out": 60
    },
    {
      "type": "clip.split",
      "id": "camera",
      "at": 30,
      "rightId": "camera-right"
    }
  ]
}
```

```sh
node apps/cli/dist/index.js edit history /path/to/project.opencut.json --json
node apps/cli/dist/index.js edit apply /path/to/project.opencut.json /path/to/batch.json --dry-run --json
node apps/cli/dist/index.js edit apply /path/to/project.opencut.json /path/to/batch.json --json
node apps/cli/dist/index.js edit undo /path/to/project.opencut.json --expected-revision 1 --json
node apps/cli/dist/index.js edit redo /path/to/project.opencut.json --expected-revision 2 --json
```

Batch objects allow only `expectedRevision`, optional nonblank `label`, and
`operations`. Operation objects are strict; unknown fields/types fail. All IDs
follow the project ID rules. Frame fields are nonnegative safe integer **project frame indices**.
For rational source times, use `inTime` and `outTime` with integer
`numerator` and `denominator` in seconds. `fadeIn` and `fadeOut` are project-frame durations. No media probing, source changes or rendering occurs.

| Operation `type` | Required fields besides `type`                         | Optional fields                                                |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `track.add`      | `name`, `mediaType` (`video` or `audio`)               | `id`                                                           |
| `track.audio`    | `id`                                                   | `volume`, `muted` (at least one)                               |
| `track.remove`   | `id`                                                   | —                                                              |
| `clip.add`       | `assetId`, `trackId`, `at`, `in`, `out`                | `id`, `volume`, `muted`, `fadeIn`, `fadeOut`, `visual`         |
| `clip.speed`     | `id`, `speed` ratio from 1/4 to 4                      | —                                                              |
| `clip.audio`     | `id`                                                   | `volume`, `muted`, `fadeIn`, `fadeOut` (at least one)          |
| `clip.visual`    | `id`                                                   | `x`, `y`, `scale`, `rotation`, `opacity`, `fit` (at least one) |
| `text.add`       | `at`, `duration`, `text` (requires `content`)          | `id`, `trackId`, `visual` (x/y/scale/rotation/opacity)         |
| `text.set`       | `id`                                                   | `text` patch, `at`, `duration` (at least one)                  |
| `canvas.set`     | —                                                      | `width`, `height`, `backgroundColor` (at least one)            |
| `clip.move`      | `id`, at least one of `trackId` / `at`                 | remaining destination field                                    |
| `clip.trim`      | `id`, at least one of `in`, `out`, `inTime`, `outTime` | remaining source boundary                                      |
| `clip.split`     | `id`, `at`                                             | `rightId`                                                      |
| `clip.remove`    | `id`                                                   | —                                                              |

Omitted new IDs become UUIDs. Supply explicit IDs when later operations in the
same batch must reference a newly added track/clip or the right side of a split.
Each operation sees the preceding result. Every intermediate state must be valid:
a temporary overlap or removing a populated track fails even if a later operation
would repair it. Any failure discards the entire batch without changing saved
content, revision, undo or redo. Diagnostics include the failing operation's
one-based index and type. An empty batch is invalid.

### Text layers (T33)

Create and update text with `edit apply` and inspect it with `timeline list`,
`timeline inspect` or `project inspect`. `help --json` publishes the
batch shape under `schemas["edit apply input"]`. This example adds a layer
on an automatically created top video track.

```json
{
  "expectedRevision": 0,
  "label": "Add bilingual title",
  "operations": [
    {
      "type": "text.add",
      "id": "title",
      "at": 30,
      "duration": 90,
      "text": {
        "content": "OpenCut\n你好，世界！",
        "fontSize": 64,
        "fontWeight": 700,
        "color": "#fff4da",
        "alignment": "center",
        "wrapWidth": 640,
        "rotation": -5,
        "stroke": { "color": "#181428", "width": 2 },
        "shadow": { "color": "#000000aa", "x": 4, "y": 5, "blur": 8 },
        "background": { "color": "#251b3599", "padding": 18 }
      },
      "visual": { "x": 30, "y": 220, "scale": 1, "opacity": 0.92 }
    }
  ]
}
```

Use an existing video `trackId` to control stacking. The layer shows on
`[at, at + duration)` in project frames. `text.set` can update start,
duration and style together. Omitted fields keep their values. Supply `null`
to clear stroke, shadow, background or wrapping. Move, split and remove the
layer with the normal clip commands. Use `clip visual` for x, y, scale, rotation and opacity. Text supports no media fitting mode or clip audio.

Font size (1–512), wrap width (1–3840), stroke width (0–64), shadow
offsets (±128), shadow blur (0–64) and background padding (0–128) use
project pixels before uniform scale. Rotation is clockwise in degrees around
the block center (±360). The block is centered on the canvas, with x/y moving
it right/down. Alignment positions lines within that block. The line height is
1.25× font size. Explicit newlines are preserved. Wrapping, when enabled, uses
word boundaries and splits overlong words at grapheme boundaries. A single
grapheme can exceed the width. Tabs expand to four spaces. Text accepts up to
4096 UTF-16 code units. Weight uses 100–900 in steps of 100. Colors accept
`#RRGGBB`, `#RRGGBBAA` and `transparent`. Opacity applies to the whole
layer including its effects. Font, size, weight, fill and alignment default to
Noto Sans SC, 48 px, 400, white and center.

Electron, `preview frame`, `preview contact-sheet`, `preview clip` and
`project render` share text shaping and rasterization. A project can render
with text as its only visual content. Named installed fonts are host-dependent.
A missing family falls back to bundled Noto Sans SC. `project render --json`
lists substitutions in the final `completed` event's `warnings` array when
there are any. Human-readable rendering prints the warnings to stderr.
The fallback stack includes monochrome Noto Emoji.
Unsupported characters may appear as a missing-glyph box. See the
[typography comparison and limitations](PREVIEW_EXPORT_CONSISTENCY.md#text-layers-t33).

### Editable subtitles (T34)

```bash
opencut subtitle import project.opencut.json captions.srt --expected-revision 0 --json
opencut subtitle list project.opencut.json --json
opencut subtitle export project.opencut.json --output captions.vtt --json
opencut project render project.opencut.json --output captioned.mp4 --json
opencut project render project.opencut.json --output clean.mp4 --no-subtitles --json
```

Import appends cues and preserves the existing shared style. One import is one
undo step. Use `--dry-run` to validate without saving. A malformed cue rejects
the entire import with its block number. A valid empty file adds no cues and
creates no revision. Use `project inspect` to see the persisted track and
`timeline inspect` to see its active text layers with `subtitle: true` and a
static `sourceTime` of zero.

Apply edits with `edit apply` and the current revision. Every cue time is exact
rational seconds, such as `{"numerator":105,"denominator":1000}`. Cues can
overlap and use exclusive ends.

| Operation         | Fields besides `type`                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subtitle.import` | `cues`, an array of `{start,end,text}`                                                                                                                                                |
| `subtitle.add`    | `start`, `end`, `text`, optional `id`                                                                                                                                                 |
| `subtitle.set`    | `id` and any of `text`, `start`, `end` or `duration`. End and duration are mutually exclusive. A start-only edit keeps the old end.                                                   |
| `subtitle.move`   | `id`, new `start`. Duration stays fixed.                                                                                                                                              |
| `subtitle.split`  | `id`, interior time `at`, optional `rightId`. Both halves start with the same text.                                                                                                   |
| `subtitle.merge`  | `ids`, two or more distinct cues. The first cue in timeline order keeps its ID. The merged range spans the earliest start to the latest end and joins nonempty text with line breaks. |
| `subtitle.remove` | `id`                                                                                                                                                                                  |
| `subtitle.style`  | `style` patch with `fontFamily`, `fontSize`, `color`, `stroke: {color,width}`, `background: {color,padding}`, `x` and `y`. Use `null` to turn off stroke or background.               |

Sizes and offsets are in project pixels. `x` places the horizontal center
relative to the canvas center. `y` places the bottom of the subtitle block
relative to the canvas center, positive downward. The default uses bundled
Noto Sans SC, white text, black outline and a lower-center position.
Overlaps use separate lanes stacked upward, with stable positions within
each connected group of overlapping cues. Long unbroken lines or tall stacks
can clip at the canvas edge.

SRT and WebVTT sidecars store plain text and timing. Files can use UTF-8
or BOM-marked UTF-16. Output is UTF-8 with LF line endings and a new destination
path. Millisecond-aligned timings round-trip exactly. Other cue boundaries round
to the nearest millisecond. If a boundary must move to keep a sub-millisecond
cue nonempty, the error stays under 1 ms. Empty cues round-trip in OpenCut.
Blank lines inside or at the edges of a nonempty cue prevent sidecar export.
SRT treats lines containing only spaces or tabs as blank.
WebVTT IDs, cue positioning, CSS, voice annotations and inline styling are
discarded, with text content retained. SRT markup is treated as literal text.
The project supports up to 20,000 cues, 4,096 UTF-16 code units per cue and
16 MiB per input file.

Burn-in uses the shared title rasterizer and composites each visible cue once
above all video and title layers. A frame shows cues active at that frame's
start, so both boundaries round up to the next project frame for rendering.
An interval with no sampled frame is preserved in sidecars. Video burn-in
supports up to 256 sampled, nonempty cues in the requested render range.
`--no-subtitles` leaves cue imagery out while preserving the project duration.
Sidecar export works without FFmpeg.

### Keyframe animation (T37)

Use `edit apply PROJECT BATCH --json` for animation edits. Read the current
revision and clip IDs with `project inspect PROJECT --json`. The batch schema
is available from `help edit apply --json`.

| Operation              | Required fields besides `type`    | Optional fields              |
| ---------------------- | --------------------------------- | ---------------------------- |
| `clip.keyframe.add`    | `id`, `property`, `time`, `value` | `easing`                     |
| `clip.keyframe.set`    | `id`, `property`, `time`          | `newTime`, `value`, `easing` |
| `clip.keyframe.remove` | `id`, `property`, `time`          |                              |

`property` is `x`, `y`, `scale`, `rotation` or `opacity`. `time` and
`newTime` are clip-local `{ numerator, denominator }` seconds, including zero
and the exact clip duration. Duplicate times in one channel are rejected. The
allowed easings are `linear` (default), `ease-in`, `ease-out`, and
`ease-in-out`. Easing belongs to the outgoing segment. An explicit easing on
`clip.keyframe.set` replaces the current curve with the full easing domain.

```json
{
  "expectedRevision": 4,
  "label": "Slide into position",
  "operations": [
    {
      "type": "clip.keyframe.add",
      "id": "c1",
      "property": "x",
      "time": { "numerator": 0, "denominator": 1 },
      "value": -120,
      "easing": "ease-out"
    },
    {
      "type": "clip.keyframe.add",
      "id": "c1",
      "property": "x",
      "time": { "numerator": 1, "denominator": 1 },
      "value": 0
    }
  ]
}
```

Use `timeline inspect PROJECT --frame N --json` to read the evaluated `visual`
values and `preview frame` or `preview clip` to check the composited result.
`project inspect` and `timeline list --json` expose the stored keys. Use
`edit undo` and `edit redo` to restore prior snapshots.

### Undo and redo

`edit undo PROJECT` restores the previous transaction's exact content, including
metadata timestamps, IDs, rational representations and collection ordering.
`edit redo PROJECT` restores that transaction's after-state without replaying
commands or regenerating IDs. Each apply/undo/redo that changes state increments
the revision once, even when undo returns to earlier content. New changed edits
clear redo; equivalent no-op moves/trims and batches whose edits cancel out leave
history, revision and file timestamps unchanged. Generated `updatedAt` changes alone
do not count as a content change. Undo/redo with no available entry fails with exit 1.

Existing `track`, `clip`, `media import` and `media remove` mutations each record
one transaction through the same writer. Duplicate imports and no-op edits add
nothing. Asset undo/redo restores references and stored metadata only; it never
modifies source files or re-probes. Batch operations cover the T08 timeline
operations; media imports/removals remain individual commands.

All mutations above accept `--expected-revision N` and `--dry-run`. The revision
must be a nonnegative safe integer. A stale revision fails with exit 1 before any
commit. For apply, a supplied CLI revision must match the required batch revision
(otherwise exit 2). Without the flag, individual commands and undo/redo operate on
the current revision under the writer lock. Use the flag when acting on a prior
read. A failed or stale edit retains the redo branch.

Dry-run executes the same validation, operations and history planning, returning a
preview without saving content or history. It preserves project bytes and mtime,
and cleans its temporary writer lock. Media import dry-run still requires ffprobe.
Generated preview IDs and timestamps are provisional and can differ on real apply.
Existing individual command JSON shapes remain unchanged during dry-run; their
fields describe the proposed result rather than a committed edit.

`edit history` returns `{ path, revision, undo, redo }` without writing.
Each entry is `{ id, label, committedAt }`; both arrays are stacks, with the next
undo/redo at the **last** position. Undo is oldest first; redo is reverse execution
order. Snapshot contents remain in the project file rather than history stdout.
Apply/undo/redo JSON returns `{ path, dryRun, baseRevision, changed, revision,
undo, redo }`, plus `results` for apply. Each result contains its operation `type`
and the existing T08 result fields without `path`. With dry-run, `revision` and
history describe the **projected** state and `baseRevision` is the saved revision.
`changed` is false for an equivalent transaction; it adds no history. Adding then
removing a temporary track, or moving/trimming a clip back to its original values,
is a no-op when all other stored content matches. The batch still validates every
operation and the expected revision, and returns the intermediate operation
`results`. Those results do not imply a saved change; check `changed` and read back
the final timeline/history. This also applies to dry-run output.

Snapshots and current content share one atomic JSON replacement: no sidecar
history can commit independently. History survives reopening and moving the
project bundle. It is retained without automatic pruning and increases file size
by two project-content snapshots per changed transaction. Do not hand-edit content
behind existing history: snapshot mismatch or a broken chain fails with a history
conflict instead of overwriting newer content on undo. Restore a valid backup.

The existing lock, symlink/hard-link refusal, outside-change detection and atomic
save guarantees apply. Cooperating writers serialize by rejection while busy;
retry after reloading. Detected outside replacements during an operation fail.
Arbitrary noncooperating writes in the final check/rename window and power-loss
durability remain outside the filesystem guarantee. Errors are structured on stderr
with `--json`; exit 0 means success, 1 means data/runtime/file/conflict
failure, and 2 means invalid CLI arguments. Failed commands emit no success JSON.

## Composition prototype

`compose` is a T03 technical spike in the headless media package, using one
FFmpeg filter graph. It does not define a project format or timeline API.

| Option           | Default  | Accepted values                                  |
| ---------------- | -------- | ------------------------------------------------ |
| `--music`        | required | Readable local file with an audio stream         |
| `--output`       | required | New `.mp4` in an existing writable directory     |
| `--width`        | 1280     | Even integer, 2–3840                             |
| `--height`       | 720      | Even integer, 2–2160                             |
| `--fps`          | 30       | Integer, 1–60                                    |
| `--clip-volume`  | 1        | Decimal linear gain, 0–1; 0 mutes original audio |
| `--music-volume` | 0.25     | Decimal linear gain, 0–1; 0 mutes music          |

Provide 2–16 clips with a timed video stream and a known positive duration.
Still images, audio-only clips and unknown-duration inputs are rejected. Default
video/audio streams are selected using the same rules as `probe`; only that audio
stream is mixed, even if a clip contains several. Subtitles/data are not exported.

Each selected video's first frame begins its segment. Prefer its stream duration;
if absent, subtract its start offset relative to the input from the reported media
duration. For that calculation, a missing input start is zero and a missing video
start uses the input start. Unknown or nonpositive durations are rejected.

Each segment is rounded to the nearest output frame, with a minimum of one frame.
At 1 fps, even a clip lasting only 1/60 second contributes one second to the export.
The export lasts the sum of these frame-aligned durations, at most 600 seconds.
Frames can be duplicated or dropped during frame-rate conversion; the last frame
is held if rounding extends a clip. Input display aspect ratio is
preserved with square pixels and centered black letterboxing, without cropping.
Output is constant-frame-rate H.264 (`libx264`, CRF 20, veryfast), yuv420p, with
AAC 192 kb/s, 48 kHz stereo audio and MP4 faststart.

Original audio is resampled/downmixed to stereo, positioned relative to its
video's start timestamp, padded with silence or trimmed to that segment. Leading
audio before the video is dropped; delayed audio retains its gap. Missing start
timestamps assume aligned starts. Clips without audio supply silence. Background
audio starts at zero, loops when shorter and is trimmed when longer than the
composition. Gaps in background audio timestamps are filled with silence before
trimming, preserving the position of later music. Gains remain stable through
silent clips; a latency-compensated limiter prevents clipping. There is no
ducking, loudness normalization or crossfade; music loop boundaries can be audible.
This spike is intended for ordinary SDR media;
HDR/color management and damaged or misleading input timing are not validated.

Composition JSON contains absolute `path`, ordered absolute `clipPaths`, absolute
`musicPath`, frame-aligned planned `durationSeconds`, `width`, `height`, `fps`,
`clipVolume`, `musicVolume`, and measured `metadata` in the Probe JSON schema.
The metadata path points to the final destination. Before publishing, the command
checks codecs, dimensions, frame rate, audio configuration, container and stream
durations (each within max(0.1s, one frame) of planned duration), A/V duration
agreement (within 0.1s), and container/stream starts (within 0.05s of zero).
Native tests additionally decode the full export and check frame
counts, source images, mixed tone frequencies and synchronization markers.

FFmpeg renders into an owned temporary directory beside the destination.
After verification, an atomic exclusive hard link publishes the MP4; existing
files, directories, hard-link aliases and symlinks (including dangling ones) are
refused. Temporary renders are cleaned on success and handled failures, leaving
no partial final output. The destination filesystem must support hard links;
there is no overwrite option. A forced termination of the parent process can
leave an `.opencut-compose-*` temporary directory. Inputs are read only.

## Project media assets

```sh
node apps/cli/dist/index.js media import /path/to/demo.opencut.json /path/to/video.mp4 --json
node apps/cli/dist/index.js media list /path/to/demo.opencut.json --json
node apps/cli/dist/index.js media info /path/to/demo.opencut.json ASSET_ID --json
node apps/cli/dist/index.js media remove /path/to/demo.opencut.json ASSET_ID --json
```

Replace `ASSET_ID` with the stable `asset.id` from import or the asset list.

`media import <project-file> <file> [--json]` imports one video, audio or image.
It probes with the existing external ffprobe utility and stores a source reference,
name, stable UUID, media types and metadata. Files are read in place without
copying, moving or modifying them. Unsupported formats, streams without video/audio,
missing sources and unreadable sources fail before a project update is published.
Metadata probing does not guarantee full-file decodability.

Both input arguments resolve from the working directory. Source symlinks resolve
to their real target; stored references prefer normalized forward-slash paths
relative to the project directory, including `..`. Project directory aliases
resolve to the physical parent directory consistently for import, asset inspection
and project media validation. Different filesystem roots or
unrepresentable relative paths use absolute references. Quote spaces and literal
punctuation; use `--` before positional paths beginning with `-`.
Reimporting the same path, normalized alias, symlink or hard link returns the
existing asset with `imported: false`, without probing or changing project bytes
or timestamps. Different files with identical bytes remain distinct assets;
there is no content hashing or metadata refresh operation.

For example, if `/links/project` points to `/work/project`, importing
`/work/media/video.mp4` into `/links/project/demo.json` stores
`../media/video.mp4`. List, info and project validation resolve that reference
to `/work/media/video.mp4` through either project-directory path. Directory
symlinks are supported; mutations still refuse a symlink at the project filename.
Import/remove return the canonical project `path`; list/info/validate retain the
requested absolute project `path` and report resolved media locations separately.

Import JSON contains `path` (project), `imported`, `asset`, `source` and
`referencedBy`. `asset` contains the persisted project asset described in
[PROJECT_FORMAT.md](PROJECT_FORMAT.md#fields-and-invariants). Its optional
`metadata` records `kind` (`video`, `audio`, `image`), `formatName`,
`durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `frameRate`,
`frameRateRatio` and `hasAudio`. Unknown or inapplicable metadata is `null`.
Still images have no duration or frame rate; their `mediaTypes` contains `video`
to represent visual media in the existing model. Animated GIF/APNG with known
duration are video assets. Imported positive duration also becomes the model's
rational `duration`, rounded to microseconds. Metadata survives project reloads.

`media list <project-file> [--json]` returns `{ path, assets }`; each entry has
`asset`, `source`, `referencedBy`. `media info <project-file> <asset-id> [--json]`
returns `{ path, asset, source, referencedBy }`. `source` contains `assetId`,
resolved `path`, `status` and actionable `message`, using the same availability
statuses as project validation. `referencedBy` lists clip IDs. These commands
read stored metadata and check source readability without probing or writing.
They succeed for offline assets so their metadata remains inspectable; use
`project validate` when every source must be available. Legacy assets without
stored metadata remain inspectable. Unknown asset IDs fail with exit 1.

`media remove <project-file> <asset-id> [--json]` removes only an unreferenced
project entry, even if its source is missing. JSON is `{ path, removedAssetId }`.
Any referencing timeline clip blocks removal and is named in the error. No force
flag or original-file deletion exists.

Import and removal validate project data, update `updatedAt`, and publish complete
JSON by a same-directory atomic rename after syncing the temporary file. A
per-project OS-backed `.opencut-lock` serializes cooperating writers; competing updates
fail with a retry message. Updates refuse project symlinks and hard-linked project
files and check for outside changes before publication. Handled failures preserve
the previous project and clean owned temporary files. Forced termination
can leave unused `.opencut-update-*` directories; OS ownership is released
automatically. Keep the permanent `.opencut-lock` sidecar. The rename prevents partial JSON visibility;
power-loss durability and coordination with arbitrary external writers are not
guaranteed. The containing directory must be writable.

Only import requires ffprobe; list/info/remove require no media tools or Electron.
All four commands support human-readable output and scoped `--help`. No other
options apply. They follow existing CLI errors: exit 2 for invalid arguments,
exit 1 for project/media/filesystem/prerequisite failures, diagnostics on stderr
and no JSON success result on failure, including with `--json`.

## Project rendering

`project render <project-file> --output <file.mp4> [--quality <draft|balanced|high>] [--resolution <project|720p|1080p>] [--overwrite] [--no-subtitles] [--json]` reads a saved project
snapshot and composites video, image, text and subtitles with mixed audio to H.264/yuv420p and AAC MP4. It requires FFmpeg 8+
with libx264 and standard filters, plus ffprobe on PATH. The project's resolution
and exact rational frame rate determine the default output. Original video audio is preserved
by default. Independent audio clips on any number of audio tracks can overlap
original audio and each other across tracks. Clip gains, mutes, fades and constant playback speed apply to the mix. Project viewer
composites the same saved layer configuration; source preview plays originals.

T28 [desktop export](EXPORT.md) also offers HEVC and output-frame-rate conversion.
The CLI keeps project-rate H.264 and its existing quality/resolution flags; there
are no CLI codec or output-frame-rate flags. Desktop exports always refuse existing
files; CLI replacement requires explicit `--overwrite` and successful verification.

Video tracks accept video, image and text clips. Rendering requires a visual clip or a subtitle cue. Empty tracks are allowed. Same-track overlaps remain
forbidden: use separate tracks for simultaneous layers or audio. Only referenced
assets are probed; unused offline assets do not block a render. Relative sources
resolve from the physical project directory, including directory aliases.
Projects and original media are read only; history and revisions are unchanged.

Video tracks draw bottom to top in `project.tracks` array order, ignoring audio
tracks. New tracks append above existing layers; reorder the array in a project
without conflicting history to change stacking. Clips within each track are sorted
by timeline start. Every visible layer is composited at each frame, including when
lower tracks have gaps. Gaps reveal lower layers or the canvas background.
Duration ends at the last exclusive end across all clips and subtitle cues. Audio tails show
the background. Muted, zero-volume and zero-opacity clips still contribute to duration.
Media clip boundaries can fall between project frames at any speed. The
renderer samples their half-open intervals on the project frame grid, rounding
each absolute visual boundary up to a frame tick. Title clip boundaries must
align with project frames. Audio uses exact timeline and source boundaries
rounded to 48 kHz samples. Missing/unreadable media, invalid references/overlaps, unknown video
duration and source ranges exceeding freshly probed video bounds fail with
clip/path diagnostics. Stored import metadata is not treated as proof that the
current file still matches it.

Configure the canvas with:

```sh
node apps/cli/dist/index.js canvas set PROJECT --width 1080 --height 1920 --background-color '#183048' --json
node apps/cli/dist/index.js clip visual PROJECT CLIP_ID --fit contain --scale 0.5 --x=-120 --y 200 --opacity 0.75 --json
```

`canvas set` accepts any nonempty subset of width, height and `--background-color`.
Use 1080×1920 (9:16), 1920×1080 (16:9) or 1080×1080 (1:1), or other supported
even dimensions. `backgroundColor` accepts `#RRGGBB`, `#RRGGBBAA` or `transparent`, default `#000000`.
Preview retains canvas alpha. H.264 flattens the composition over black.
`clip visual` accepts any nonempty subset of `--x`, `--y`, `--scale`, `--rotation`, `--opacity`
and `--fit`; `clip add` accepts the same flags. These mutations support dry-run,
revision guards, atomic save and undo/redo. Omitted properties retain stored values.

Visual defaults are x/y 0, scale 1, rotation 0, opacity 1, fit `contain`. Coordinates are pixel
offsets from the centered fitted layer: positive x moves right, positive y down.
Negative offsets use `--x=-120` / `--y=-80`. Before pixel-grid quantization, the fitted layer top left is
`(canvas.width - layer.width)/2 + x`, `(canvas.height - layer.height)/2 + y`.
Offsets are finite decimals in [-32768, 32768]. Scale is uniform in [0.01, 4] and
multiplies the canvas fitting rectangle before centering/translation. Each rectangle
side rounds to the nearest even pixel (minimum 2, ties upward), with a render limit
of 8192 per side. `contain` preserves display aspect ratio inside that rectangle;
its unused margins are transparent. `cover` preserves display aspect ratio, fills
the rectangle and crops centrally. `stretch` fills the rectangle independently in
x/y. All modes normalize sample aspect ratio to square pixels. Shared geometry
snaps crop and placement to the even 2-pixel grid before both preview and export. Content outside the canvas
is clipped. Opacity [0, 1] multiplies source alpha; 0 hides visuals while retaining
audio. Opaque and alpha-bearing videos/images share these rules.

Import PNG/JPEG and other FFmpeg-supported still images as usual and place them
on video tracks. Their positive `out - in` range specifies a static display duration,
with no inferred source duration; a nonzero in point still selects the same image.
Splits retain the image and transforms. Animated GIF/APNG files with a known
duration are treated as timed video. Attached cover artwork on audio files is
not a visual source. See [keyframe animation](#keyframe-animation-t37) for animating visual transforms.

JSON clips accept an optional `visual` object containing x/y/scale/rotation/opacity/fit.
`clip.add` batches accept that object; `clip.visual` batches take its properties
alongside `id`, for example `{ "type": "clip.visual", "id": "c1", "x": 20 }`.
`canvas.set` batches accept width/height/backgroundColor. Empty visual/canvas
operations fail. Visual properties require video tracks. New fields remain optional
in schema version 1 and omission round-trips without defaults, including history.

Audio uses the selected default stream (falling back to the first), resampled and
downmixed to 48 kHz stereo. Video source time zero is its first video frame;
audio-only source time zero is its first audio sample. Audio clips referencing video
assets use that video's time origin too. Relative stream delays, early audio and
timestamp gaps are normalized before source trimming. Short/missing video audio
and timeline gaps supply silence. An audio-track source missing its audio stream,
with unknown duration, or with source out beyond its current audio end fails with
clip diagnostics, even when muted. Music does not loop; add explicit clips/ranges.

An independent audio clip referencing a video asset plays alongside that video's
original audio; it does not detach, link or mute the video clip. To use only the
independent audio clip, mute the corresponding video clip with
`clip audio PROJECT VIDEO_CLIP_ID --muted true --json`. Audio settings and edits
apply to each clip independently, even when clips reference the same asset.

Clip and track `volume` are linear amplitude gains from 0 to 1, with 1 as the
default. At 30 fps, `clip audio PROJECT CLIP_ID --fade-in 15 --fade-out 30 --volume 0.5 --json`
sets a half-second fade in, a one-second fade out and half amplitude.
`track audio PROJECT TRACK_ID --volume 0.5 --json` sets the track gain, producing
quarter amplitude on that clip outside its fades. Both levels support
`--muted true` and default to unmuted. Fades multiply the resulting gain using
linear ramps from the edited clip's edges, after applying the source trim.
FFmpeg evaluates the ramps on the 48 kHz export sample grid after applying
pitch-preserving `atempo` to retimed audio. Contiguous clips on the same
track with the same asset, speed and touching source points share one tempo
pass. Export then applies each clip's own fades, gain and mute. Tempo
processing can shift sharp transients and soften or shorten very short
sounds, particularly near 0.25× and 4×. The resulting audio is trimmed or
padded to the run's timeline interval. Subtitles retain their project times.
Mixing sums gains without automatic normalization as tracks enter/leave. The
existing T03 safety limiter caps peaks at 0.95 with latency compensation; dense
mixes can therefore reduce loud peaks. A silent 48 kHz stereo AAC stream is
exported even when no source has audio, preserving video-only T10 projects.
Audio boundaries round absolute timeline times to nearest 48 kHz samples
(half up), avoiding cumulative duration drift. Fractional frame/sample boundaries
can differ by at most one sample at a split; AAC may add one decoded padding
packet at EOF. MP4 timing excludes encoder delay and reports the planned duration
within 1.1 ms. No sample-exact lossless audio guarantee is made for AAC.

Source time zero is the selected video's first frame, as in T03 composition;
container/stream start offsets are normalized. Source out is exclusive.
For frame-aligned clips at the default speed, FFmpeg's `fps` filter samples
each source before integer frame trimming. For retimed or off-grid clips,
FFmpeg assigns source frames to absolute project ticks using the source time
at timeline zero as a shared reference. A source frame first appears on the
project tick at or after its mapped presentation timestamp, within the
filter's nanosecond timestamp precision. A split preserves that reference
and selects the same frames as the unsplit clip. The configured fit, scale and position
are applied after sampling, preserving source alpha. At fractional EOF rounding, at most
one cloned frame completes the last frame interval. Global output timestamps are
regenerated from integer frame indices using the project's rational time base,
so composition cannot accumulate floating-point timing drift. This is CFR
resampling, not a promise to retain every frame of a VFR or differently rated source.

Supported limits: even sides 2–3840 with at most 3840×2160 total pixels (including 2160×3840 portrait), 1–120 fps, at most 64 clips across all tracks
and 600 seconds including gaps. Reduced frame-rate numerator/denominator must fit
positive signed 32-bit FFmpeg rational components. Unsupported settings fail;
rendering never substitutes defaults. Encoding and output decode/count verification
each have a 10-minute wall-clock limit and 4 MiB stdout/stderr limits. Each input
decoder uses one thread; encoding uses two. Whole-source sampling before trim
can be slow for late in-points. HDR/color management and cross-platform validation
remain outside this milestone.

### Render presets and progress

`--quality draft|balanced|high` selects H.264 encoding: `draft` uses
ultrafast/CRF 28, `balanced` uses veryfast/CRF 20 (the unchanged default), and
`high` uses medium/CRF 16. Audio remains 192 kb/s, 48 kHz stereo AAC.
`--resolution project|720p|1080p` defaults to the project dimensions. `720p`
fits the finished canvas inside 1280×720 (720×1280 for portrait); `1080p`
uses 1920×1080 (1080×1920 for portrait). Orientation is retained; aspect ratio
is preserved up to rounding each side down to an even pixel, minimum 2. Fitting
uses an integer scale ratio until the final division, so exact even dimensions
stay exact: 704×396 with `1080p` becomes 1920×1080, and 1248×702 with `720p`
becomes 1280×720. Portrait equivalents swap the output dimensions. Square output
is 720×720 or 1080×1080. Presets may upscale smaller projects. Compositing still uses
project coordinates, then scales the finished canvas; transforms, timing and the
saved project are unchanged. Project render limits still apply before scaling.

Human progress is written to stderr; stdout contains the final saved-file message.
With `--json`, **project render streams JSON Lines**, one compact object per line.
Other commands retain their existing single JSON result. Use the direct Node
executable to avoid pnpm wrapper output. Parse each line separately and check the
exit status and terminal event; do not parse the entire stream as one JSON value.
FFmpeg's structured `-progress` output is sampled every 0.25 seconds when available:

```jsonl
{"event":"progress","phase":"rendering","percent":25,"processedFrames":30,"totalFrames":120,"elapsedSeconds":2,"remainingSeconds":6}
{"event":"progress","phase":"verifying","percent":100,"processedFrames":120,"totalFrames":120,"elapsedSeconds":8,"remainingSeconds":null}
```

Progress begins at zero before encoding. `processedFrames` is a monotonic, bounded
count of encoded frames; `percent` is that count divided by `totalFrames` × 100.
`elapsedSeconds` measures wall time since encoding began, including later
verification. `remainingSeconds` estimates encoding time from average throughput;
it is `null` before measurable progress, at encoder completion and during
verification. Startup/input probing has no percentage or ETA. A 100% encoding
event does not mean the file is ready: verification and atomic publication must
succeed first. Slow/stalled FFmpeg operations can delay progress records.

The terminal `completed` event contains `projectPath`, `path` (absolute), output
`width`/`height`, reduced rational `frameRate`, integer `frameCount`, planned
`durationSeconds`, selected `quality`/`resolution`, and measured `metadata` in the
probe schema. Runtime/preflight failures emit `{"event":"failed","message":"..."}`;
cancellation emits `{"event":"cancelled","message":"Render cancelled."}`.
Invalid arguments emit no events. With `--json`, stderr errors contain a structured
code/message, including useful FFmpeg diagnostics. No `completed` event is emitted for failed/cancelled jobs.

Choose a `.mp4` in an existing writable directory. Existing outputs (including
publication races) are refused by default. `--overwrite` explicitly permits
atomic replacement of a regular file after verification; source media and the
project file are protected, including filesystem aliases. Output symlinks and
directories are refused. New-file publication requires hard-link support;
replacement uses same-filesystem rename. FFmpeg only writes inside an owned
`.opencut-render-*` sibling directory on the destination filesystem.
Before publication, ffprobe verifies H.264/AAC codecs, 48 kHz stereo audio, zero
start, dimensions, exact frame rate, measured A/V duration and decoded frame count.
Failures/cancellation remove temporary output and preserve any previous export.

Send SIGINT (Ctrl-C) or SIGTERM to cancel input probes, encoding or verification.
The CLI forwards cancellation as SIGTERM to the active tool, escalates to SIGKILL
after two seconds if needed, waits for child closure, cleans up, and exits 130 for
SIGINT or 143 for SIGTERM. Publication is the commit point: a signal after atomic
publication cannot retract a successful export. SIGKILL of the CLI, power loss or
OS termination cannot run cleanup and may leave an owned temporary directory;
remove it only after confirming the associated render has stopped. No persistent
job queue or background service is involved. Exit 2 means invalid arguments;
exit 1 means invalid/unsupported projects, media, tools or I/O. Inspect/decode the
completed output before claiming delivery.

```sh
node apps/cli/dist/index.js project render PROJECT --output export.mp4 --quality high --resolution 1080p --json
# Explicitly replace an existing regular export only after a successful render:
node apps/cli/dist/index.js project render PROJECT --output export.mp4 --overwrite --json
```

Headless APIs: `planProjectRender(project)` from `@opencut/core` returns width,
height, backgroundColor, reduced frameRate, total frameCount, and ordered
`visualClips` / `audioClips`. Visual entries contain clipId, assetId or text,
timelineStartFrame, sourceStartFrame, frameCount, x/y, scale, opacity and fit;
array order is bottom to top. Audio entries contain the same identity/time fields,
plus combined volume, combined mute, optional resolved fade durations and gain endpoints, and required (true for audio-track clips).
`renderProjectFile(absoluteProjectPath, output, controls?)` from `@opencut/core/node` resolves
asset references and executes the plan without saving the project.
`renderVideoTimeline(options)` from `@opencut/media` takes resolved paths in place
of asset references, plus output. Both executors accept optional `quality`,
`resolution`, `overwrite`, an `AbortSignal` as `signal`, and a synchronous
`onProgress(event)` callback. Cancellation rejects with `RenderCancelledError`
from `@opencut/media` after child closure and cleanup. Callback errors also stop
encoding and clean up. Direct media callers supply `audioClips`
explicitly; omission produces silence. Legacy sequential `segments` are accepted
instead of `visualClips`, using default transforms; supplying both fails. The pure
planner now emits `visualClips` rather than its former sequential `segments` shape.
This API change is separate from saved-project compatibility: existing version 1
projects still load and render with their original defaults.

To add background music after importing it, use the returned asset and track IDs:

```sh
node apps/cli/dist/index.js media import /path/demo.opencut.json /path/music.wav --json
node apps/cli/dist/index.js track add /path/demo.opencut.json --type audio --name "Music" --json
node apps/cli/dist/index.js clip add /path/demo.opencut.json MUSIC_ASSET_ID --track AUDIO_TRACK_ID --at 30 --in 0 --out 60 --volume 0.25 --json
node apps/cli/dist/index.js clip audio /path/demo.opencut.json VIDEO_CLIP_ID --muted false --volume 1 --json
```

At 30 fps this places two seconds of music at timeline second 1. Read back
`timeline list`, render to a new path, and probe/decode the result to verify the mix.

### Worked render example

From a built checkout, create a 320×180 project at 30 fps. Choose a timed video
with at least two seconds of video and a new project/output in an existing directory.
Replace `ASSET_ID`, `TRACK_ID` and `CLIP_ID` with the corresponding `asset.id`,
`track.id` and `clip.id` from the preceding JSON results. Both clip additions use
the same asset and track.

```sh
node apps/cli/dist/index.js project create /path/demo.opencut.json --name "Timeline render" --width 320 --height 180 --fps 30 --json
node apps/cli/dist/index.js media import /path/demo.opencut.json /path/source.mp4 --json
node apps/cli/dist/index.js track add /path/demo.opencut.json --type video --name Video --json
node apps/cli/dist/index.js clip add /path/demo.opencut.json ASSET_ID --track TRACK_ID --at 0 --in 15 --out 45 --json
node apps/cli/dist/index.js clip split /path/demo.opencut.json CLIP_ID --at 15 --json
node apps/cli/dist/index.js clip add /path/demo.opencut.json ASSET_ID --track TRACK_ID --at 45 --in 45 --out 60 --json
node apps/cli/dist/index.js timeline list /path/demo.opencut.json --json
node apps/cli/dist/index.js project render /path/demo.opencut.json --output /path/demo-render.mp4 --json
node apps/cli/dist/index.js probe /path/demo-render.mp4 --json
```

The expected output is 60 frames (2 seconds): the first trimmed clip occupies
frames 0–29, split at frame 15; frames 30–44 are black; the second source range
occupies frames 45–59. All in/out values are project-frame indices; the source
ranges are 0.5–1.5 seconds and 1.5–2 seconds, with exclusive ends. Check the render
result's `frameCount`, dimensions, rate and measured metadata, then inspect/decode
the MP4. Validation success alone does not execute a render.

### Layered portrait render example

Start with a new project, a video containing at least three seconds of video,
and a still image. Run the following commands from a built checkout. Replace
`VIDEO_ASSET_ID` and `IMAGE_ASSET_ID` in the batch below with the imported
`asset.id` values. Read `edit history` and use its current revision; the shown 2
assumes a fresh project followed by these two distinct imports.

```sh
node apps/cli/dist/index.js project create /path/portrait.opencut.json --name "Layered portrait" --width 1080 --height 1920 --fps 30 --json
node apps/cli/dist/index.js media import /path/portrait.opencut.json /path/video.mp4 --json
node apps/cli/dist/index.js media import /path/portrait.opencut.json /path/overlay.png --json
node apps/cli/dist/index.js edit history /path/portrait.opencut.json --json
```

Save this batch to `/path/layers.json` after substituting the asset IDs and revision:

```json
{
  "expectedRevision": 2,
  "label": "Compose portrait layers",
  "operations": [
    { "type": "canvas.set", "backgroundColor": "#183048" },
    {
      "type": "track.add",
      "id": "main-video",
      "name": "Video",
      "mediaType": "video"
    },
    {
      "type": "track.add",
      "id": "image-layer",
      "name": "Overlay",
      "mediaType": "video"
    },
    {
      "type": "clip.add",
      "id": "main-clip",
      "assetId": "VIDEO_ASSET_ID",
      "trackId": "main-video",
      "at": 0,
      "in": 0,
      "out": 90
    },
    {
      "type": "clip.add",
      "id": "image-clip",
      "assetId": "IMAGE_ASSET_ID",
      "trackId": "image-layer",
      "at": 30,
      "in": 0,
      "out": 30,
      "visual": {
        "x": 300,
        "y": -150,
        "scale": 0.3,
        "opacity": 0.75,
        "fit": "contain"
      }
    }
  ]
}
```

```sh
node apps/cli/dist/index.js edit apply /path/portrait.opencut.json /path/layers.json --dry-run --json
node apps/cli/dist/index.js edit apply /path/portrait.opencut.json /path/layers.json --json
node apps/cli/dist/index.js timeline list /path/portrait.opencut.json --json
node apps/cli/dist/index.js project render /path/portrait.opencut.json --output /path/portrait.mp4 --json
node apps/cli/dist/index.js probe /path/portrait.mp4 --json
```

The result is 90 frames at 30 fps: a three-second 1080×1920 video. The image is
above the video only during [1, 2) seconds; its source alpha is multiplied by 0.75.
The main video retains its original audio. Contain fitting leaves the background
visible around landscape footage. Inspect frames before, during and after the
image interval (for example at 0.5, 1.5 and 2.5 seconds) and check the output's
dimensions, frame rate and measured duration.

## Headless media API

Workspace consumers declare `"@opencut/media": "workspace:*"` as a dependency
and build the headless packages before importing it. The package exports
`probeMedia(file)`,
`extractFrame(file, timestampSeconds, output)`, `composeMedia(options)`,
`renderVideoTimeline(options)`, `validateVideoTimeline(options)`,
their TypeScript option/result types, `MediaError` and `RenderCancelledError`.
Timeline preflight and execution share the same plan/media checks. API callers can
select `codec: 'h264' | 'hevc'` and an optional rational `outputFrameRate`; these are
media API controls used by T28, not new CLI flags. See [desktop export](EXPORT.md)
for output-rate rounding, encoder prerequisites and publication behavior.

```ts
import { composeMedia } from '@opencut/media';

const result = await composeMedia({
  clips: ['/path/to/clip1.mp4', '/path/to/clip2.mp4'],
  music: '/path/to/music.wav',
  output: '/path/to/new-composition.mp4',
  width: 640,
  height: 360,
  fps: 30,
  clipVolume: 1,
  musicVolume: 0.25,
});

console.log(result.path, result.durationSeconds, result.metadata);
```

Only `clips`, `music` and `output` are required. Optional fields use the same
defaults and bounds as the CLI options above; CLI `--clip-volume` and
`--music-volume` correspond to API `clipVolume` and `musicVolume`. The returned
`CompositionResult` has the same fields as composition JSON. Tool prerequisites,
timing rules, output protection and filesystem requirements also apply to API
calls. The CLI owns argument parsing, stdout/stderr and exit codes; the media
package runs independently of Electron and React.

## External tools and limits

Put `ffprobe` on PATH to probe; extraction also needs `ffmpeg` with PNG support.
Composition needs FFmpeg with `libx264`, AAC, and the standard scale, pad, fps,
concat, aresample, amix and alimiter filters, including scale's `reset_sar` option
(FFmpeg 8+; validated here with FFmpeg 9).
Install them manually through your preferred package manager. OpenCut does not
install, download or bundle media executables. Project create/info/validate, help/version, ordinary unit tests,
and basic desktop playback do not need them. Independent desktop frame stepping
needs ffprobe for average source FPS; with a project open the player steps at the
project rate and reuses stored import metadata.

Node's built-in `execFile` is sufficient for this small subprocess boundary;
no wrapper dependency or native binding is required. Arguments are passed
without a shell, inputs are resolved to absolute local files, and child stdin
is closed. Probe/extraction subprocesses have a 60-second limit; the composition
encoder has a 10-minute wall-clock limit. ffprobe/encoder stdout and stderr are
bounded to 4 MiB each and PNG/stderr to 64 MiB each. Exceeding a bound is an execution error.
Error-level tool diagnostics fail the command even if the tool exits zero.

The subprocess and JSON behavior follows the official
[Node child-process API](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
and [ffprobe documentation](https://ffmpeg.org/ffprobe.html).

## Verification

`pnpm test` includes standalone project CLI integration tests for creation and
readback, integer/rational frame rates, populated-project statistics, malformed
JSON, unsupported versions, broken internal references and offline media. These
tests run with an empty `PATH` to check independence from media tools. They cover
invalid arguments, repeated-option overrides, literal paths, existing destinations,
symlinks and missing parent directories, and verify that inspection and validation
preserve project and source-file contents. Temporary project JSON and text
sentinels are created in owned OS temporary directories and cleaned up after tests.

`pnpm test` covers metadata normalization, absent streams, command validation,
missing tools, execution failures and output protection without requiring media
tools. For real CLI probing and PNG extraction, generate fixtures if absent, then
run `pnpm test:media`. This explicit native suite requires FFmpeg/ffprobe and the
five generated fixtures; missing prerequisites fail with a nonzero exit. It
compares extracted pixels against an independent timestamp-selected decode,
checks all fixture metadata, exercises delayed video with zero/nonzero input
starts, literal filenames and failure paths, and creates derived delayed-video
inputs and PNG outputs only in its own subdirectory under
`tests/fixtures/generated/`. That subdirectory is cleaned on success or failure;
the five base fixtures are read without modification.

The same command runs T03 integration tests against silent, mono and stereo
clips at different sizes/rates, fractional-rate video with early/delayed 44.1 kHz
audio and nonzero starts, background looping, gain controls and destination safety.
It also checks one-frame 60/120 fps clips converted to 1/30 fps, and PCM music with
80ms/one-second timestamp gaps, including audible content after each gap and a
loop boundary. Decoded tone pulses and video flashes check sync, and source hashes
ensure that the base fixtures remain unchanged. Unit tests also cover failed render cleanup,
metadata verification and destination races without requiring media tools.

T07 unit/CLI tests cover persisted metadata, legacy assets, duplicate identities,
offline/unreadable sources, invalid media, referenced-asset removal, failed atomic
publication, outside edits and competing writers. Directory-symlink regressions
check that import, list, info and validation resolve the same source, including
when a different readable file exists at the misleading lexical location.
Availability tests also preserve checks for project locations whose parent is
absent. Native tests import all five
fixtures through the built CLI, verify stored metadata and stable IDs after
reload, inspect assets after sources disappear, and verify source hashes before
and after import/removal. Native outputs stay in an owned `t07-*` directory under
`tests/fixtures/generated/`, cleaned on success or failure.

T08 unit/CLI tests cover track/clip operations, exact fractional-rate and sample
timing, split source mapping and total duration, exclusive boundaries, same-track
overlap rejection, offline edits, stable IDs, no-op writes and invalid edits that
preserve original bytes. Native tests use imported video/audio/image fixtures,
read back timeline JSON and project data, validate source bounds, and compare
source hashes. Native outputs stay in an owned `t08-*` directory under
`tests/fixtures/generated/`, cleaned on success or failure.

T09 unit/CLI tests cover multi-operation commits, intermediate validation and rollback,
exact undo/redo across reloads, branch invalidation, individual-command history,
dry-run bytes/mtime preservation, stale revisions, simultaneous writers, outside
replacement and failed atomic publication. Sources remain unchanged.

T10 unit/CLI tests cover exact planning, unsupported projects/settings, output protection,
publication races, failed encoding/verification cleanup and missing tools. Native
integration tests render saved fixture projects through the built CLI and independently
probe/decode output. They check order, trim endpoints, split equivalence, leading/interior
black boundaries, mixed source rates, fractional-rate PTS spacing, nonzero source starts,
directory aliases, stale bounds and source/project preservation. Owned `t10-*` native
test directories are cleaned on success or failure. T28 exposes the same headless
renderer through [desktop export controls](EXPORT.md); the existing T03 path-based
composition command remains available.

T11 native integration checks independently decode AAC samples, measure tone
frequencies and amplitude ratios for overlapping sources, gains, muting, silence,
audio tails and gaps. Visual flashes and audio pulses verify trimmed/split sync;
60 one-frame fractional-rate splits, delayed audio and nonzero container starts
cover timing. Fresh audio bounds/missing-stream failures and fixture/project hashes
are checked. Owned `t11-*` directories are cleaned on success or failure.

T12 native integration tests check overlapping videos, track ordering, transforms,
opacity, PNG and video alpha, image duration/splits, background gaps/audio tails,
9:16/16:9/1:1 fitting and non-square source pixels. Independent pixel samples,
frame counts/PTS, codecs, dimensions, SAR and audio amplitude measurements verify
outputs and guard against duplicated audio. CLI/history and invalid settings are
also tested offline. Owned `t12-*` directories are cleaned after each run.

T13 tests cover structured progress chunk boundaries, monotonic percentages/frame
counts, shutdown escalation/timeouts, cancellation before work and during
encoding/verification, output conflicts and verified atomic replacement. Native
fixture checks stream JSONL from actual FFmpeg renders, independently probe/decode
quality/resolution presets, send SIGINT/SIGTERM during live encoding, check child
termination and temporary cleanup, and preserve previous exports after encoding
failure/cancellation. Source/project hashes remain unchanged. Owned `t13-*`
directories are cleaned after each run.

## Complete end-to-end workflow

Run `pnpm e2e --keep` to build and execute the T14 CLI-only 18-second workflow,
retaining a verified MP4, project, representative frames, ffprobe/frame/audio
measurements and CLI process transcript in a unique generated directory. Run
`pnpm test:e2e` for two independent runs with automatic cleanup. Missing fixtures
are generated only when their directory is absent; existing fixtures are validated
and never overwritten. The [Agent Skill](../skills/video-editor/SKILL.md) includes
a shorter [creator workflow](../skills/video-editor/references/workflow.md)
for trim, split, visual overlay and music, plus a 20-second portrait story.

## Preview proxies and cache management (T25)

```sh
node apps/cli/dist/index.js cache status --json
node apps/cli/dist/index.js cache proxy /path/source.mp4 --json
node apps/cli/dist/index.js cache proxy /path/source.mp4 --regenerate --json
node apps/cli/dist/index.js cache frame /path/source.mp4 --timestamp 1.5 --json
node apps/cli/dist/index.js cache configure --disk-mib 2048 --memory-mib 64 --json
node apps/cli/dist/index.js cache cleanup --json
node apps/cli/dist/index.js cache clear --json
```

Every cache command accepts `--directory <dedicated-cache-directory>`;
`OPENCUT_MEDIA_CACHE` overrides the shared default `~/.cache/opencut/media-v1`.
Use `cache --help` for arguments. Status lists derivative identity, source hashes,
limits, encoded PNG memory and actual derivative/staging disk bytes. `frame` returns
a PNG data URL for the frame covering the requested source instant, without writing
a user-selected output. It uses presentation timestamps for CFR/VFR media, rather
than rounding to average FPS or choosing the next frame. Unresolvable timing or
extraction failure exits 1. `proxy` streams existing render-progress events then
`{event:"result",result:{path,proxy,key,reason?}}`.
Unsupported timing returns `proxy:false` and the original path with a reason;
encode/validation failures exit 1. SIGINT/SIGTERM cancel proxy/frame generation
with exit 130/143 after child cleanup. Configure persists limits and evicts old
entries; cleanup removes stale/corrupt/orphaned entries, and clear removes all owned
derivatives. These commands never change project JSON or source media. A missing
source cannot be made available by a proxy. See [the cache contract](MEDIA_CACHE.md).
