# Architecture

## Workspace boundaries

| Package            | Owns                                                                                              | Actual dependencies                                               |
| ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `@opencut/desktop` | Electron lifecycle, project session, restricted IPC, React workspace and source/project preview   | core, media, shared, Electron, React, Lucide, range-parser        |
| `@opencut/cli`     | Argument parsing, stdout/stderr and exit codes                                                    | core, media, shared, Node built-ins                               |
| `@opencut/core`    | Headless identity, project model, persistence, assets, timeline edits and render planning         | shared, Zod; media and Node built-ins in optional `/node` adapter |
| `@opencut/media`   | Probing, extraction, proxy/frame caches, composition and timeline encoding through external tools | shared, Node built-ins, lru-cache, proper-lockfile                |
| `@opencut/shared`  | Pure composition geometry, canvas colors and SDR source matrix rules                              | none                                                              |

Actual runtime dependency direction is `desktop → core ← cli`, with desktop main,
CLI and the core Node adapter depending on media. The rationale is
recorded in [ADR 0001](adr/0001-shared-headless-core.md). Core never
imports Electron, React, CLI or desktop code. Media stays headless. Shared composition rules have no runtime dependencies and are used by media, core, CLI and desktop.
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
FFmpeg media backend. T24 owns browser playback in the renderer, T25 hosts cache
work in a Node worker, and T26 shares composition geometry with the export backend.
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
project create/info/validate in the standalone CLI; T15 consumes the same model
in Electron main. Core owns validated metadata/counts and combined file validation;
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
leave unused temporary directories; T22 OS ownership is released on process death. Atomicity does not promise power-loss
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

### Visual language and icon assets

The docked workspace uses violet tools, mint audio accents and system light/dark
surfaces. Shared CSS radius tokens distinguish controls, cards, panels and dialogs.
Keep labels concise and use grouping and hierarchy to explain the interface;
reserve supporting text for ambiguity, errors and unavailable capabilities.
Lucide supplies control icons, while `studio-graphics.tsx` owns decorative SVG
artwork. Decorative graphics are hidden from assistive technology; controls keep
accessible names independently of their icons.

The app identity is a flat violet character with expressive eyes and a detached
coral cut corner on a peach tile. The editable master is
[`opencut-icon.svg`](../apps/desktop/resources/opencut-icon.svg). Its transparent
1024 × 1024 PNG export, [`opencut-icon.png`](../apps/desktop/resources/opencut-icon.png),
is the shared runtime asset: the renderer imports it for the header, and main
imports it with electron-vite's `?asset` handling for `BrowserWindow` and macOS
`app.dock.setIcon`. Update the SVG and PNG together when changing the identity;
changing the SVG alone does not update the running app. Rebuild and relaunch to
load the new asset. `tests/desktop/icon.spec.ts` checks the bundled header image
and the image passed to the real macOS Dock setter when a window reopens.
This runtime wiring does not configure Finder, installer or signed-app bundle
icons; packaging remains outside the current build.

## Desktop source preview

The source-preview controller lives only in desktop renderer code. One HTML video
element owns A/V playback; `currentTime` is the playback clock and
`requestVideoFrameCallback` supplies the last observed compositor frame PTS through
its `metadata.mediaTime` argument.
The reusable `VideoPreview` accepts a source, optional project frame rate,
external `positionSeconds` and `onPositionChange` callback. Source URL changes
reset transport state; changed external finite positions request a paused seek
clamped to the loaded duration, coalescing while an interactive seek or drag is
pending. Each changed request is consumed once, and echoes of the last reported
position are ignored so parent feedback does not pause playback. Consumers
should key the player by source URL (as the workspace does). The UI displays both
clock and presented PTS. With a project it derives the nominal frame position and
non-drop timecode from the project clock/rate; otherwise it uses source average
FPS. Project steps advance the requested clock by a project frame interval even
when successive targets decode to the same source frame. This does not index VFR
timestamps or promise decoded-frame accuracy. Core has no Electron
dependency; media and CLI remain headless.

`Preview` coordinates library and native-picker requests and owns media-URL
release. Their shared completion path accepts only the current request generation;
replacement and unmount invalidate older completions, and late grants are released.
`VideoPreview` owns element playback and decoder cleanup, without granting or
revoking file access. Direct consumers must release their source capability when
it is no longer needed.

