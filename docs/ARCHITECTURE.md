# Architecture

## Workspace boundaries

| Package            | Owns                                                                     | Actual dependencies                                       |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `@opencut/desktop` | Electron lifecycle, restricted IPC, React source preview                 | core, media, Electron, React, range-parser                |
| `@opencut/cli`     | Argument parsing, stdout/stderr and exit codes                           | core, media, Node built-ins                               |
| `@opencut/core`    | Headless identity, project model, persistence, assets and timeline edits | Zod; media and Node built-ins in optional `/node` adapter |
| `@opencut/media`   | Probing, frame extraction and composition through external tools         | Node built-ins                                            |
| `@opencut/shared`  | Reserved location for utilities/types used by multiple packages          | none                                                      |

Actual runtime dependency direction is `desktop → core ← cli`, with desktop main,
CLI and the core Node adapter depending on media. The rationale is
recorded in [ADR 0001](adr/0001-shared-headless-core.md). Core never
imports Electron, React, CLI or desktop code. Media is headless and shared
remains reserved: add APIs and dependencies only when a real task needs them.
The root uses core as a development dependency to test built workspace imports.
All workspace dependencies use `workspace:*`; package exports point to built
JavaScript and declarations rather than TypeScript path aliases.

## Shared headless core

`getApplicationInfo()` provides a small, usable integration proof. CLI imports it
directly. Desktop main imports it and answers the renderer's narrow read-only IPC
request. React holds only view state for that response; it owns no editing state.
Future GUI actions, CLI commands and scripts must execute the same core editing
operations. T05 adds a versioned project model and persistence; T08 implements
pure timeline operations shared by CLI and future GUI callers. A command bus remains deferred.
The application version is currently returned by core and kept aligned with the
workspace manifests; release/version automation is deferred.

Core owns project intent and data validation. A media engine performs probing,
decoding, playback and encoding. T02 uses external ffprobe for metadata and FFmpeg
for single-frame PNG extraction in media. T03 adds `composeMedia(options)` in
media as a technical spike, called directly by the CLI alongside inspection and
extraction. T04 adds isolated HTML video playback in desktop. The T05 model stores
intent without executing edits or connecting to these media/preview prototypes.
Future engine hosting and core coordination remain open decisions. This scoped
FFmpeg use does not select the eventual playback/render backend.
The scoped tool choice and subprocess boundary are recorded in
[ADR 0002](adr/0002-external-ffmpeg-media-tools.md).

Media uses asynchronous Node `execFile` with literal arguments, closed stdin,
bounded buffers and timeouts. Probe/extraction subprocesses have a 60-second limit;
the composition encoder has a 10-minute limit. It validates local input
files and normalizes ffprobe JSON; unavailable metadata becomes `null`. Container
and stream start timestamps are retained so extraction bounds use the selected
video's end relative to input start. All streams are retained while default
video/audio streams are selected for summaries;
attached cover art is excluded from frame extraction. PNG output is decoded to a
bounded buffer before exclusive file creation, refusing existing paths and
symlinks. No source media is written. External tools are optional, manually
installed prerequisites. See [the CLI/API contract](CLI.md) for precise behavior.

The composition spike normalizes each video's aspect ratio, dimensions, frame
rate and timestamps, pairs it with trimmed/padded stereo audio, concatenates
segments and mixes looped background music. It uses FFmpeg's maintained filters
and encoders through the existing subprocess utility; no wrapper library or MLT
integration is needed for these operations. This does not choose the final
editing/rendering architecture. Renders go to a temporary sibling directory,
are probed for expected metadata, and are published through an exclusive atomic
hard link. Temporary files are cleaned on handled failures. There is no project
or timeline representation and no desktop integration in T03.

