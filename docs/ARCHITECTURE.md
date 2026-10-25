# Architecture

## Workspace boundaries

| Package            | Owns                                                                                      | Actual dependencies                                       |
| ------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `@opencut/desktop` | Electron lifecycle, restricted IPC, React source preview                                  | core, media, Electron, React, range-parser                |
| `@opencut/cli`     | Argument parsing, stdout/stderr and exit codes                                            | core, media, Node built-ins                               |
| `@opencut/core`    | Headless identity, project model, persistence, assets, timeline edits and render planning | Zod; media and Node built-ins in optional `/node` adapter |
| `@opencut/media`   | Probing, frame extraction, composition and timeline encoding through external tools       | Node built-ins                                            |
| `@opencut/shared`  | Reserved location for utilities/types used by multiple packages                           | none                                                      |

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
pure timeline operations shared by CLI and future GUI callers. T09 adds pure
transaction dispatch and persistent snapshot history over those operations.
The application version is currently returned by core and kept aligned with the
workspace manifests; release/version automation is deferred.

Core owns project intent and data validation. A media engine performs probing,
decoding, playback and encoding. T02 uses external ffprobe for metadata and FFmpeg
for single-frame PNG extraction in media. T03 adds `composeMedia(options)` in
media as a technical spike, called directly by the CLI alongside inspection and
extraction. T04 adds isolated HTML video playback in desktop. The T05 model stores
intent without executing edits or connecting to these media/preview prototypes.
T12 coordinates saved-project export through a pure visual/audio plan and the existing
FFmpeg media backend. Broader engine hosting and desktop playback ownership remain
open decisions.
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

## Project model, persistence and CLI management (T05–T09)

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
There are no implicit ripple edits or populated-track cascades. T12 composites video/image tracks and mixes multiple audio tracks from saved project data. T09 adds a pure transaction dispatcher over these operations.
A transaction validates each evolving state, then records full before/after content
snapshots as one history entry when the final content changes. If operations cancel
out, generated `updatedAt` changes alone do not create a commit: revision, both
stacks, timestamps and project bytes stay unchanged. Exact timestamp comparisons
remain in history-integrity checks and undo/redo restoration. Undo/redo restore snapshots and advance a monotonic
revision, avoiding command replay, inverse-operation bugs and reused revisions.
The optional version 1 `editing` field stores revision and both history stacks in
the same JSON as current content, so a single atomic replacement publishes all of
them. Legacy projects start at revision 0. Individual timeline and asset mutations
record through the same writer; new changed edits clear redo. Explicit expected
revisions reject stale callers, while the lock serializes cooperating writers and
existing identity/content checks detect outside modifications during execution.
Dry-run plans the same update and history but skips publication. Existing Zod and
Node APIs suffice; snapshots remain unpruned and trade file size for simplicity. See [the project format contract](PROJECT_FORMAT.md)
for schema fields, invariants, portability, APIs and errors.
The rationale for rational time, strict versioning and separate file access is
recorded in [ADR 0004](adr/0004-versioned-project-model.md).
[ADR 0005](adr/0005-explicit-timeline-editing.md) records why T08 uses explicit
non-ripple edits, rejects same-track overlap and permits offline source ranges.
[ADR 0006](adr/0006-snapshot-transactions-and-history.md) records the T09 snapshot,
revision, atomicity and no-op decisions.

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

## Timeline rendering (T10–T13)

The pure core `planProjectRender` validates the project, converts rational boundaries
exactly with bigint, orders visual clips bottom to top by track order and emits
positioned integer-frame visual/audio clips. The optional core Node adapter reads
one saved snapshot and resolves assets against its physical project directory.
Media's `renderVideoTimeline` accepts resolved clips without importing the project
model, CLI or Electron. Existing FFmpeg process execution supplies scale, crop,
alpha multiplication and overlay filters without another backend or dependency.

