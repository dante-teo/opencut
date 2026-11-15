# OpenCut

A local video editor for [video as code](VIDEO_DEFINITIONS.md), with a
headless core and an Electron review and export app. The milestones below describe the earlier development of OpenCut.

**T04 added an isolated Electron video preview with play/pause, seeking,
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
T18 adds shared-core timeline move, edge trim, split, delete, snapping and persistent undo/redo.
T19 adds multi-file media import, Finder drops, library thumbnails, source selection,
unused-asset removal and dragging assets onto the timeline.
T20 adds contextual clip properties, frame-based numeric timing, audio and visual
controls, workspace shortcuts and shared undo/redo selection restoration.
T23 adds [headless timeline evaluation](TIMELINE_EVALUATION.md): exact source times,
ordered layers, audio mixing candidates and gap/boundary queries. Export planning
shares its timing and property resolution. T24 adds [edited timeline playback](TIMELINE_PLAYBACK.md)
with cuts, gaps, trims/splits, overlapping audio, clip gain/mute and diagnostics.
T25 adds [verified preview proxies and bounded caches](MEDIA_CACHE.md), GUI/CLI cache controls,
and `pnpm benchmark:t25` for reproducible 1080p/4K comparisons.
T26 composites overlapping video/image layers in Project viewer with shared
preview/export transforms, fitting, ordering, alpha and background rules.
`pnpm benchmark:t26` measures mixed-resolution multi-layer playback.
T27 adds the [preview/export consistency gate](PREVIEW_EXPORT_CONSISTENCY.md),
checking actual Chromium Canvas frames, source-frame identity, audio timing and
muxed timestamps against the headless export.

T28 adds [desktop video export](EXPORT.md): native output selection, presets,
resolution/FPS/codec/quality controls, preflight validation, progress and cancellation.
Exports capture an immutable revision, use original media, and publish only verified
complete files without overwriting existing destinations. Hide the panel to keep reviewing.

