# Product

OpenCut will be a lightweight, local desktop video editor for YouTubers,
TikTok and Instagram creators, vloggers, and streamers. A clear conventional
interface should make everyday editing accessible without code. The desktop now
provides project management, a media library, timeline editing, clip properties
and shared undo/redo. Single-source preview can link to an individual video clip;
Project viewer plays edited cuts, gaps and synchronized multi-track audio.
Project viewer composites ordered video/image layers with position, scale, opacity, fitting and canvas alpha.

## Two equally important workflows

**GUI-first usability:** creators should be able to edit entirely in the desktop
application, with discoverable controls and understandable feedback.

**CLI-first architecture:** editing behavior belongs to an independently usable
headless core. The GUI and a standalone CLI will invoke the same operations.
Scripts and compatible external AI coding agents should be able to control that
core without launching Electron. Neither interface gets a separate editing model.
A maintained official Agent Skill will teach agents the actual CLI as it grows.

The editing model (projects, intent, commands, validation) and the media engine
(probing, decoding, playback and encoding) are separate concerns. The [project format](PROJECT_FORMAT.md), [playback contract](TIMELINE_PLAYBACK.md)
and [architecture decisions](adr/0012-realtime-layer-composition.md) define their
current contracts and validation boundaries.

## Implemented milestones through T27

Implemented: pnpm workspace, Electron/React shell, standalone help/version
CLI, importable core identity, headless media package, reserved shared package,
strict TypeScript, linting, formatting, tests, synthetic fixture tooling, and
documentation. T02 adds structured media inspection with ffprobe and single-frame
PNG extraction with FFmpeg, through standalone CLI commands supporting JSON.
T03 adds a headless FFmpeg composition spike: sequential video clips, background
music mixed with original audio, normalization of media properties, and verified
H.264/AAC MP4 export through the CLI. T04 adds a desktop-only source preview prototype: local file selection,
play/pause, timestamp seeks, nominal forward/backward frame stepping, presented
frame PTS and reproducible seek/playback/resource measurements. HTML video is the
recommended initial source-preview architecture; frame stepping is best effort,
not a frame-accurate editing contract. See [ADR 0003](adr/0003-html-video-preview.md).

T05 adds a headless versioned project data model with metadata/settings, media
assets, video/audio tracks, source ranges and timeline positions linked by stable
IDs. Rational time supports exact frame boundaries. Creation, strict validation,
deterministic JSON serialization, file save/load and separate missing-media
checks are available as core APIs. Relative paths keep project bundles portable.
See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for the version 1 contract.