A pointer drag stages a target while leaving the range input enabled, then seeks
to the committed target on release, including releases outside the input. Playback
pauses when the gesture starts. Other transport controls and the native picker stay
locked through the gesture and seek. Library selection can replace the player
and cancel the gesture. Cancellation, window blur or unmount removes gesture
listeners and releases its lock. Keyboard changes seek immediately. The final seek
uses the latest observed frame rather than the frame snapshot at pointer-down.

Native-picker requests and discrete player actions are mutually exclusive. A
pending native selection/probe disables the old player's controls, while a seek, drag or
validation disables Open video. A canceled picker selection preserves the
source. Normal playback permits file selection; successful replacement pauses the
old video. T16 library selection may replace even a busy player: abort signals
cancel pending seek/benchmark timers, frame callbacks and event listeners. Cleanup
pauses the video, removes `src` and calls `load()` to release decoding/network
resources. Switching viewer tabs pauses playback and cancels outstanding actions.
Shortcuts are scoped to the focusable player region and ignore form controls,
editable content, modifiers and key repeats. Failed seeks and benchmark startup
also release their callbacks/listeners and seek timers.

Real Electron regressions cover pointer dragging, release outside the slider,
keyboard seeking and pending-import/validation exclusion, including a successful
validation after replacement. The drag regression sends pointer events through
Playwright and makes its test window ignore physical mouse input so activity on
the shared desktop cannot interrupt the automated gesture. Production input
handling is unchanged. These tests exercise the range input's default behavior
rather than relying only on programmatically assigning slider values. See
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
sampling phase unchanged. The first eligible tick for a source frame is at or
after its presentation timestamp. Static images loop one frame for the explicit
range. The [T27 gate](PREVIEW_EXPORT_CONSISTENCY.md) verifies source-frame identity
independently of the evaluator and compares Chromium Canvas draws against export.
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
[ADR 0009](adr/0009-video-compositing-and-canvas.md) records the initial visual semantics;
[ADR 0012](adr/0012-realtime-layer-composition.md) extends them to shared RGB
preview/export composition and transparent canvas colors.
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
disabled. A bundled **CommonJS preload** exposes typed capabilities:
`getApplicationInfo()`, `openPreview()`, `getPreviewMetrics()`, `getProject()`,
`createProject(input)`, `openProject()`, `saveProject()`, `closeProject()`,
`previewAsset(assetId)` and `releasePreview(url)` on
`window.opencut`. ESM is used elsewhere. CommonJS here keeps
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
T16 also resolves an asset ID against the current `ProjectSession`, uses core
path resolution and a fresh readable-file check, and reuses imported metadata.
Stored codec, dimensions and average FPS remain an import snapshot; opening a
project or previewing an asset does not re-probe them. Imported sources have no
separate probed video-end bound, so seeks clamp to browser duration. An audio-only
tail can advance the project clock over an unchanged final video frame. The native
picker retains T04's optional probe-derived video-end bound for interactive steps.
Audio/still selections and unknown IDs fail without granting access. Project media
preview requires no additional ffprobe call. A generation guard prevents older
asynchronous selections from replacing a newer grant. Successful project
create/open/close revokes access, while canceled/failed operations preserve it.
Releasing an older URL cannot revoke a newer grant.
Only that exact URL can stream the selected file. Release/replacement/window close revokes
future requests to the old URL; streams already accepted may finish. Canceled
selection preserves the current source. The renderer cannot submit arbitrary paths.
Range responses use the maintained `range-parser` library and Node file streams;
partial reads return 206, unsupported/unsatisfiable ranges return 416. Files are
never buffered in full or written. `net.fetch(file:)` did not honor Range in the
T04 integration check, so it remains used only for bundled assets. Frame-rate
metadata reuses `probeMedia` in main; missing ffprobe still allows clock
playback/seeking and, with a project open, nominal project-rate stepping.
Main returns aggregate Electron process CPU and working-set
samples without exposing process or filesystem APIs. Tests cover token revocation,
byte ranges, missing ffprobe, and IPC rejection from a second window.

T15's main-process `ProjectSession` owns the current project, path, baseline and
unsaved status. React uses local hooks for snapshots, inspection selection, viewer
tabs and operation feedback. The creation dialog keeps field values in HTML
form controls and reads them with `FormData` on submit. React cannot submit a
path or replacement document. The desktop uses a three-pane editor workspace (media library, viewer, inspector) above an interactive
track timeline. Selecting video assets also opens source preview. Playback,
selection, scroll, zoom and timecode state are never saved in the project. The
project viewer uses T24 edited-timeline playback, with source preview in a separate tab.