T29 adds [agent discovery and headless visual inspection](CLI.md#agent-discovery-and-visual-inspection-t29):
`help --json`, revision-tagged project inspection, exact frame-based timeline
inspection, composited PNGs, labeled contact sheets and short preview clips with
mixed audio. Previews use the existing original-media export compositor without
launching Electron and preserve the project and source media. Clips are limited
to 30 seconds and sheets to 16 samples; existing export limits still apply.

T30 adds the [TypeScript workspace SDK](SDK.md) and
[`opencut run`](CLI.md#typescript-scripts-and-sdk-t30) for trusted local scripts.
Scripts can stage edits, inspect and render them, and publish the edits as a
single undo step while Electron reviews the project.

T31 delivers the portable [OpenCut Agent Skill](../skills/video-editor/SKILL.md)
and [black-box agent validation](#external-agent-validation). The Skill uses
only the public CLI and TypeScript SDK.

T32 adds [timeline filmstrips and waveforms](TIMELINE_PLAYBACK.md#timeline-clip-artwork).
T33 adds [editable text layers](PRODUCT.md#text-layers-t33) with shared typography
in the Project viewer, CLI previews, and exports.
T34 adds [editable subtitles](PRODUCT.md#editable-subtitles-t34) with exact cue
timing, shared styles, SRT/WebVTT import and export, and optional MP4 burn-in.
T35 adds [audio fades, track controls, and stereo peak meters](TIMELINE_PLAYBACK.md#audio-editing-and-meters).
T36 adds [constant clip playback speed and time remapping](TIMELINE_PLAYBACK.md#playback-speed-t36).
T37 adds [clip keyframe animation](PRODUCT.md#keyframe-animation-t37).
T38 adds [video cross-dissolves and canvas fades](TIMELINE_PLAYBACK.md#video-transitions-t38).
T39 adds [group timeline editing](TIMELINE_EDITING.md), including multi-clip
selection, a project clipboard, ripple delete, insert edits, gap closing,
track locks, and marker snapping.
T40 documents the public CLI and SDK editing paths in the
[headless capability matrix](HEADLESS_CAPABILITIES.md), including online media
search and import.

T41 makes Electron a read-only review and export app. Create and edit projects
with the CLI or SDK. Open a saved project in Electron to inspect its revision,
play the timeline, compare it with its source or rendered preview, and export
the selected revision.

T42 adds [system diagnostics](CLI.md#system-diagnostics) and records the
[Apple Silicon video effects decision](adr/0017-apple-silicon-video-effects-gate.md).
The benchmark prototypes are isolated from project editing and export.

T43 adds [durable local jobs](JOBS.md). Submit, inspect, cancel or retry a
background render through the CLI and SDK without keeping the submitting
process alive.

T44 compiles whole-video TypeScript and JSON definitions to in-memory projects.
Use the [executable showcase](VIDEO_DEFINITIONS.md#run-the-example) to validate,
inspect, preview and render directly from a definition. T45 adds full project
composition semantics and [saved-project conversion](VIDEO_DEFINITIONS.md#convert-a-saved-project).
T46 adds [watched definition previews](VIDEO_DEFINITIONS.md#inspect-preview-and-render)
in the CLI, SDK and Electron, plus frame, contact sheet and short clip exports
from definitions.

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

The desktop uses a violet-accented studio layout and follows the system light/dark appearance, including changes while
running. On macOS it uses a normal resizable window with native window buttons
and a hidden title bar. Drag the header, including the space above the logo,
to move the window.

Open a saved project with **Open project**. The toolbar shows the revision in
view. CLI or SDK commits refresh the timeline automatically. Use **Open project**
again to load a backup or replacement that reuses the same revision, goes back
to an older revision, or has a different project ID. If OpenCut cannot read the
replacement, the viewer keeps the last valid project open.

The media library shows imported files and availability. Select an asset for
source playback or a timeline item for details. **Preview selected clip** links
a timed clip on a video track to the source player. Open audio and still images
from the media library. Use the ruler or timeline slider to seek. Space toggles
playback and Left/Right step frames outside native controls.
The timeline keeps its scroll and zoom on revision updates. Its filmstrips and
waveforms show the original source samples within each clip's trimmed range.

Use **Render full timeline** to compare with the cached FFmpeg preview.
The viewer resets the preview when it accepts a new revision.
**Export** opens the MP4 settings and job progress. A running job retains its
starting revision while the viewer follows new commits. **More export options**
provides project snapshots, packages and subtitle exports when available.
See [desktop export](EXPORT.md) and [desktop control](CLI.md#rendered-preview-and-desktop-control).

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

Start agent workflows with `node apps/cli/dist/index.js help --json`, then use
`project inspect PROJECT --json` and `timeline inspect PROJECT --frame N --json`
to choose exact project-frame positions. Generate a frame, sheet or short clip
with `preview frame|contact-sheet|clip`; see [CLI inspection](CLI.md#agent-discovery-and-visual-inspection-t29)
for explicit output paths, ranges, quality, JSON schemas and limits. Inspection
works offline; visual previews need FFmpeg and ffprobe.

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

## Personal media projects

Keep personal footage and demo projects in a separate workspace outside
`tests/fixtures/generated/`; automated tests use synthetic fixtures. Saved projects
reference media files rather than embedding them, so keep their referenced assets
with the project when moving or sharing it. An exported MP4 is self-contained.

For editing screen recordings into portrait or landscape videos, follow the
[screen-recording adaptation](../skills/video-editor/references/workflow.md#screen-recordings-and-personal-footage).
It covers shot selection across the recording, external media preparation,
framing checks and delivery verification.

## Commands

| Command                                  | Purpose                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm install`                           | Install and link workspace dependencies                                                 |
| `pnpm dev` / `pnpm dev:desktop`          | Build internal packages, run the desktop dev server, open Electron                      |
| `pnpm dev:cli --help`                    | Run the TypeScript CLI without launching Electron                                       |
| `pnpm cli --help` / `pnpm cli --version` | Run the built CLI (build first)                                                         |
| `pnpm build`                             | Build libraries, CLI and Electron main/preload/React assets in dependency order         |
| `pnpm typecheck`                         | Build library declarations and strictly check all source, scripts and tests             |
| `pnpm lint`                              | Run ESLint                                                                              |
| `pnpm format` / `pnpm format:check`      | Apply / check Prettier formatting                                                       |
| `pnpm test`                              | Build prerequisites and run headless unit + CLI/fixture-contract tests                  |
| `pnpm test:desktop`                      | Build and check projects, GUI exports, IPC security, appearance and fixture playback    |
| `pnpm test:preview`                      | Build and measure real Electron playback/seek performance (FFmpeg + ffprobe + fixtures) |
| `pnpm benchmark:t25`                     | Compare original/proxy 1080p and 4K playback on generated media                         |
| `pnpm benchmark:t26`                     | Measure overlapping video/image playback, seeks, CPU and memory in Electron             |
| `pnpm test:fixtures`                     | Run the optional native intact/truncated-media regression (FFmpeg + ffprobe)            |
| `pnpm e2e --keep`                        | Build and run the complete 18-second CLI workflow; retain verified MP4 and evidence     |
| `pnpm test:e2e`                          | Run CLI repeatability and deployed CLI/SDK black-box tests (FFmpeg + ffprobe)           |
| `pnpm test:media`                        | Build and test real media CLI against existing generated fixtures (FFmpeg + ffprobe)    |
| `pnpm fixtures:generate`                 | Generate and validate five small synthetic media files (optional FFmpeg + ffprobe)      |
| `pnpm fixtures:validate`                 | Decode generated media and check metadata/readable video frame counts (ffprobe)         |

`build` emits development-ready production assets, not a signed `.app`, DMG,
or installer. The Electron suites use hidden, muted windows by default and
require a graphical desktop session. Set `OPENCUT_DESKTOP_TEST_VISIBLE=1`
when running `pnpm test:desktop` to show the windows for debugging. The full
desktop suite requires FFmpeg/ffprobe with lavfi, libx264, libx265, libvpx-vp9,
PNG and AAC support. The suite uses the project's Electron executable.

Project regressions cover opening headless projects in Electron, offline assets,
invalid files and IPC rejection from another window. T28 export checks cover original-media snapshots
with active proxies and concurrent edits, metadata/presets/output FPS/HEVC, missing
media/tools, output conflicts, cancellation, failure recovery and shutdown cleanup.
A restoration regression checks fresh output selection after renderer reload and
macOS window recreation, canceled pickers and preservation of the prior export.
These tests exercise the production preload and main handlers with native dialog
results stubbed. Library regressions exercise CLI imports, search and filtering,
source playback, and refresh after headless undo and redo. Timeline regressions
cover linked video seeking and verify that audio tracks and stills cannot start
a linked preview.
T24–T26 checks cover multi-layer preview, proxy fallback/budgets, rapid seeks,
visual property edits with undo/redo, preview/export frame comparisons and audio
pulse/flash synchronization. See [the playback contract](TIMELINE_PLAYBACK.md)
for coverage, tolerances and benchmark definitions. T27 adds the
[preview/export consistency gate](PREVIEW_EXPORT_CONSISTENCY.md), also runnable
with `pnpm test:consistency`, with full-frame metrics, diffs and independent
source-frame and audio checks.
The T41 review and export tests exercise revision refresh after CLI commits,
revocation of older previews, read-only timeline inspection, export isolation
during headless edits, and continued CLI editing after Electron is killed.
Integration tests cover reopening older backups, socket setup failure and
registration after another viewer closes, and requests from a previous view.
The audio regression additionally runs the development renderer with StrictMode
replay and verifies playback, pausing when hidden, unloading on replacement, and
reselection. It needs port 5173 free and cleans its Vite cache from an owned
generated-fixture directory. Screenshots are saved under the ignored
`test-results/` directory. Preview regressions cover pointer dragging and release outside the
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
directory; omit `--keep` to clean it. `pnpm test:e2e` runs the T14 workflow twice
from fresh projects and verifies cleanup. Every project operation runs through
a separate public CLI process. See the [end-to-end workflow](CLI.md#complete-end-to-end-workflow)
for the commands and the [creator workflows](../skills/video-editor/references/workflow.md)
for a shorter rough cut.

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
its own derived inputs and outputs under the generated directory. T29 checks
also decode composited frames and sheet tiles, verify preview-clip audio/video
PTS at integer/fractional rates, and check source/project preservation, invalid
requests and cancellation cleanup. Headless CLI regressions cover discovery,
offline inspection and global options between the command group and action.
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
  e2e/                 Public CLI and SDK editing/export tests
  desktop/             Electron integration and opt-in playback performance tests
scripts/               Optional fixture generation/validation and CLI E2E tooling (TypeScript)
docs/                  Product, architecture and architectural decisions (adr/)
```

Read [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[PROJECT_FORMAT.md](PROJECT_FORMAT.md), [TIMELINE_EVALUATION.md](TIMELINE_EVALUATION.md),
[AGENTS.md](../AGENTS.md), and the [fixture contract](../tests/fixtures/README.md).
The official [Agent Skill](../skills/video-editor/SKILL.md) documents the public CLI
and SDK with references that travel with the Skill directory.

## External agent validation

Run `pnpm test:e2e` after installing workspace dependencies and putting
FFmpeg 8+ and ffprobe on PATH. The T31 workflows need H.264 encoding through
`libx264`, AAC, and PNG support. The suite builds the CLI and SDK, then uses
offline pnpm deploy to stage their production dependencies. The deployed
test processes reject Node modules that resolve outside the staged workspace,
so a checkout dependency cannot mask a missing deployment dependency.

The T31 tests generate three synthetic inputs per run. They exercise the Skill's
CLI batch, a standalone TypeScript consumer, and the documented SDK and script
runner examples. Checks cover rollback, stale revisions, source hashes,
overlay placement in the preview and export, and decoded video and audio.
Use a separate live session to evaluate how an agent discovers and uses the
interfaces.

### Prepare a live session

Run these commands from the checkout root. On a clean checkout, `prepare`
initializes the shared fixtures before staging the agent workspace. It reuses
an existing fixture directory and keeps the agent's inputs in a separate
`t31-agent-*` subdirectory.

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
WORKSPACE=$(pnpm exec tsx tests/e2e/agent-workspace.ts prepare)
printf '%s\n' "$WORKSPACE"
```

Give the agent access to that directory alone in an isolated environment.
Mount `media/` read-only where supported. Move the workspace before the agent
creates the project if needed, then set `WORKSPACE` to its new absolute path.
The workspace includes `video-editor/SKILL.md`, the `./opencut` CLI, public
SDK declarations and package entry, and three generated sources. Use a prompt
such as:

> Use the OpenCut Skill and public CLI help. Deliver `cut.opencut.json` and
> `final.mp4` at 160×90 and 30 fps, 60 frames total. Trim `media/camera.mp4`
> to source frames 15 through 74, split at timeline frame 30 and keep both
> halves continuous. Overlay `media/logo.png` on a higher track, centered at
> scale 0.25, during frames 15 through 44. Mix `media/music.wav` at gain 0.25
> for the full cut. Dry-run and commit an atomic edit. Demonstrate a rejected
> edit that preserves the project. Generate the project-size `review.png`
> at frame 30 and open it with an image tool. Export, probe and fully decode
> the video. Preserve inputs. Use CLI editing only, with no application source
> or direct project JSON edits.

To evaluate the standalone SDK, repeat in a fresh workspace and ask the agent
to perform project creation, edits and rendering from a TypeScript script
importing only `@opencut/sdk`. Public CLI discovery and independent media
verification can still be used.

### Verify the delivery

After the agent exits, run the verifier from the checkout root.

```sh
pnpm exec tsx tests/e2e/agent-workspace.ts verify "$WORKSPACE"
```

The verifier uses the checkout-built CLI and local media tools. It passes the
agent's project and media as absolute paths and checks the timeline, centered
logo in the PNG and MP4, decoded frame count, and audio mix. Review the agent
transcript separately for visual review, public-interface use, dry-run, and
recovery. Compare the source hashes with their pre-run values. When finished,
remove only the owned agent workspace and keep the shared fixtures available.

## T21 architecture and playback baseline

T22's current [shared-session contract](CLI.md#shared-projects-in-electron-t22)
adds single-writer ownership, shared GUI/CLI revisions and history, and crash
recovery. Named projects save accepted edits automatically. Unix sessions use a
private local socket and an OS-backed lock; Windows transport is not implemented.
Never delete the permanent `.opencut-lock` sidecar. See [ADR 0011](adr/0011-shared-project-session.md).

See the [capability audit and benchmark protocol](T21_ARCHITECTURE_AUDIT.md).
`pnpm audit:t21` creates isolated synthetic projects and records actual source
playback, decoder-cold/warm seeking, process metrics and offline export measurements.
`pnpm audit:t21 --headless` retains project/export checks when desktop measurement
is unavailable. Neither mode claims live edited-timeline playback.