T06 adds standalone `project create`, `project info` and `project validate`
commands over the T05 APIs, with configurable resolution/rational frame rate,
JSON reports, scoped help, predictable exit codes and exclusive project creation.
Validation reports project-data issues and local media availability separately.
These three commands require no Electron or media tools. See [CLI.md](CLI.md#projects).

T07 adds CLI media import/list/info/remove backed by shared headless core APIs.
Imports probe video, audio and images, persist metadata and stable UUIDs, and
reference original files without copying. Normalized paths, symlinks and hard
links deduplicate by source identity. Inspection reports offline files and
referencing clips; removal refuses referenced assets and never deletes source
files. Project mutations use atomic replacement and a writer lock. Only import
needs ffprobe. See [the asset command contract](CLI.md#project-media-assets).

T08 adds shared headless timeline operations through `timeline list`, video/audio
`track add/remove`, and `clip add/move/trim/split/remove`. CLI frame indices convert
to exact rational seconds at the project rate. Source bounds and compatibility
are validated, same-track overlaps fail, and touching exclusive ends or cross-track
overlaps are allowed. Splits preserve source mapping and total duration; no edit
implicitly shifts neighbors. Stable IDs and guarded atomic persistence support
scripts and external agents. See [timeline editing](CLI.md#timeline-editing).

T09 adds atomic timeline batches, exact undo/redo, persistent history, dry-run
validation and revision checks through `edit apply|undo|redo|history`. Existing
individual timeline/media edits share the same snapshot history. Failed batches
leave no partial content or history; changed edits after undo discard redo.
See [transactions, undo and redo](CLI.md#transactions-undo-and-redo).

T10 adds `project render` over saved timelines, supporting one video track,
sequential trimmed/split clips, black gaps and exact integer/rational frame timing.
Output is H.264 MP4 at project resolution/rate. Sources and project history remain
unchanged. See [project rendering](CLI.md#project-rendering) for limits.

T11 extends the same renderer with original video audio, independent audio tracks,
overlap mixing, clip volume/mute, trimmed/split source synchronization and silent
gaps. H.264/AAC MP4 output contains 48 kHz stereo audio. Longest audio clips can
extend black video tails. Existing video-only projects remain valid. The single
video track limit and same-track overlap rules remain unchanged.

T12 extends saved-project rendering with overlapping video tracks, still-image
layers, track-order stacking, position/scale/opacity, contain/cover/stretch fitting
and a configurable opaque canvas background. Portrait 9:16, landscape 16:9 and
square canvases share the same headless model and CLI. Audio still mixes once per
clip. Existing projects retain centered contain fitting on a black canvas.

T13 adds observable foreground render jobs: structured JSONL progress, graceful
SIGINT/SIGTERM cancellation, bounded subprocess shutdown, quality/resolution presets,
and optional atomic replacement of existing exports after verification. Failed or
cancelled jobs preserve previous exports and clean owned temporary output.

T14 adds a reproducible CLI-only 18-second edit and automated repeatability test.
It covers creation/import, track and clip edits, transforms/overlays, original and
background audio, persistent history across processes, validation, export and
independent decoded frame/audio checks. The official Agent Skill includes the
complete workflow. This validates the existing headless capabilities without
adding editing features or desktop integration.

T15 adds Electron project management: create with configurable dimensions and
rational frame rate, open/save shared project files, inspect metadata/settings,
and display imported assets and tracks/clips in a read-only workspace. The GUI
uses a conventional video-editor layout: media library on the left, viewer in the
center, inspector on the right and horizontal timeline tracks below. Selecting
assets or clips exposes their stored details in the inspector. Native
Save/Discard/Cancel prompts protect unsaved projects during switch, close and quit.
The core's validation and persistence are shared with the CLI; missing media is
shown without preventing project inspection. The existing source preview stays
independent. There is no project playback, GUI import, editing, drag-and-drop,
Save As, file watching or render control in this task.

T16 reuses the HTML video player for imported video assets: selecting a library
asset opens source preview with play/pause, seeking, nominal forward/backward
steps, scoped keyboard shortcuts, time/duration, project-rate non-drop timecode
and aspect-ratio-preserving scaling. Missing, unsupported and corrupt files show
recoverable errors. Main grants a revocable local media URL from an asset ID;
renderer security settings remain intact. Asset/project switches cancel playback
work and unload the element. Preview state is transient. HTML video seeks and
project-rate frame positions are approximate, particularly for VFR or differing
source/project rates; no frame-accurate decoding contract is implied. Timeline
playback/compositing, desktop imports and editing were outside T16; later
milestones below add them.

T17 replaces the static timeline overview with a scrollable, zoomable read-only
visualization. Video/audio tracks retain project insertion order and distinguish
media types with labels and colors. Exact clip start/source ranges determine
geometry; gaps and cross-track overlaps remain visible (the core still rejects
same-track overlaps). The adaptive ruler and independent playhead use project-rate
non-drop timecode, including fractional rates. Click or drag the ruler to seek;
arrow keys step one project frame and Home/End move to timeline boundaries.
Zoom controls anchor the viewport center; Ctrl/Command + wheel anchors the pointer.
Ordinary selection, playback and save updates preserve zoom and scroll.
Ruler ticks support all valid rational project rates. If a frame boundary exceeds
the project format's safe-integer precision, transient seeking and preview positions
use a bounded rational approximation; extreme rates or positions can skip frame labels.

Select a video clip, then **Preview selected clip** to link the existing source
player using that clip's source-in and timeline-start mapping. Selection alone
does not move the playhead or change its link. Ruler seeks inside the linked clip
seek its source; leaving its range pauses/hides the source and clears the link.
Source playback updates the timeline playhead, clamped to the linked clip range;
the source transport itself still spans the entire source. Library selection and
**Open video** clear the link. There is no automatic clip switching, audio-track
preview, timeline mix/compositing or frame-accurate decoding. The T16 limitations
still apply. After repeated ruler seeks, pressing Play can intermittently leave the
linked source paused and its playhead fixed. All view/transport state is transient
and resets on project replacement.

Horizontal clip and vertical track culling bound rendered DOM work. Long sequences
use a capped physical scrollbar with a proportional logical offset so SVG coordinates
stay viewport-sized; at extreme durations scrollbar navigation is correspondingly
coarser. No waveforms, thumbnails, trimming, moving, splitting or rendering controls
are introduced.

T18 adds GUI timeline editing through the shared core: move clips, change
compatible tracks, trim either edge, split, delete and snap to nearby boundaries.
Pointer proposals remain transient; release commits one undoable transaction,
while cancellation and invalid edits retain the accepted project. Toolbar and
keyboard undo/redo use the persistent CLI/GUI history. Saving retains completed
edits and history; successful edits pause and unlink source preview.

T19 adds multi-file media import and Finder drops into the library, native
thumbnails where available, video/audio/image source preview, and dragging assets
onto compatible timeline tracks or new-track targets. Imports reference original
files, deduplicate source identities and commit atomically as one history entry.
Referenced assets cannot be removed. Import requires manually installed ffprobe;
source media is never modified.

T20 adds contextual clip properties: whole-project-frame timeline position,
duration and source in/out; volume/mute; and video position, scale and opacity.
Metadata remains read-only. Numeric fields apply on Enter/blur and sliders commit
once on release, using the same core validation and history as timeline edits.
Unrelated pending edits preserve drafts; changes to a field's accepted value
synchronize it. Imports queued behind property edits use the resulting revision
and remain separate undo steps. Workspace shortcuts cover active-source
play/pause, save, undo/redo, split/delete and frame stepping while native controls
retain their keys. Save/reopen preserves edited properties and history. Clip
audio/transforms apply to CLI exports; source preview plays original media.
See [desktop usage](README.md) for property ranges, shortcuts and preview limits.

## Excluded

Desktop export controls, transitions, keyframes, fades and new audio/visual effects
are outside the current scope. Project export is available through the CLI. No FFmpeg or MLT runtime is bundled; media commands require
manually installed external tools.
Fixture generation remains an optional development utility.

The product is not an AI-native editor. An embedded assistant, LLM APIs and an
MCP server are outside the product direction. Cloud infrastructure, databases,
authentication, telemetry and backend services are also excluded from this setup.
User media must never be silently changed or overwritten.

macOS is the initial required platform. Package boundaries should stay portable;
Windows/Linux support requires explicit validation later. No distribution,
installer, updater, signing or notarization work is included through T26. Render jobs
run in the invoking process, without a persistent queue, background service or database.

## Playback and compositing milestones

T21 establishes an [architecture audit and playback baseline](T21_ARCHITECTURE_AUDIT.md)
with representative generated projects, cold/warm source seeks, playback/resource
measurements, offline exports and explicit unavailable-benchmark fallbacks. It does
not add timeline playback or change the media engine. Its task ordering is historical:
T22 implements [shared GUI/CLI sessions](adr/0011-shared-project-session.md), and
T23 implements [headless timeline evaluation](TIMELINE_EVALUATION.md).

The T23 evaluator resolves active clips, exact source times, visual layer order,
transforms, opacity, audio gain/mute and timeline gaps/boundaries from the existing
project. Export planning shares timing and property defaults with these queries.
Decoding, compositing, audio playback and live transport belong to adapters; the
evaluator itself stays headless. T24–T26 connect those adapters without making
evaluator results alone a preview/export parity guarantee.

T24 adds [edited timeline playback](TIMELINE_PLAYBACK.md), using T23 evaluation,
a single Web Audio clock and Chromium decoders. It supports cuts, trims/splits,
gaps/background, overlapping original/independent audio, volume/mute, transport,
seek/step, interruption cleanup and measurable diagnostics. T24 initially displayed
the top eligible visual; T26 replaces that restriction with ordered compositing.
Browser codec, seek and output-latency limitations still apply.

T25 adds [preview proxies and bounded caches](MEDIA_CACHE.md), with worker-backed
transcoding/frame extraction, original-media fallback and GUI/CLI management.
Source preview and final export retain original media references.

T26 adds real-time multi-layer visual composition to the existing T24 clock and
T25 proxy/cache path. Geometry and RGB alpha rules are shared with FFmpeg export;
SDR frame comparisons, rapid seeks, inspector edits and mixed-resolution playback
are covered by real Electron tests. [Playback semantics and tolerances](TIMELINE_PLAYBACK.md#composition-and-export-agreement-t26)
define the supported boundary. `pnpm benchmark:t26` measures original/proxy FPS,
drops, all-layer seeks, CPU and memory. Browser codec, HDR, source-frame selection,
16-source-run and short synthetic-workload limitations still apply. No keyframes,
transitions or new editing operations are included.

T27 adds an automated [preview/export consistency gate](PREVIEW_EXPORT_CONSISTENCY.md)
to the desktop test workflow. It checks actual Chromium Canvas draws, decoded
FFmpeg frames, independent source-frame markers, muxed audio and video
timestamps, and audio timing and gain. It also aligns mixed-rate sampling, timeline seeks and untagged VP9 color handling
for the covered cases.