T17's React/SVG timeline consumes `Project` directly. A memoized per-track search
index references existing clips, sorts by exact starts and caches core-derived
ends; it is view geometry, not an independent project model. Clip durations and
ends come from core rational helpers. View-coordinate differences and source/timeline
translations use bigint intermediates before conversion to pixels or browser seconds.
Frame counts and non-drop timecode labels use bigint cross-multiplication at the
project's rational rate. Browser coordinates convert to rational times once at
the input boundary; ruler seeks snap to the nearest project frame (the exact
exclusive end remains reachable). Tick positions derive independently from bigint
frame multiples and fractions, avoiding accumulated rounding and JSON-integer limits;
labels come directly from the corresponding frame counts. Labels and lanes share
one mapping. Seeking, keyboard stepping and preview reports first use core
`frameTime` when the frame count is a safe integer. If that API's frame-count or
reduced-fraction limits are exceeded, `framePosition` constructs a transient rational
approximation using the largest denominator that keeps both components safe.
It rounds toward the following instant so boundary rounding does not select the
preceding frame, caps the representable time at `Number.MAX_SAFE_INTEGER` seconds,
and callers clamp it to project or linked-clip bounds. At extreme rates or positions,
finite precision can skip frame labels. The [exact-time contract](PROJECT_FORMAT.md#exact-time)
continues to govern persisted timing and strict core arithmetic.
React and native scrolling/SVG suffice here; an additional timeline/editor or
virtualization dependency would duplicate the core model or add unnecessary scope.

Binary search culls horizontal clips; fixed-height rows cull vertical tracks.
Same-track overlap remains prohibited by the existing core validator, while
cross-track overlaps are visible. SVG coordinates are clipped to the viewport
before paint. The physical horizontal scroll surface caps at 8,000,000 pixels,
with a proportional logical offset beyond that size. Logical scale stays in pixels
per second; extreme-duration native scrollbar navigation is coarser. Zoom anchors
the pointer for Ctrl/Command wheel gestures and viewport center for controls,
subject to sequence-start/end clamping and browser scroll rounding. Ordinary
rerenders retain the scroll element and zoom state; a project-session key resets
both when a different project is opened or the current project is reopened.

An explicit **Preview selected clip** action links one video clip to T16's
source player. Timeline-to-source mapping uses source-in plus the exact timeline
delta. The source callback converts observed browser seconds at microsecond
precision, quantizes to the nearest project frame and clamps the playhead to the
clip's timeline range. External seek request keys are tracked separately from
position reports: unchanged reports do not issue new seeks, while an explicit
repeat request for the same target can be applied again. Known limitation:
repeated ruler seeks followed by Play can leave the linked source paused.
Inspection selection is independent of playhead/link state. Seeking
outside the linked range pauses/hides and unlinks the source; library/local source
selection also unlinks. The source transport still spans the full source; that linked source does not switch clips or apply timeline mixing. T24 playback
in Project viewer has a separate clock, decoder lifecycle and mixer.
T16's codec, VFR, stream-offset and approximate HTML seek limitations remain.
Creation accepts only name/settings and reuses core validation. Main's native file dialogs select paths;
core `readProjectFile`, `writeProjectFile`, `checkProjectMedia` and
`updateProjectFile` perform persistence and media checks directly, without CLI
subprocesses. No new dependencies are needed: React hooks and the existing core
provide state, schemas and persistence; Electron provides dialogs and IPC.

IPC validates request arity as well as sender identity, and returns discriminated
success/cancellation/error results. Project operations are serialized across IPC
and native window-close/quit requests. Unsaved new projects require a native
Save/Discard/Cancel choice before switching or closing; cancellation or a failed
save retains the session. Saving clean loaded documents is a core-guarded no-op.
A serialized baseline check plus the core revision guard
refuses stale writes, including external same-revision changes. Directory aliases
are canonicalized, and existing creation destinations and project symlink/hard-link
updates follow the CLI's refusal rules. History and schema version are unchanged.
Media availability is refreshed on open and when undo/redo changes the asset
inventory or references, including unsaved projects; clip-only edits retain the
availability snapshot. Unsaved sessions use the same fallback project location as
import, with absolute references resolving directly to their sources. A refresh
must succeed before the restored session is accepted; failure preserves the prior
session. This checks readability, without watching files or refreshing probe metadata.
Project playback and render controls need separate capabilities.

T18 adds narrow `editTimeline`, `undoProject` and `redoProject` preload methods.
Main checks sender, arity, project identity, revision and request shape, allows only
clip move/trim/split/remove commands, and uses T09 transactions/history. React
never sends replacement documents or paths. The core's `previewTransaction`
executes the same validated primitives without recording history; `executeTransaction`
commits that result. React memoizes a validated content-only snapshot per project
state and reuses it throughout a gesture, keeping undo/redo snapshots out of
pointer-move validation. `createTimelinePreview` removes `editing` before calling
core `projectSnapshot`, so snapshot preparation also avoids historical validation.
Accepted project changes invalidate the cache; each gesture retains its original
preview snapshot. Main still validates the complete project/history and revision
at commit. The UI adapter translates pointer coordinates into frame
commands and chooses snap targets; no editing validation is duplicated in React.
Left trims combine move and trim, ordering shrink/extension to keep intermediate
states valid, and commit as a single transaction. Proposal state remains local and
separate from the session. Rejected proposals display the unchanged clip with an
error; IPC errors discard the overlay and retain the last accepted UI state.

Pointer capture belongs to the stable scroll surface, avoiding capture loss when
clips move between culled lanes. A movement threshold distinguishes selection
from dragging. Escape/cancel/lost capture/blur cancel; release recomputes the final
coordinate and submits once. Native scrolling contributes its logical offset to
pointer deltas; zoom is locked during gestures. Snap distance is measured in
screen pixels against project-frame-aligned clip boundaries, zero and playhead.
The configurable default is 8 pixels. Keyboard frame edits omit proximity snapping.
Successful edits unlink/pause source playback so stale source clocks do not move
the retained playhead. Existing React/SVG and Pointer Events suffice; a gesture
or editor library would add a second model without replacing core validation.

Desktop Save uses the revision last saved/read from disk, rather than the edited
session revision. `updateProjectFile`'s `history: 'preserve'` mode retains several
already committed in-memory transactions without recording a duplicate entry.
Changed sessions must advance revision, retain project identity and have consistent
history. The serialized disk baseline, writer lock, external-change detection and
atomic rename still guard publication. Undo/redo remain available after reopening.

T19 extracts T07 import preparation and unused-asset removal into shared core Node
functions used by both CLI file transactions and the desktop session. Main prepares
an entire multi-file batch on a private project copy, checks availability, then
records one `commitEdit`; failures retain the original session. Imports before a
project's first save use absolute references, which saving preserves. Imports into
a saved project use T07's reference policy: prefer project-relative paths where
valid, otherwise retain absolute paths. No source file is copied or modified. The core `addAssetClip` builds
ordinary track/clip operations with whole project-frame source bounds and a
five-second still default. New tracks and clips commit together with T09 history.

The sandboxed preload uses Electron `webUtils.getPathForFile` for dropped native
Files and sends paths only to the import handler; the renderer has no path-based
filesystem API. Picker/import/removal/clip commands retain sender, arity, identity,
revision and strict shape checks. Import progress is an event with a removable
listener. Library drags have a distinct MIME type with project ID, revision and
asset ID, while external Files are accepted only in the library. Timeline drop
coordinates reuse the virtual scrollbar, track geometry and exact frame helpers.

Video thumbnails use the headless bounded PNG cache through the media worker.
Still-image thumbnails retain Electron's asynchronous native thumbnail service
(macOS/Windows), with icon fallback on unavailable tools/formats/platforms.
No video element is mounted solely for library thumbnails.
Audio/image source previews reuse the revocable
single-source media protocol, with native audio controls or an image element;
source previews remain separate from project compositing/playback. Hiding source
preview pauses audio; replacing it unloads the previous media element. Audio
setup restores a source removed by cleanup, mirroring the video player's lifecycle:
React StrictMode replays effects in development while retaining the DOM element.
The development Electron regression exercises actual replay and decoded playback,
while the production workflow verifies library selection and timeline drops.

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

T20 extends the existing strictly parsed clip-edit IPC allowlist with `clip.audio`
and `clip.visual`; React sends only core operations with project identity/revision.
Numeric timing uses exact project-frame counts and hides editable fields for
off-grid/unrepresentable values rather than rounding them. Field drafts remain
local until Enter/blur; unrelated commits preserve field drafts, while changes to
a field's accepted value synchronize it. Range adjustments commit once on
pointer/key release.
The existing T09 core validates and records each accepted adjustment. A renderer
operation queue orders a property's blur commit before a clicked Save/history
action. Edits, history and media imports resolve revisions from the latest accepted
session when their queued operation executes. Imports retain the requesting
project's identity so a project replacement cannot redirect the request into
another project. Selection IDs survive temporary absence during history so
restored clips become selected again.

Workspace shortcut mapping chooses Command on macOS and Control elsewhere and
excludes native editing/control keys, composition, repeats and already handled
events. Existing player and timeline handlers retain their scoped keys. A small
transport ref reuses the active source player's serialized playback/seeking path;
T24 also routes that transport to Project viewer. Clip audio is previewed there;
T26 also applies visual transforms in Project viewer.
Native numeric/range inputs and React suffice here without a dependency or second
editing/history model.

## Open decisions for subsequent tasks

- Validate FFmpeg/MLT capabilities, licensing, distribution and process isolation.
- Extend the T13 visual/audio renderer only when later tasks define transitions or effects.
- Evolve the scripting contract for later editing capabilities; current
  project, media and timeline JSON is documented in [CLI.md](CLI.md). Stdout is reserved for results,
  stderr for errors.
- Define rendering/playback ownership beyond a single source.
- Choose distribution tooling and signing, then validate other operating systems.

These are decisions to investigate, not APIs promised or implemented by T05.

## T21 audit and performance boundary

The [T21 architecture audit](T21_ARCHITECTURE_AUDIT.md) records the verified
capability matrix, reproducible source/export benchmarks, explicit fallback
behavior and recommended T22–T27 gates. That historical baseline predates T24; source and exported-file measurements
remain distinct from the edited-timeline tests.

## Shared project sessions (T22)

The Node persistence adapter discovers the active session through a private Unix
socket. SQLite OS locks in a permanent `.opencut-lock` sidecar give one writer
exclusive ownership across Electron and standalone CLI processes. Existing CLI
commands prepare proposals with the headless core; the session compares base
snapshots, validates history/revisions and atomically saves before notifying the
renderer through a narrow preload subscription. Named GUI projects automatically
save each edit; untitled projects retain their first-save flow. There is no polling.

See [ADR 0011](adr/0011-shared-project-session.md) for ownership, crash recovery,
security, disconnect semantics, transport limits and platform boundaries.

## Timeline evaluation

T23 shares exact clip timing, ordering and defaults between headless point queries
and export planning. See [evaluation semantics and limitations](TIMELINE_EVALUATION.md).

## Edited timeline playback and compositing (T24–T26)

The [playback contract](TIMELINE_PLAYBACK.md) describes the single AudioContext
clock, prepared T23 queries, media-element lookahead and synchronization, gain
routing, canvas painting and disposal. This remains a desktop adapter: core, CLI,
media inspection and offline rendering have no Electron/Web Audio dependency.
Timeline media capabilities are revision-scoped and independent of source-preview
selection. T26 adds ordered Canvas video/image compositing using the shared headless geometry/color contract. FFmpeg exports reuse that contract and blend in RGB; see the [composition rules](TIMELINE_PLAYBACK.md#composition-and-export-agreement-t26).

## Proxy and cache ownership (T25–T26)

`@opencut/media` owns `MediaCache`, source fingerprinting, verified FFmpeg proxies,
PNG extraction, byte budgets, invalidation and disk eviction. Electron main forwards
authorized asset IDs to a separate Node worker; it performs no cache hashing,
transcoding or frame extraction. The CLI calls the same headless layer. Native
Chromium decoding stays asynchronous in the existing player. No native bindings
or new timeline operations are introduced. `lru-cache` supplies bounded PNG/source
metadata caches; `proper-lockfile` coordinates disk writers, heartbeats and crash
recovery across GUI and CLI. Disk eviction sorts persistent last-access times.

Only timeline preview requests can select proxies. Project JSON retains original
references, source preview remains original, and the render adapter resolves those
original references directly without consulting cache state. A proxy is published
only after metadata, all decoded video timestamps and source identity checks pass.
See [proxy/cache behavior and bounds](MEDIA_CACHE.md) for formats, cancellation,
resource accounting, GUI/CLI management and benchmark reproduction.