Two timing invariants are covered by native regressions. Every accepted clip must
contribute at least one output frame: `fps` uses `eof_action=pass` so very short
clips survive conversion before padding and trimming to the planned frame count.
Background music must preserve timestamp gaps before trimming and resetting PTS
from sample count. Its resampler uses `async=1:min_hard_comp=0:first_pts=0` to fill
gaps with silence, including gaps below FFmpeg's default 100ms compensation
threshold. These rules keep short clips visible and later music in position;
the [CLI contract](CLI.md#composition-prototype) describes their observable behavior.

## Project model, persistence and CLI management (T05–T08)

Core's main entry point exports the version 1 project types, creation, validation,
deterministic JSON serialization and exact rational time helpers. The maintained
Zod schema supplies both structural validation and inferred TypeScript types.
Semantic validation checks globally unique stable IDs, asset/track references,
media compatibility, timestamps and source bounds without inspecting media.
Rational seconds preserve frame and sample boundaries at mixed rates; bigint
intermediate arithmetic avoids rounding during frame conversion and comparison.
Clips store source in/out points and timeline starts; duration is derived at 1×.

The optional `@opencut/core/node` entry point owns project file reads/exclusive
creation, portable path helpers, read-only media availability checks, atomic
updates and T07 asset management.
The main core entry point imports no filesystem modules. Relative references are
anchored to the project file directory; missing files do not prevent loading.
Filesystem-backed asset operations and media validation use the same canonical
parent directory, so directory symlinks preserve source identity and share a
writer lock. Canonicalization retains the project filename so mutation guards
still reject project-file symlinks. The standalone portable reference helpers
remain lexical; see [the path contract](PROJECT_FORMAT.md#media-references-and-portability).
Unsupported schema versions are rejected before structural parsing; future
migrations can be added there without introducing a framework now. T06 exposes
project create/info/validate in the standalone CLI; the desktop does not consume
the model yet. Core owns validated metadata/counts and combined file validation;
the CLI owns argument parsing, cwd-relative project paths, stdout/stderr and exit
codes. Node's existing `util.parseArgs` and Zod cover this scope without a command
framework dependency. File validation distinguishes data validity from media
availability and never modifies files. T07 import/list/info/remove are core Node
operations; the CLI only parses arguments and formats results. Import reuses
`probeMedia`, persists a metadata snapshot and canonical source references,
and detects duplicate file identities without content hashing. Still images use
visual (`video`) media types with metadata kind `image`. Removal checks clip
references and never unlinks media. Saves use an exclusive writer lock and a
synced temporary file followed by same-directory rename; failed saves leave the
old JSON usable. Updates refuse project symlinks and hard links, check outside
changes, and clean owned artifacts on handled failures. Forced termination can
leave stale locks/temporary directories. Atomicity does not promise power-loss
durability or locking of arbitrary external tools. Existing Zod, Node file APIs
and the media package cover validation, guarded replacement and probing;
an atomic-write wrapper would still require these identity and writer checks,
so no additional runtime library is added. T08 also uses existing Zod and bigint
arithmetic rather than a general timeline engine: the operations are small,
pure model transformations with explicit 1x timing and no renderer dependencies.
`addTrack`, `removeTrack`, `addClip`, `moveClip`, `trimClip`, `splitClip` and
`removeClip` validate/copy input and return new projects and stable entity IDs.
`listTimeline` derives duration/end and groups time-sorted clips by track.
The CLI converts project-frame indices to exact rational seconds and invokes the
same operations inside the guarded Node update adapter. Known source durations,
track compatibility, globally unique IDs, safe derived times and no same-track
overlap are enforced by project validation on edits, load and save. Half-open
intervals may touch, and separate tracks may overlap. Trims fix timeline start;
splits preserve source mapping and total duration while retaining the left ID.
There are no implicit ripple edits or populated-track cascades. Undo/redo and
project rendering remain deferred. See [the project format contract](PROJECT_FORMAT.md)
for schema fields, invariants, portability, APIs and errors.
The rationale for rational time, strict versioning and separate file access is
recorded in [ADR 0004](adr/0004-versioned-project-model.md).
[ADR 0005](adr/0005-explicit-timeline-editing.md) records why T08 uses explicit
non-ripple edits, rejects same-track overlap and permits offline source ranges.

## Desktop shell

The desktop follows the system light/dark appearance, including live changes,
through Electron nativeTheme and CSS prefers-color-scheme. On macOS the native
title bar is hidden; the full header (including its padding and text) is draggable,
while the standard window controls and normal resizable window behavior remain.

## Desktop source preview

The source-preview controller lives only in desktop renderer code. One HTML video
element owns A/V playback; `currentTime` is the playback clock and
`requestVideoFrameCallback` supplies the last observed compositor frame PTS through
its `metadata.mediaTime` argument.
The UI displays both and derives a nominal zero-based frame index from average
FPS. The preview does not use the T05 project model. Core has no Electron
dependency; media and CLI remain headless.

A pointer drag stages a target while leaving the range input enabled, then seeks
to the committed target on release, including releases outside the input. Playback
pauses when the gesture starts. Other controls and source replacement stay locked
through the gesture and seek. Cancellation, window blur or unmount removes gesture
listeners and releases its lock. Keyboard changes seek immediately. The final seek
uses the latest observed frame rather than the frame snapshot at pointer-down.

Imports and discrete player actions are mutually exclusive in both directions. A
pending native selection/probe disables the old player's controls, while a seek, drag or
validation disables Open video. This prevents replacement from unmounting a running
validation and leaving its busy state behind. A canceled selection preserves the
source. Normal playback permits file selection; successful replacement pauses the
old video. Failed seeks and benchmark startup release their callbacks/listeners and
seek timers before another operation can begin.

Real Electron regressions cover native dragging, release outside the slider,
keyboard seeking and pending-import/validation exclusion, including a successful
validation after replacement. These test observable interaction boundaries rather
than relying only on programmatically assigning slider values. See
[ADR 0003](adr/0003-html-video-preview.md) for the preview recommendation,
measurement definitions and accuracy limits.

## Desktop trust boundary

Electron main owns native privileges. React runs with `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, web security enabled and webviews
disabled. A bundled **CommonJS preload** exposes three typed capabilities:
`getApplicationInfo()`, `openPreview()` and `getPreviewMetrics()` on `window.opencut`. ESM is used elsewhere. CommonJS here keeps
Electron's renderer sandbox enabled; sandboxed preloads cannot use native ESM.
No raw IPC, arbitrary channel, filesystem or shell API reaches React.

Main validates the sending WebContents, main frame and exact URL for every IPC
handler. Navigation, new windows, webviews and permission requests are denied.
Production assets use the secure `opencut://app` custom protocol with a path
containment check. The production CSP allows only local scripts/styles, no
network connections, and media from the capability-backed `opencut://media` host. Development listens only at `127.0.0.1:5173`; its CSP permits
the Vite websocket and inline styles for CSS reloads. JSX is compiled by Vite;
no extra React refresh framework is needed.

These choices follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
and [sandboxed preload constraints](https://www.electronjs.org/docs/latest/tutorial/sandbox).
Main owns the native picker and issues one random, session-only media URL.
Only that exact URL can stream the selected file. Replacement/window close revokes
future requests to the old URL; streams already accepted may finish. Canceled
selection preserves the current source. The renderer cannot submit arbitrary paths.
Range responses use the maintained `range-parser` library and Node file streams;
partial reads return 206, unsupported/unsatisfiable ranges return 416. Files are
never buffered in full or written. `net.fetch(file:)` did not honor Range in the
T04 integration check, so it remains used only for bundled assets. Frame-rate
metadata reuses `probeMedia` in main; missing ffprobe degrades to clock-only
playback/seeking. Main returns aggregate Electron process CPU and working-set
samples without exposing process or filesystem APIs. Tests cover token revocation,
byte ranges, missing ffprobe, and IPC rejection from a second window.

Future project import/export and IPC need their own validated capabilities.

## Tooling and build

Node 24 and pinned pnpm 11, TypeScript 6, ESM, pnpm recursive dependency ordering,
electron-vite/Vite for Electron and React, tsc for headless packages/CLI, Vitest
for headless tests, Playwright for Electron integration and opt-in preview
performance tests, the Node test runner for optional native fixture regressions,
ESLint and Prettier. TypeScript stays on the compiler major supported by typescript-eslint;
newer tool majors are not required for T02. The lockfile fixes transitive versions.
Only Electron and esbuild dependency build scripts are explicitly allowed.
There is no root postinstall, fixture generation hook, native media dependency,
Turborepo, command framework or runtime service.

Build packages before importing their exports. Root dev/test/typecheck commands
do this automatically. The dev command rebuilds package declarations once;
restart it after changes to a headless package. The production build produces
assets under each package/app's `dist/`; distribution packaging is deferred.

## Fixture validation boundary

`pnpm test` runs without FFmpeg, ffprobe or an Electron window. `pnpm test:media`
is an opt-in native CLI suite using the existing generated fixtures. It creates
derived timing/stream inputs, PNGs and composition outputs in owned subdirectories under
`tests/fixtures/generated/` and removes those subdirectories on success or failure.
The native fixture regression is a separate opt-in
suite that creates synthetic media in an OS temporary directory and cleans it up.
It does not use or change the working fixture set.

Fixture validation decodes media with ffprobe and checks `nb_read_frames` against
the expected video frame count. Container headers alone are insufficient: an MP4
can retain its declared duration and frame count after its media data is truncated.
Missing readable-frame counts and error-level decoder diagnostics fail validation,
including diagnostics from tools that exit successfully. The expected metadata,
tolerances and regeneration rules live in the [fixture contract](../tests/fixtures/README.md).
Fixture validation is independent of the application media APIs.

## Open decisions for subsequent tasks

- Validate FFmpeg/MLT capabilities, licensing, distribution and process isolation.
- Define undo semantics and project rendering on top of the shared model and T08 edits.
- Evolve the scripting contract for later editing capabilities; current
  project, media and timeline JSON is documented in [CLI.md](CLI.md). Stdout is reserved for results,
  stderr for errors.
- Extend the picker capability boundary for future project media access; define rendering/playback ownership beyond a single source.
- Choose distribution tooling and signing, then validate other operating systems.

These are decisions to investigate, not APIs promised or implemented by T05.
