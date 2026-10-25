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
T11 extends [saved timeline rendering](CLI.md#project-rendering) to H.264/AAC MP4 with original audio, multiple audio tracks, overlap mixing, clip gain/mute, exact project-frame video timing and black/silent gaps.
Desktop project integration remains deferred.

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

Use **Open video** in the desktop to choose a local file. Play/Pause, the Seek
slider and Previous/Next frame operate on that source without modifying it.
The timestamp distinguishes the playback clock from the last compositor frame PTS;
frame numbers are zero based and nominal. Frame stepping requires optional `ffprobe`
on PATH to obtain average FPS. Playback and timestamp seeking work without it.
Dragging the seek slider stages a target and seeks when released; keyboard changes
seek immediately. Importing a replacement disables the current player's controls,
and importing and performance validation run exclusively. Unsupported codecs show
a decode error. The desktop has no timeline or project integration.

**Run performance validation** runs a positioning seek, three warm-up seeks,
30 fixed target seeks, then up to eight seconds of playback. Keep the window visible.
The UI shows median/p95 seek latency, dropped frames and expandable measurement JSON.
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
| `pnpm test:desktop`                      | Build and check shell security, appearance, reopening and available fixture playback    |
| `pnpm test:preview`                      | Build and measure real Electron playback/seek performance (FFmpeg + ffprobe + fixtures) |
| `pnpm test:fixtures`                     | Run the optional native intact/truncated-media regression (FFmpeg + ffprobe)            |
| `pnpm test:media`                        | Build and test real media CLI against existing generated fixtures (FFmpeg + ffprobe)    |
| `pnpm fixtures:generate`                 | Generate and validate five small synthetic media files (optional FFmpeg + ffprobe)      |
| `pnpm fixtures:validate`                 | Decode generated media and check metadata/readable video frame counts (ffprobe)         |

`build` emits development-ready production assets, not a signed `.app`, DMG,
or installer. `test:desktop` needs a graphical desktop session but no downloaded
Playwright browser; it also checks the typed core bridge and saves screenshots
under the ignored `test-results/` directory. The interaction regressions use
native pointer movement and release outside the slider, immediate keyboard seeks,
and a gated import followed by validation of the replacement source. Performance
measurements are separate in `pnpm test:preview`; desktop correctness checks do
not impose hardware-dependent latency thresholds.

`pnpm test` runs the headless suite with Vitest and needs no native media tools.
`pnpm test:fixtures` runs the separate Node native regression with FFmpeg and
ffprobe, generating temporary media rather than depending on existing fixtures.
`pnpm test:media` requires all five existing generated fixtures and exercises the
built CLI, including video/audio/image asset import, composition, decoded A/V
sync, delayed streams and saved-timeline rendering. Render checks cover clip order,
trims/splits, black/silent gaps, overlapping tones, volume/mute, A/V markers,
delayed audio, fractional frame timing and source preservation. It creates
and cleans only its own derived inputs and outputs under the generated directory.
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
  desktop/             Electron integration and opt-in playback performance tests
scripts/               Optional fixture tooling (TypeScript)
docs/                  Product, architecture and architectural decisions (adr/)
```

Read [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[PROJECT_FORMAT.md](PROJECT_FORMAT.md),
[AGENTS.md](../AGENTS.md), and the [fixture contract](../tests/fixtures/README.md).
The official [Agent Skill](../skills/video-editor/SKILL.md) documents working CLI
capabilities and links to the core API contract. It is distinct from repository
coding instructions.
