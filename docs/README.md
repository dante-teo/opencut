# OpenCut

A lightweight desktop video editor for creators, with a GUI and a scriptable
headless core. **T04 adds an isolated Electron video preview with play/pause, seeking,
nominal frame stepping and reproducible performance measurements.** The independent
CLI supports inspection, frame extraction and the T03 composition spike.
T05 adds a headless [project model and JSON file format](PROJECT_FORMAT.md) with
core APIs for validation, save/load and media availability checks. T06 exposes
project creation, information and validation in the CLI. T07 adds media asset
import, listing, inspection and safe removal. T08 adds shared headless timeline
editing through the CLI: track management and clip add/move/trim/split/remove.
T09 adds [atomic batches, persistent undo/redo, dry-run and revision checks](CLI.md#transactions-undo-and-redo).
T12 extends [saved timeline rendering](CLI.md#project-rendering) to H.264/AAC MP4 with ordered video/image layers, position/scale/opacity, canvas fitting/background, portrait/square output, and the existing original/multi-track audio mix and exact project-frame timing.
T13 adds structured JSONL progress, SIGINT/SIGTERM cancellation, quality/resolution presets and explicit atomic export replacement.
T14 adds a repeatable [CLI-only end-to-end workflow](../skills/video-editor/references/workflow.md)
covering creation, imports, edits, layers, mixed audio, history and verified 18-second export.
T15 connects the desktop to the shared core for project creation, opening, saving,
and read-only metadata, asset and timeline inspection.
T16 connects imported video selection to a reusable source player with keyboard
transport, project-rate timecode and explicit playback cleanup.
T17 adds a zoomable, scrollable read-only timeline with an independent playhead
and explicit links to source preview.

## Quick start (macOS)

Run the commands below from the repository root.

Use Node **24.12+ within the 24.x line** and **pnpm 11.20.0** (pinned in
`packageManager`). Install these prerequisites manually if needed.

```sh
pnpm install
pnpm dev
```

The second command builds the workspace packages and opens the Electron window.
Electron downloads its development binary on first launch, requiring network access.
Quit the app and press Ctrl-C in the terminal to stop the dev server.
FFmpeg is optional and is not needed for either command.

The desktop follows the system light/dark appearance, including changes while
running. On macOS it uses a normal resizable window with native window buttons
and a hidden title bar. Drag the header, including the space above the logo,
to move the window.

Use **New project** to enter a name, width, height and integer or rational frame
rate (for example, `30000/1001`). **Create project** opens an unsaved project;
**Save project** chooses a new `.opencut.json` file in an existing directory.
Existing files and symlinks are refused for new projects, even if the native
save dialog offers replacement. **Open project** reads the same JSON files as
the CLI. **Save project** on an existing project uses the core's lock, revision
check and atomic update; saving unchanged content preserves timestamps and history.
External changes are refused: reopen the project to refresh before saving.

Project metadata/settings, imported assets (including missing-media warnings),
and video/audio tracks and clips appear in a docked editor workspace: media
library on the left, viewer in the center, inspector on the right, and a timeline
below. Select an asset or clip to inspect its stored details. Timeline blocks
show relative positions and durations; this view is read only. Source ranges
and timeline starts retain exact rational seconds. Use the CLI for imports and
edits, then reopen the project to refresh; there is no automatic file watching.
Project management needs no FFmpeg or ffprobe. Closing, quitting, creating or
opening another project offers **Save**, **Discard**, and **Cancel** when the
current project is unsaved. Canceled dialogs and failed saves preserve it; failed
opens leave the current project displayed. Operations run one at a time, with
loading indicators and errors shown in the workspace. Only newly created projects
can be dirty in T15 because loaded settings, assets and timelines are read only.
There is no Save As, project playback, GUI import/editing or render control.

The timeline preserves project track order, with separate video/audio styling.
Gaps and overlaps across tracks follow stored rational timing. Select a clip for
inspection; selection leaves the playhead unchanged. Click/drag the ruler to seek,
or focus it and use Left/Right (one project frame) and Home/End. The timeline clock
uses exact project-frame non-drop labels, including `30000/1001`. Choose **Zoom**
or use +/− to zoom around the viewport center. Ctrl/Command + wheel zooms around
the pointer. Use horizontal/vertical scrolling to reach distant clips and tracks.
Zoom and scroll survive selection, playback and saving; replacing/reopening the
project resets view state. Clips and tracks outside the viewport are culled.
Ruler ticks support valid rational rates even when their frame times exceed JSON
integer limits. In that case, playhead seeks and preview positions use a bounded
rational approximation; extreme rates or positions can skip frame labels.
See the [exact-time contract](PROJECT_FORMAT.md#exact-time) for the distinction
between transient UI positions and persisted project timing.

Select a video clip and click **Preview selected clip** to link source playback.
This explicit action sets the playhead to the clip start and opens its source-in.
Ruler seeks within the linked clip seek the matching source time. Source playback
updates the playhead, clamped to the clip range, while the source transport retains
its full-source bounds. Selecting another clip only changes the inspector; the
source link stays with the explicitly previewed clip. Seeking outside the linked
range switches to Project viewer and pauses/unlinks the source. Library selection
and **Open video** also unlink. Audio/image clips have no linked source preview;
there is no automatic playback across clips, timeline mixing or compositing.
Very long timelines use a proportional scrollbar to stay within browser layout
limits; scrollbar precision becomes coarser at extreme durations.

Known limitation: after repeated ruler seeks, pressing **Play** can intermittently
leave the linked source paused, with its source clock and the timeline playhead
remaining fixed.

The **Project viewer** tab shows the canvas placeholder. Select an imported video
in the media library to open **Source preview** automatically, or use **Open video**
for a local file. Import assets with the CLI and reopen the project to refresh the
library. Play/Pause, the Seek slider and Previous/Next frame operate on one source.
Imported video preview reuses the metadata saved at import and needs no new
ffprobe call. Selecting an asset checks that its file is still readable; reopening
a project refreshes availability, without refreshing stored codec/FPS metadata.
The preview scales to fit while preserving the video's aspect ratio.
Focus the player region for Space/K (play/pause), Left/Right or comma/period
(step), and Home/End (start/end). Inputs and buttons retain their own keyboard
behavior. Changing viewer tabs pauses playback.

Time and duration are seconds; Presented is the last compositor frame PTS.
With a project open, Frame is the zero-based project-clock position and timecode
uses project FPS with nominal non-drop labels (including fractional rates).
For example, at `30000/1001` fps, `00:01:00:00` labels frame 1800 at 60.06 seconds.
Stepping seeks by one project frame interval. Outside a project, frame numbers
and steps use average source FPS from optional `ffprobe`; without it, playback
and timestamp seeking still work but stepping/timecode are unavailable.
HTML video seeks are best effort: VFR, source/project rate differences, stream
offsets and codec support can repeat or skip decoded frames. Nominal frame
positions and timecode do not establish frame-accurate seeking or source frame IDs.
Imported assets use the browser's duration as the seek bound. When audio extends
beyond the video stream, the clock can continue over the final picture; Presented
can remain at the last video timestamp while the nominal project frame advances.
Dragging the seek slider stages a target and seeks when released; keyboard changes
seek immediately. **Open video** disables the current player's controls during
selection/probing, and stays disabled during a seek, drag or performance validation.
Library selection can replace a busy player and cancels its pending work.
Unsupported codecs show
a decode error; missing files and non-video selections show an error and can be
reselected after repair, including clicking the same asset again to retry.
Asset replacement pauses/unloads the old element and revokes its media URL. Closing or
replacing a project clears the player. Preview state is transient and does not
modify the project or source files. This is source playback; it does not composite
timeline tracks or implement editing/render controls.

**Run performance validation** runs a positioning seek, three warm-up seeks,
30 fixed target seeks, then up to eight seconds of playback. Keep the window visible.
Open **Details & measurements** after validation for median/p95 seek latency,
dropped frames and expandable measurement JSON. **Details & shortcuts** also
explains keyboard controls and preview precision limits.
For the reproducible fixture/1080p suite, run `pnpm test:preview` after generating
fixtures. It uses FFmpeg/ffprobe already on PATH, creates and cleans only an owned
`tests/fixtures/generated/t04-*` directory, and writes environment, raw samples,
source hashes, metadata and screenshots under ignored `test-results/preview-performance/`.
It tests the production build and native picker IPC (stubbing only the dialog result).
The shell/security checks run without fixtures or media tools. Fixture-backed
playback, dragging and import/validation regressions need the generated fixture
set and `ffprobe` on PATH for nominal frame assertions; they skip when the base
video fixture is absent. A separate case deliberately removes ffprobe from the
app's PATH to verify basic playback and timestamp seeking without it.
See [the preview architecture decision](adr/0003-html-video-preview.md) for the
measurement definitions, findings, recommendation and accuracy limits.

To use the CLI independently:

```sh
pnpm build
pnpm cli --help
pnpm cli --version
# Direct executable entry point, without pnpm log output:
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js project create /path/to/new.opencut.json --name "My project" --fps 30000/1001 --json
node apps/cli/dist/index.js project info /path/to/new.opencut.json --json
node apps/cli/dist/index.js project validate /path/to/new.opencut.json --json
node apps/cli/dist/index.js media import /path/to/new.opencut.json /path/to/video.mp4 --json
node apps/cli/dist/index.js media list /path/to/new.opencut.json --json
node apps/cli/dist/index.js media info /path/to/new.opencut.json ASSET_ID --json
node apps/cli/dist/index.js media remove /path/to/new.opencut.json ASSET_ID --json
node apps/cli/dist/index.js probe /path/to/video.mp4 --json
node apps/cli/dist/index.js extract-frame /path/to/video.mp4 --timestamp 0.5 --output /path/to/new-frame.png --json
node apps/cli/dist/index.js compose /path/to/clip1.mp4 /path/to/clip2.mp4 --music /path/to/music.wav --output /path/to/new-composition.mp4 --json
```

Replace `ASSET_ID` with the stable `asset.id` returned by import or shown in
`media list`. Import returns `imported: false` and the existing ID for a duplicate.
Directory symlinks are supported: media references resolve from the physical
project directory. Updates require the project file itself to be a regular file
with one hard link. See [asset paths and results](CLI.md#project-media-assets).

To build only the headless packages and CLI, use `pnpm build:packages` followed
by `pnpm --filter @opencut/cli build` instead of the full workspace build.

Project create/info/validate, media list/info/remove and timeline edits need no media tools.
See [timeline editing](CLI.md#timeline-editing) for commands, exact project-frame
indices, overlap rules and JSON results.
Project creation refuses existing files; media import/remove atomically update
existing projects. Imports reference original files and preserve source contents;
removal affects only unreferenced asset entries. Import/probe require manually
installed `ffprobe` on PATH; extraction also
requires `ffmpeg` with PNG support. Composition needs FFmpeg 8+ with libx264/AAC
and standard filters. Existing output files are refused. See
[CLI.md](CLI.md) for fields, timestamp behavior, limits and exit codes.

## Commands

| Command                                  | Purpose                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install`                           | Install and link workspace dependencies                                                      |
| `pnpm dev` / `pnpm dev:desktop`          | Build internal packages, run the desktop dev server, open Electron                           |
| `pnpm dev:cli --help`                    | Run the TypeScript CLI without launching Electron                                            |
| `pnpm cli --help` / `pnpm cli --version` | Run the built CLI (build first)                                                              |
| `pnpm build`                             | Build libraries, CLI and Electron main/preload/React assets in dependency order              |
| `pnpm typecheck`                         | Build library declarations and strictly check all source, scripts and tests                  |
| `pnpm lint`                              | Run ESLint                                                                                   |
| `pnpm format` / `pnpm format:check`      | Apply / check Prettier formatting                                                            |
| `pnpm test`                              | Build prerequisites and run headless unit + CLI/fixture-contract tests                       |
| `pnpm test:desktop`                      | Build and check projects, IPC security, appearance, reopening and available fixture playback |
| `pnpm test:preview`                      | Build and measure real Electron playback/seek performance (FFmpeg + ffprobe + fixtures)      |
| `pnpm test:fixtures`                     | Run the optional native intact/truncated-media regression (FFmpeg + ffprobe)                 |
| `pnpm e2e --keep`                        | Build and run the complete 18-second CLI workflow; retain verified MP4 and evidence          |
| `pnpm test:e2e`                          | Run the CLI-only workflow twice and clean per-run artifacts (FFmpeg + ffprobe)               |
| `pnpm test:media`                        | Build and test real media CLI against existing generated fixtures (FFmpeg + ffprobe)         |
| `pnpm fixtures:generate`                 | Generate and validate five small synthetic media files (optional FFmpeg + ffprobe)           |
| `pnpm fixtures:validate`                 | Decode generated media and check metadata/readable video frame counts (ffprobe)              |

`build` emits development-ready production assets, not a signed `.app`, DMG,
or installer. `test:desktop` needs a graphical desktop session but no downloaded
Playwright browser. Project regressions cover GUI/CLI file compatibility, offline
assets, invalid files, stale saves, unsaved-close/quit choices, loading states and
IPC rejection from another window. They exercise the production preload and main
handlers with native dialog results stubbed; real native dialog interaction is a
separate manual check. Screenshots are saved under the ignored `test-results/`
directory. Preview regressions cover pointer dragging and release outside the
slider, immediate keyboard seeks, and a gated import followed by validation of
the replacement source. Imported-asset checks cover differing source/project FPS,
scoped shortcuts, video/transport visibility, busy-player replacement, media URL
revocation, unchanged project/source bytes, and recovery after missing/corrupt
media. They also verify preview with ffprobe absent from the Electron app's PATH,
using metadata imported before launch. The drag test window ignores physical mouse input to
avoid interference from activity on the shared desktop. Performance
measurements are separate in `pnpm test:preview`; desktop correctness checks do
not impose hardware-dependent latency thresholds.

`pnpm e2e --keep` builds and validates the complete T14 workflow, creating fixtures
only when their generated directory is absent. Existing fixtures must pass validation.
It retains successful output/evidence in a unique `tests/fixtures/generated/t14-e2e-*`
directory; omit `--keep` to clean it. `pnpm test:e2e` runs twice from fresh projects
and verifies cleanup. Every project operation runs through a separate public CLI
process. See the [official workflow](../skills/video-editor/references/workflow.md)
for commands, expected timing and independent frame/audio checks.

`pnpm test` runs the headless suite with Vitest and needs no native media tools.
`pnpm test:fixtures` runs the separate Node native regression with FFmpeg and
ffprobe, generating temporary media rather than depending on existing fixtures.
`pnpm test:media` requires all five existing generated fixtures and exercises the
built CLI, including video/audio/image asset import, composition, decoded A/V
sync, delayed streams and saved-timeline rendering. Render checks cover clip order,
trims/splits, black/silent gaps, overlapping tones, volume/mute, A/V markers,
delayed audio, fractional frame timing and source preservation. T13 checks also
cover JSONL progress, exact preset dimensions, SIGINT/SIGTERM child termination,
temporary cleanup and safe export replacement. The suite creates and cleans only
its own derived inputs and outputs under the generated directory.
`pnpm fixtures:validate` only needs ffprobe: it counts decoded video frames and
rejects decoder errors, even when a damaged file retains valid header metadata.
See the [fixture contract](../tests/fixtures/README.md) for prerequisites and safe
regeneration.

## Structure

```text
apps/
  desktop/             Electron main + sandboxed preload + React renderer
  cli/                 Standalone Node CLI
packages/
  core/                Headless project model, persistence, assets, timeline editing and render planning
  media/               Headless probing, frame extraction, composition and timeline encoding
  shared/              Reserved home for genuinely shared utilities/types
skills/video-editor/   Product Agent Skill and its current CLI reference
tests/
  fixtures/            Expected metadata and fixture documentation
  integration/         Headless CLI/fixture-contract tests and opt-in native media tests
  e2e/                 Repeatable public-CLI editing/export workflow test
  desktop/             Electron integration and opt-in playback performance tests
scripts/               Optional fixture generation/validation and CLI E2E tooling (TypeScript)
docs/                  Product, architecture and architectural decisions (adr/)
```

Read [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[PROJECT_FORMAT.md](PROJECT_FORMAT.md),
[AGENTS.md](../AGENTS.md), and the [fixture contract](../tests/fixtures/README.md).
The official [Agent Skill](../skills/video-editor/SKILL.md) documents working CLI
capabilities and links to the core API contract. It is distinct from repository
coding instructions.