Each source is sampled to the project frame grid before trimming, keeping split
sampling phase unchanged. Static images loop one frame for the explicit range.
An opaque canvas source fixes the duration; each layer uses the project time base
and exclusive frame-index visibility. Layers end without freezing their last frame.
Contain has transparent margins, cover centrally crops and stretch fills the scaled
canvas rectangle. The final output is opaque yuv420p. Visual filters never mix audio;
video inputs are reused by the independent audio graph once per clip.
Global timestamps use integer indices in the rational time base. MP4 stores the
frame-rate numerator as its timescale. H.264/AAC output is probed and fully decoded/
counted before atomic publication; no project mutation occurs. New outputs use an
exclusive hard link; explicit replacement uses a same-filesystem rename only after
verification.
[ADR 0007](adr/0007-integer-frame-timeline-rendering.md) records timing/publication;
[ADR 0009](adr/0009-video-compositing-and-canvas.md) records visual semantics.
The [CLI contract](CLI.md#project-rendering) defines prerequisites and limits.

T11 adds optional linear clip gain/mute fields without inserting defaults into
legacy documents/history. The same pure plan includes positioned audio entries
for video clips and audio-track clips. The Node adapter resolves all referenced
inputs; the media backend selects streams and reuses T03 resampling, mixing and
latency-compensated peak limiting. Source audio is aligned to the video's first
frame (or the audio-only stream's first sample), resampled to 48 kHz stereo before
source trims, and delayed onto the timeline. Absolute frame boundaries round to
sample indices rather than accumulating rounded clip durations. Missing/short
video audio supplies silence; audio-track clips require a valid audio stream and
current known bounds. A finite silence bed fixes the total mix duration; gains
sum without active-input normalization. AAC output is always present. The longest
clip defines output duration, with the canvas background after the last visual clip.
Same-track overlaps remain forbidden, and the 64-total-clip limit still applies;
T12 removes the former single-video-track restriction.
[ADR 0008](adr/0008-positioned-audio-mixing.md) records the audio timing, gain,
silence, duration and format-compatibility decisions that extend ADR 0007.

T13 keeps each render in the calling process. Media consumes FFmpeg's structured
`-progress` records and reports frame counts, percent, elapsed time and an estimated
remaining encoding time through a callback. CLI owns JSONL progress/terminal events,
human stderr progress and SIGINT/SIGTERM handlers; core stays independent of process
signals and output streams. An `AbortSignal` reaches input probes, encoding and output
verification. Cancellation sends SIGTERM, escalates to SIGKILL after two seconds,
waits for tool closure and cleans owned temporary output before rejecting.

Quality presets select encoder speed/CRF; resolution presets scale the finished
canvas without reinterpreting project-space transforms. Fitting retains an integer
scale ratio until the final even-pixel division, avoiding floating-point underflow
for exact output dimensions. Export controls do not alter the saved project or its
history. Both publication modes use a verified file in an owned sibling directory
on the destination filesystem. SIGKILL of the caller and power loss cannot guarantee
cleanup. [ADR 0010](adr/0010-foreground-render-lifecycle.md) records the lifecycle,
progress, preset and replacement decisions. The [rendering contract](CLI.md#render-presets-and-progress)
defines event fields, presets, exit codes and filesystem requirements.

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

T14 adds `scripts/cli-e2e.ts` as a consumer of the built public CLI. Every project
command starts a fresh process; no core APIs construct or repair its project.
Independent ffprobe/FFmpeg checks verify decoded frames, layer regions, audio
gains and timing. `tests/e2e/cli.native.spec.ts` runs the workflow twice and checks
identical MP4 hashes with the same fixtures/toolchain, plus per-run cleanup.
`pnpm test:e2e` is opt-in and remains separate from `pnpm test` and `pnpm test:media`.
It generates fixtures only when their directory is absent, validates an existing
set, and never overwrites it. `pnpm e2e --keep` retains a successful run for inspection;
otherwise the workflow removes its owned directory. See the
[official workflow](../skills/video-editor/references/workflow.md) for the recipe
and verification boundaries.

Fixture validation decodes media with ffprobe and checks `nb_read_frames` against
the expected video frame count. Container headers alone are insufficient: an MP4
can retain its declared duration and frame count after its media data is truncated.
Missing readable-frame counts and error-level decoder diagnostics fail validation,
including diagnostics from tools that exit successfully. The expected metadata,
tolerances and regeneration rules live in the [fixture contract](../tests/fixtures/README.md).
Fixture validation is independent of the application media APIs.

## Open decisions for subsequent tasks

- Validate FFmpeg/MLT capabilities, licensing, distribution and process isolation.
- Extend the T13 visual/audio renderer only when later tasks define transitions or effects.
- Evolve the scripting contract for later editing capabilities; current
  project, media and timeline JSON is documented in [CLI.md](CLI.md). Stdout is reserved for results,
  stderr for errors.
- Extend the picker capability boundary for future project media access; define rendering/playback ownership beyond a single source.
- Choose distribution tooling and signing, then validate other operating systems.

These are decisions to investigate, not APIs promised or implemented by T05.
