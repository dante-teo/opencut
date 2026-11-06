---
name: video-editor
description: Use the OpenCut CLI to create, inspect and validate video projects, manage media assets and timeline tracks/clips, apply atomic batches, undo/redo edits, inspect media, extract PNG frames, render a saved timeline with video/image layers, canvas transforms and mixed audio to H.264/AAC MP4, compose video clips with background music, generate composited timeline PNGs, labeled contact sheets and short audio/video previews, discover command schemas, or manage preview proxies and bounded caches.
---

# OpenCut CLI

This is the official product skill for external coding agents using OpenCut.
It will grow with the CLI to cover project inspection, modification, validation
and rendering. T03 includes a composition/export prototype. T04 adds an
interactive Electron source preview (launch with `pnpm dev`) with playback,
seeking, nominal frame stepping and performance validation under **Details & shortcuts**. This preview
has no CLI command. T16 connects it to imported video assets: select a library
video to open **Source preview**, or use **Open video** for a local source.
Imported video preview reuses stored import metadata and rechecks readability,
without running ffprobe again. Reopening refreshes availability, not stored FPS
or codec metadata.
T24 **Project viewer** plays the edited timeline: cuts, trims/splits, gaps and
background, original audio and overlapping tracks with clip volume/mute. It uses
T23 evaluation and one Web Audio clock. Ruler/slider seeking pauses; Space toggles
the active viewer and arrows step the timeline. Toggling playback or seeking during
startup cancels that start. Press Play again to resume healthy media without
switching viewers or reopening the project. Expand **Playback diagnostics**
for drop/late-frame, skew, wait and error counters. T26 composites all eligible video/image layers in track order with position, scale, opacity, fitting and canvas alpha. See the
[playback contract and supported-media limits](../../docs/TIMELINE_PLAYBACK.md). With a project
open, steps/frame positions and nominal non-drop timecode use project FPS;
otherwise steps/frame numbers use average FPS from optional ffprobe. These are
best-effort HTML video seeks, not a frame-accurate editing guarantee. VFR and
differing source/project rates may repeat or skip decoded frames. Headless timeline editing uses exact
project-rate frame boundaries through the CLI. The optional `pnpm test:preview` command measures
fixture/1080p playback in the built Electron app; see
[the preview architecture decision](../../docs/adr/0003-html-video-preview.md).
In the desktop, pointer drags seek on release and keyboard seeks are immediate.
Focus the player for Space/K playback, Left/Right or comma/period steps, Home/End
seeks. Form controls keep their own shortcuts. Preview scales to preserve aspect
ratio. Library switches cancel seeks/validation and unload the old source;
project close/replacement clears the preview and revokes media access. Viewer tab
changes pause playback. Errors for missing, corrupt and unsupported media are
recoverable by selecting another source. Transport state is never saved.
After repairing a missing file, clicking the same asset retries preview. Imported
media uses browser duration, so an audio tail can advance the nominal clock while
the final video picture remains unchanged.
The local picker, seeking and performance validation are serialized; keep the window visible
while measuring. See [desktop usage](../../docs/README.md) for optional-tool
prerequisites and the separate correctness/performance test commands.

T25 automatically prepares 960×540-or-smaller preview proxies for demanding video
(1080p+, over 60 fps, HEVC/AV1/ProRes), when its timing/audio pass verification.
Expand **Proxy & cache** in Project viewer to toggle use, inspect jobs/progress,
regenerate/cancel, set disk and PNG-memory limits, clean stale entries or clear.
New proxy availability is applied while paused at the same project position;
a playing decoder continues until the next paused refresh. Project edits cancel
obsolete proxy jobs, and fresh valid selections can restart them. Use **Regenerate
proxies** to retry deliberately cancelled or failed jobs. The first cache status
applies persisted memory limits; later changes trim decoded PNGs immediately and
adjust lookahead while playing.
Cached seek images show the frame covering the requested source instant, including
VFR intervals, and give way to a ready decoder. Source preview and final rendering
always use originals. Zero-origin videos up to 600 seconds with optional
zero-origin AAC audio are eligible; alpha-bearing videos stay original to preserve transparency; VFR timestamps are preserved and
checked. Unsupported inputs remain on originals. The default cache is
`~/.cache/opencut/media-v1` (override with `OPENCUT_MEDIA_CACHE`), 2048 MiB disk and
64 MiB encoded PNG memory; this is not a process RSS limit. CLI `cache` commands
share the same headless cache; see [cache behavior](../../docs/MEDIA_CACHE.md) and
[the CLI reference](references/cli.md). `pnpm benchmark:t25` compares actual
Electron timeline seeking/playback on generated 1080p/4K media.

T15 adds desktop project creation, open/save and read-only inspection through the
shared core. Use **New project**, configure dimensions and integer/rational FPS,
then **Save project** to a new file; existing creation destinations are refused.
**Open project** accepts CLI-created JSON. The workspace has a media library on
the left, viewer in the center, inspector on the right and timeline tracks below.
Use **Search media** and **Filter media type** to narrow the library without
changing project assets. Filters combine and reset when switching to a different
project. **Clear filters** shows the full library when a search has no matches.
Select assets to inspect metadata, or clips to inspect exact stored timing.
Unsaved projects prompt Save/Discard/Cancel before switching, closing or quitting.
T22 synchronizes CLI edits immediately with the open GUI session; named projects save each accepted edit. Project playback is available through T24; T28 adds desktop export.

T28 **Export** opens the desktop export panel. Choose a new `.mp4` destination,
a preset or resolution/FPS/H.264-or-HEVC/quality settings, then **Export video**.
Preflight checks timeline/media, encoder availability and output conflicts. Jobs show
progress, elapsed/estimated remaining encoding time, and separate validation failure,
render failure, cancellation and verified success. Hide the panel to keep editing;
the active job captures the project ID/revision and original-media references and is
unaffected by later edits or preview proxies. After reloading or reopening the window,
choose an output file again before starting another export; canceling the picker
does not enable export. The previous destination remains in the job status, which
lasts only for the current application process. Hiding and reopening the panel keeps
the current selection. Existing files are always refused.
Cancel or normal app/window close waits for process closure and cleanup. Requires
manually installed FFmpeg/ffprobe with libx264 or libx265 and AAC. Output FPS conversion
rounds duration up by less than one output frame. See [desktop export](../../docs/EXPORT.md)
for exact presets, source-file stability, limits and publication behavior. These are
GUI capabilities; the CLI keeps its existing H.264 flags/defaults and does not gain
new codec or output-FPS flags in T28.

T17 adds read-only timeline navigation: video/audio tracks retain project order;
clip positions, gaps and cross-track overlaps follow exact stored timing. Use the
**Zoom** control or +/− (center anchor), Ctrl/Command + wheel (pointer anchor), and
horizontal/vertical scrolling. Click/drag the ruler to seek; focused Left/Right
step one project frame and Home/End seek boundaries. The timeline clock displays
project-rate non-drop timecode. Selection alone does not move the playhead.
Ruler ticks support all valid rational rates. Frame boundaries beyond safe JSON
integer precision use bounded playhead approximations; extreme rates or positions
can skip frame labels. See the [exact-time contract](../../docs/PROJECT_FORMAT.md#exact-time)
for the distinction between transient UI positions and persisted timing.

**Preview selected clip** explicitly links a video clip to source preview at its
source-in. Ruler seeks within it map to source time; source playback updates the
playhead clamped to the clip range while transport remains full-source. Seeking
outside the clip pauses/hides and unlinks the source. Library selection or
**Open video** also unlinks. Source preview does not switch clips automatically; select Project viewer for T24 audio mixing and T26 video/image compositing. T16 source-seek precision limitations still apply.
Known limitation: repeated ruler seeks followed by **Play** can leave the linked
source paused. Confirm that the source clock advances when checking playback.
Zoom/scroll persist during selection/playback/save, and reset on project replacement.
The timeline culls offscreen clips/tracks and caps the physical scrollbar for long
sequences; extreme-duration scrollbar navigation is coarser. Waveforms remain
unavailable. CLI edits synchronize automatically.

T18 adds GUI clip editing through the same core transactions as the CLI. Drag
clip bodies to move or change compatible tracks, and drag edges to trim while
pinning the opposite edge. Core validation rejects overlaps, incompatible tracks
and source-bound violations. A translucent preview shows valid proposed edits;
invalid proposals mark the original clip red and show an error. Release commits
one undoable operation; Escape/cancel/lost capture/blur discard the preview.
**Snap** uses a configurable **Snap px** radius (default 8 screen pixels) at any
zoom, aligning either moving edge or the trimmed edge to other boundaries, zero
and the playhead. GUI-edited boundaries use project frames. Edge trimming requires
frame-aligned clip start and source-in; use the CLI to align off-grid clips first.
**Split at playhead**
(S) and **Delete clip** (Delete/Backspace) act on the selection. **Undo** / **Redo**
(Ctrl/Command+Z / Shift+Z) restore shared CLI/GUI history, including media
imports/removals. When undo/redo changes assets or their references, availability
is refreshed before accepting the restored state; a failed refresh retains the
previous session. Clip-only edits retain the availability snapshot. These checks
verify readability without refreshing stored probe metadata or modifying media.
Focused clips support Left/Right frame moves (Shift: ten) and Up/Down compatible
tracks; focused edge handles
support Left/Right trims, without proximity snapping. Named projects automatically persist completed
edits and history; inspect with `timeline list` to verify. Save gives untitled projects a path. Successful
edits pause/unlink source preview and retain the project playhead. Zoom is locked
during gestures; scroll manually to reach offscreen targets. Transitions and keyframes remain unavailable.

T19 adds **Import media** (multi-selection) and Finder file drops into the library.
ffprobe must be installed manually and available on PATH. Imports reference
originals, reuse file identity duplicates and commit each batch as one undo step;
any failed file leaves the batch unchanged. Unsaved projects can import before
saving; these assets use absolute paths that remain absolute after saving.
Undo/redo refreshes changed asset availability even before the first save;
restored readable assets can be dragged again, while missing sources remain offline.
The library shows type, duration and small cached video thumbnails with FFmpeg;
stills use the native thumbnail service where available, with icon fallback.
Timeline clips show source-aligned video/still filmstrips and real audio waveforms
with FFmpeg. Artwork follows trims, splits, scroll and zoom, loads only in the
visible area, and labels unavailable media. It identifies original source content;
it does not apply clip transforms, opacity or audio gain/mute. Nearby filmstrip
samples are batched without moving later frames into earlier sample slots.
Eligible macOS H.264/HEVC batches can select VideoToolbox when measurements favor
it; hardware decoding is not forced for every thumbnail. See
[artwork behavior](../../docs/TIMELINE_PLAYBACK.md#timeline-clip-artwork) and
[navigation caches](../../docs/MEDIA_CACHE.md#navigation-artwork).
Playback/cache disclosures open over the viewer; diagnostics and source performance
results show readable measurements rather than raw JSON. Frame-aligned inspector
timing uses project timecode; a source range with an off-grid endpoint keeps both
endpoints as exact rational seconds.
Select video/audio/image assets for source preview; browser codec support applies.
Switching to Project viewer pauses audio, and replacing a source unloads the old
media element. Drag library assets to compatible timeline lanes or **+ Video track** / **+ Audio
track** targets (new tracks start their clip at the playhead). Lane drops use scroll/zoom-aware project frames and the Snap controls.
Timed sources use complete frames within their duration; stills default to about
five seconds. A new track and clip form one undoable edit. Incompatible or
overlapping drops fail without edits. External files must first enter the library.
Select an unused asset, then **Remove asset**; referenced assets are protected.
Save/reopen and use CLI `media list` / `timeline list` to inspect saved GUI edits.
Advanced library organization and transitions remain unavailable.

T20 adds contextual clip properties in the inspector. Timing uses whole project
frames (timeline position, duration, source in/out); audio uses linear volume 0–1
and mute; video transforms use pixel X/Y, scale 0.01–4 and opacity 0–1. Enter or
leave a field to apply, Escape discards a numeric draft, and sliders apply once
on release. Core constraints reject invalid edits atomically. Off-grid or unsafe
timing remains read-only rather than being rounded. Metadata remains read-only.
An unrelated edit finishing does not discard another field's draft; a change to
that field's stored value, including undo/redo, synchronizes it. Picker imports
and file drops queued behind property edits use the resulting revision and retain
their own undo step.
Property edits share T09 history with imports and timeline gestures. Undo restores
a deleted clip's selection; Save/reopen retains properties and history. Use CLI
`timeline list` to inspect the saved result. Clip audio/transforms apply to CLI
exports. Project viewer applies clip audio and T26 visual transforms/compositing; Source preview plays original media.

Workspace shortcuts outside typing/native controls: Space toggles the active
viewer; Command+S saves; Command+Z / Command+Shift+Z undo/redo; S splits the
selection at the playhead; Delete/Backspace deletes it. Control replaces Command
on Windows/Linux. Left/Right step the active video source or the Project viewer's
playhead. Focused clips/handles retain arrow-key move/trim; form controls retain
native keys. Existing player-local K, comma/period and Home/End remain available.

T05 adds a versioned project data model, exact rational time, JSON save/load,
validation and media availability checks as headless core APIs. See
[the project format](../../docs/PROJECT_FORMAT.md) when using those APIs directly.
T06 exposes `project create`, `project info` and `project validate` in the CLI.
T07 adds `media import`, `media list`, `media info` and `media remove` with stable
asset IDs, persisted metadata, source availability and atomic project updates.
T08 adds timeline inspection, video/audio track management and clip add/move/trim/split/remove
through shared headless operations. T09 adds atomic batches, persistent undo/redo,
dry-run and revision checks. T11 extends saved single-video-track rendering with original audio, independent audio tracks, overlap mixing, clip volume and muting, and H.264/AAC MP4 output.
T12 adds overlapping video/image layers, per-clip position/scale/opacity and contain/cover/stretch fitting, canvas dimensions/background and portrait/square output.
T13 adds JSONL progress, SIGINT/SIGTERM cancellation, quality/resolution presets and explicit atomic export replacement.
T14 validates the complete 18-second editing/export workflow using fresh CLI processes,
including persistence, dry-run, rejected edits, undo/no-op/redo, decoded frames and audio.
Follow the [complete tested workflow](references/workflow.md) to reproduce it or adapt
its public commands to other media. Run `pnpm e2e --keep` from the checkout root for
a verified MP4, representative PNGs, ffprobe results and a CLI transcript in a new
isolated generated directory. `pnpm test:e2e` runs it twice and cleans each run.
For image-only stories and collages, follow the [portrait/photo adaptation](references/workflow.md#photo-slideshows-and-vertical-edits),
including imported caption/music assets and project cleanup boundaries.
For personal footage and screen recordings, follow the
[screen-recording adaptation](references/workflow.md#screen-recordings-and-personal-footage)
for varied shot selection, external orientation/crop preparation, per-aspect framing
and export/desktop verification. Keep personal demo media outside test fixtures.
Preview transport and path-based media commands do not modify project data.

From an installed and built OpenCut checkout, run `pnpm cli --help` to discover
supported capabilities and `pnpm cli --version` to check the application version.
If the CLI has not been built, run `pnpm build` from the checkout root first.
For a CLI-only build, run `pnpm build:packages` and then
`pnpm --filter @opencut/cli build`.
For result fields, direct executable forms, safety rules and exit codes, read
[the current CLI reference](references/cli.md) when needed.

Implemented commands (use the direct Node form for clean JSON stdout):

```sh
node apps/cli/dist/index.js project create /path/to/new.opencut.json --name "My project" --fps 30000/1001 --json
node apps/cli/dist/index.js project info /path/to/new.opencut.json --json
node apps/cli/dist/index.js project validate /path/to/new.opencut.json --json
node apps/cli/dist/index.js project render /path/to/new.opencut.json --output /path/to/new-render.mp4 --json
node apps/cli/dist/index.js media import /path/to/new.opencut.json /path/to/video.mp4 --json
node apps/cli/dist/index.js media list /path/to/new.opencut.json --json
node apps/cli/dist/index.js media info /path/to/new.opencut.json ASSET_ID --json
node apps/cli/dist/index.js media remove /path/to/new.opencut.json ASSET_ID --json
node apps/cli/dist/index.js probe /path/to/video.mp4 --json
node apps/cli/dist/index.js extract-frame /path/to/video.mp4 --timestamp 0.5 --output /path/to/new-frame.png --json
node apps/cli/dist/index.js compose /path/to/clip1.mp4 /path/to/clip2.mp4 --music /path/to/music.wav --output /path/to/new-composition.mp4 --json
```

Project create/info/validate need no media tools or Electron; project render needs FFmpeg and ffprobe. Choose an explicit project-file
path; relative paths use the working directory. Creation requires `--name` and a
new destination in an existing directory. Existing files and symlinks are refused.
Defaults are 1920×1080 at 30/1 fps; use `--width`, `--height` and integer or rational
`--fps` to configure settings. Use `30000/1001`, rather than decimal `29.97`.
Info returns metadata, settings and asset/track/clip counts even with offline media.
Validation checks project data, internal references and regular-file readability;
it does not decode media. It returns a JSON report for invalid data and unavailable
media with exit 1; `structureValid` distinguishes valid offline data from data
errors. File-read failures produce no report. Read
[the project command reference](references/cli.md#projects) for fields and exit codes.

Import one video/audio/image at a time with an explicit project path. Both CLI
paths resolve from the working directory; persisted references resolve from the
physical project directory. Directory symlinks work consistently for import,
list/info and validation. Import reads the original in place and uses ffprobe; never
copy or modify user media as an implicit import step. A normalized path, symlink
or hard link to the same file returns its existing asset ID with `imported: false`;
do not assume equal contents at different file locations are duplicates.
Use the returned stable `asset.id` for info/remove. Persisted metadata includes
kind, duration, dimensions, codecs, frame rate and audio presence; unknown values
are null. Image duration/FPS are null. List/info check availability and still
succeed for offline sources; use project validate to require readable sources.
Removal deletes only the project entry and refuses any asset referenced by clips.
No force-delete, relink or refresh command exists. Read back list/info after
successful mutations. Project updates refuse project-file symlinks/hard links, use an atomic
rename and serialize cooperating writers with an OS-backed `.opencut-lock`; retry when busy.
Never delete that permanent sidecar: crashes release ownership automatically.
Legacy `.lock` files require confirming old writers have stopped before removal. See
[the asset reference](references/cli.md#project-media-assets) for results and limits.

For timeline edits, read [the editing reference](references/cli.md#timeline-editing)
for syntax, JSON results and exact semantics. Use returned stable IDs and read
`timeline list PROJECT --json` before choosing tracks or positions. CLI `--at`,
`--in` and `--out` are nonnegative integer **project-frame indices**, including
source points, not source-file frame numbers or seconds. Out is exclusive;
splits use absolute timeline positions. Trim fixes timeline start; move fixes
source points. Same-track overlaps fail; touching ends and cross-track overlap
are allowed. No implicit ripple or repositioning occurs. Track removal requires
an empty track. Unknown-duration assets/images require explicit ranges without
an inferred finite bound; known durations are enforced. Offline editing needs
no media tools and does not refresh metadata or verify decodability.
Read back `timeline list` after each successful mutation. Inspect exit status
before parsing JSON; errors are structured on stderr with `--json`. Timeline updates reuse the
atomic-save and lock rules above. Pre-T08 overlapping documents fail validation;
correct them explicitly before editing.

For transactions, read [the batch/history reference](references/cli.md#transactions-undo-and-redo).
Run `edit history PROJECT --json` to obtain the current revision. Use
`edit apply PROJECT BATCH.json --dry-run --json`, then apply with the same required
batch `expectedRevision` after reviewing the preview. Use explicit new IDs when
later operations refer to them in the same batch. All intermediate states must be
valid; any failure discards the whole batch. Batch times are project-frame indices.
`edit undo PROJECT [--expected-revision N] --json` and `edit redo PROJECT
[--expected-revision N] --json` restore exact content with increasing revisions.
Individual track, clip and media mutations share persistent history and accept
`--dry-run` / `--expected-revision`. Changed edits after undo clear redo. No-ops,
including batches whose edits cancel out, preserve revision, timestamps and both
history stacks. A batch can return operation results with `changed: false`; those
results do not imply a saved change. On conflict, reload history/content and
reconsider the edit before retrying. A dry-run is a preview, not a saved edit; IDs/timestamps can differ on
real apply. Read back history and timeline/media state after successful mutations.

For saved timeline rendering, read [the rendering reference](references/cli.md#project-rendering).
Run `project render PROJECT --output NEW.mp4 --json` after reading the timeline.
Use one or more video tracks with at least one video/image clip and any audio tracks.
Later video tracks draw above earlier tracks; same-track overlaps remain forbidden.
Use `canvas set PROJECT --width 1080 --height 1920 --background-color '#183048' --json`
for portrait output (or 1920×1080 / 1080×1080 for landscape/square).
Use `clip visual PROJECT CLIP_ID --fit contain --scale 0.5 --x=-100 --y 200 --opacity 0.75 --json`;
`clip add` accepts the same flags. Defaults: centered x/y offsets 0, scale/opacity 1,
contain. Scale multiplies the canvas fitting rectangle; contain keeps transparent
margins, cover crops centrally, stretch fills. Opacity multiplies source alpha.
Images use explicit in/out ranges as duration, including split clips. Background
shows through gaps and transparent areas. Visual opacity does not mute audio.
Canvas/visual mutations and batch canvas.set/clip.visual support history and dry-run.
For a complete batch and its expected frame count, follow the
[layered portrait example](../../docs/CLI.md#layered-portrait-render-example).
Original video audio is preserved; sources without audio supply silence.
Subframe timing and unsupported settings fail explicitly. Frame rate comes from the project; resolution defaults to project dimensions: even sides up to 3840, total pixels up to 3840×2160
(including 2160×3840 portrait), rational 1–120 fps,
at most 64 clips across all tracks and 600 seconds including gaps. Source in/out use the
project-rate sampling grid relative to the first video frame; out is exclusive.
Split clips preserve the sampled video sequence and audio timing. Use separate
audio tracks for overlapping clips. Add imported music with frame-based source
ranges/positions; music does not loop automatically. An audio tail extends video
with the canvas background. Muted and zero-gain clips still contribute to output duration.
Referencing a video asset on an audio track also leaves its original video audio
active; mute the video clip explicitly when using only the independent audio clip.
Settings and edits apply per clip, without automatically changing other clips
that reference the same asset. Configure video/audio clips with
`clip audio PROJECT CLIP_ID --volume 0.25 --muted false --json` or the same flags
on `clip add`. Volume is linear amplitude in [0, 1], default 1; 0 is silence.
Mute defaults to false, overrides gain and preserves the stored volume. Split,
trim, move, batches and undo/redo preserve these settings. Mixing sums gains
without normalization; the existing latency-compensated safety limiter caps peaks.
Output always includes 48 kHz stereo AAC, even for silence. Audio source zero
uses the first video frame for video assets or first audio sample for audio-only
assets; relative stream delays are retained. Audio tracks require a current audio
stream and known in-bounds range. Absolute boundaries round to 48 kHz samples;
fractional splits can differ by one sample and decoded AAC can have EOF padding.
Only referenced assets must be
online; the saved project and its history remain unchanged. Choose a new `.mp4`
in an existing writable directory supporting hard links. Use `--quality draft|balanced|high`
(default balanced) and `--resolution project|720p|1080p` (default project) for export
presets. Resolution presets fit and scale the finished canvas, preserving orientation
and layer layout; they may upscale. Output sides round down to even pixels, minimum
2, while exact preset dimensions stay exact (704×396 → 1920×1080 with `1080p`).
These options apply only to the export and are not saved in project settings or history.
With `--json`, parse **each stdout line** as
an event: `progress` includes phase, percent, processed/total frames, elapsed seconds
and nullable remaining seconds. Encoding 100% is followed by verification; require
exit 0 and `event: "completed"` before using the final result. Runtime failures emit
`failed`, cancellation emits `cancelled`; invalid arguments emit no events.
Human progress and diagnostics go to stderr. Send SIGINT or SIGTERM to cancel;
wait for exit 130/143 and cleanup. Existing outputs are refused unless `--overwrite`
is explicit; replacement happens atomically after verification and never targets
source media or the project. Failure/cancellation preserves prior exports. SIGKILL
cannot clean temporary files. Check `frameCount`,
`frameRate` and measured metadata in the result, and inspect/decode the output
before claiming completion. The CLI verifies metadata and decoded frame count
before publishing; handled failures leave no partial destination.

Probing needs `ffprobe` on PATH; extraction/composition also need `ffmpeg`. Never silently
install these tools. Inspect metadata before selecting a timestamp. Use finite,
nonnegative decimal seconds relative to input start, below the selected video's
known end. Compute that end as `video.startTimeSeconds - startTimeSeconds + video.durationSeconds`
when all three fields are known; it includes any delay before the video starts.
Preserve negative start timestamps when calculating that offset.
A seek beyond the last available frame can still fail. Unknown metadata is
`null`; audio-only files have no video to extract. Frame rate is an average.

Choose an explicit new `.png` output in an existing directory. Extraction never
overwrites existing files or symlinks and does not modify the source. Read back
the result and inspect the saved PNG before claiming delivery. Errors are structured
on stderr with `--json`; check exit status before parsing stdout.

For composition arguments, timing, gains and result fields, read
[the composition reference](references/cli.md#composition). Provide 2–16 timed
video clips in order and a background audio file. The default output is
1280×720 at 30 fps, with letterboxing, 48 kHz stereo audio, original gain 1 and
music gain 0.25. Use `--clip-volume 0` for music only. Music loops/trims to fit;
the duration is the sum of frame-rounded video durations, up to 600 seconds.
Use a new `.mp4` path in an existing directory. Original clips are read only;
existing destinations and symlinks are refused. Read back the resulting metadata
and decode or play the output before claiming delivery. Composition is an FFmpeg
spike, with a 10-minute encoder limit; it requires FFmpeg 8+ with libx264/AAC and
standard filters. It is not the final rendering architecture.

Do not invent additional project, media, edit, render or MCP commands. Explain
the current limitation when a workflow needs them. Probing reads metadata;
it does not validate full-file decodability.

For the T21 capability boundary and reproducible playback baseline, read
[the architecture audit](../../docs/T21_ARCHITECTURE_AUDIT.md). From a development
checkout, `pnpm audit:t21` creates isolated synthetic projects and measurements;
`pnpm audit:t21 --headless` explicitly skips desktop measurements. These commands
never benchmark user media. Source playback with a multi-track project loaded and
playback of a rendered MP4 are not live timeline composition. Missing benchmarks
must be reported as unavailable, with the recorded reason; do not substitute export
success or old measurements for a real-time preview claim.
Retained baseline files are historical observations. Check their revision, working
tree state and harness hashes before citing them as current evidence. Refresh
playback evidence with a new full `pnpm audit:t21` run; do not relabel an older
report or substitute a headless run for desktop measurements.

## Shared GUI/CLI sessions (T22)

On macOS/Linux, use the same CLI commands while Electron has the project open.
All reads and edits route transparently through the authoritative session, with
one revision and undo/redo history. Named GUI projects save on every accepted edit;
untitled projects require Save first. Inspect `edit history`, then use
`--expected-revision` for edits based on that observation. Concurrent proposals
can fail with `REVISION_CONFLICT`, `SESSION_BUSY` or `PROJECT_LOCKED`; reload and
reconsider rather than blindly retrying.

CLI edits and undo/redo preserve timeline zoom, horizontal/vertical scroll, Snap
and its threshold. Explicit Open/reopen resets timeline view settings and can
select an older backup with the same project ID, including at the same path.
After reopening, inspect `edit history` again before choosing an expected revision.

A disconnect or timeout can leave the commit outcome unknown. Query history and
content before retrying; the CLI never silently falls back to disk after sending
a mutation. After normal exit or a crash, standalone CLI edits resume against
the last complete saved state. Do not delete `.opencut-lock`, mix old-version
writers with T22, or use network filesystems. Transport is private to the current
OS account, limited to 64 MiB per message, and is not implemented for Windows.
T22 does not add timeline playback. See
[the shared-session contract](../../docs/CLI.md#shared-projects-in-electron-t22).

## Headless timeline evaluation (T23)

Core APIs `evaluateTimeline(project, rationalTime)` and
`evaluateTimelineFrame(project, frameIndex)` inspect active layers, exact source
times and audio mixing candidates without media tools. Export planning shares
their timing/order/property resolution. T29 exposes these queries through
`timeline inspect --frame N`; the queries perform no playback themselves; Project viewer uses them for live T24–T26 playback. Read [evaluation semantics](../../docs/TIMELINE_EVALUATION.md)
for half-open boundaries, metadata uncertainty and export-specific limits.

T26 uses the same headless geometry and RGB source-over composition rules in
Project viewer and final rendering. Canvas colors accept `#RRGGBB`, `#RRGGBBAA`
or `transparent`; H.264 flattens canvas alpha over black. Transparent source pixels
and clip opacity reveal lower layers. Paused frame-cache requests are bounded
across visible layers and stale completions cannot paint after seeking/editing.
The player owns at most 16 source-run entries, including still images. The worker
encoded-PNG and renderer decoded-PNG caches each apply the configured memory
limit independently; native decoder/GPU memory is outside those bounds.
For source-aspect/coordinate rules, SDR tolerances and limitations read the
[composition contract](../../docs/TIMELINE_PLAYBACK.md#composition-and-export-agreement-t26).
`pnpm benchmark:t26` measures real Electron multi-layer FPS, drops, seek latency,
CPU and memory on generated fixtures. Report actual results and remaining limits;
never substitute a source player or exported MP4 for live multi-layer evidence.

For preview/export investigations, run `pnpm test:consistency` from a development
checkout. The [T27 consistency gate](../../docs/PREVIEW_EXPORT_CONSISTENCY.md)
checks Chromium Canvas frames against decoded FFmpeg export frames and records
independent frame identity, audio timing, gain and mute evidence. It adds no CLI
editing commands.

## Agent discovery and visual verification (T29)

Start with `node apps/cli/dist/index.js help --json` after building. Discover
command arguments/options, prerequisites, units, defaults, limits and statuses
without reading internal source. `help preview --json` scopes the command list.
Use `resultSchema` and `schemas` for the five versioned T29 result contracts.
Check exit status and `jsonOutput`; project render/cache proxy stream JSONL.
SDK, scripting runtime and MCP remain unavailable.

Read `project inspect PROJECT --json` for revision, settings, asset references,
tracks, clips and exact duration (without undo snapshots). Read
`timeline inspect PROJECT --frame 20 --json` for ordered active layers, exact
source mappings, gain/mute and audio candidates. Both work offline without media
tools and return the authoritative session snapshot when Electron is open.
Use the returned revision for subsequent existing `--expected-revision` edits.
Inspection/preview `--json` and `--help`/`-h` may appear before the group, between
group and action, or after the action. For example, `project --json inspect PROJECT`
and `timeline --json inspect PROJECT --frame 20` return the usual inspection
results; `preview --json -h frame` returns scoped discovery/help. Option ordering
does not make command-specific flags valid on other commands. Use `--version`
alone, optionally with `--json`.

Verify edited composition using these native-tested command forms, choosing
valid frames/ranges from inspection:

```sh
node apps/cli/dist/index.js preview frame PROJECT --frame 20 --output /path/to/new-frame.png --json
node apps/cli/dist/index.js preview contact-sheet PROJECT --from 0 --to 66 --count 4 --columns 2 --size 160 --output /path/to/new-sheet.png --json
node apps/cli/dist/index.js preview clip PROJECT --from 12 --to 42 --size 160 --quality high --output /path/to/new-preview.mp4 --json
```

All times are safe integer **project-frame indices**, with exclusive `--to`.
These examples cover a 30 fps project: four sheet positions 0/21/43/65 and a
one-second clip. `preview frame` defaults to project dimensions. Sheets default
to the full timeline, up to eight uniform samples, four columns and size 320;
they allow at most 16 samples and size 640. Clips require from/to, allow at most
30 seconds and default to size 640/quality draft. `--size 64..1920` caps finished
frame/clip dimensions without upscaling; quality accepts draft/balanced/high.
See [the inspection reference](references/cli.md#agent-discovery-and-timeline-previews-t29)
for exact options/results, resource limits and errors.

Visual inspection is headless and uses the existing original-media export
compositor, preserving layer ordering, transforms, source sampling and audio
mixing. It never substitutes a selected source asset for the timeline. PNGs
flatten canvas alpha over black; sheets add labels outside each image. Referenced
visual media must be available even outside the selected range; clip previews
also validate audio. Existing whole-project export limits and T27 SDR/color
limitations apply. Empty/audio-only projects are inspectable but cannot generate
visual previews. Late requests can decode preceding frames.

Choose new explicit PNG/MP4 paths in existing directories. Outputs never modify
project/history/source media or overwrite files. Success is one JSON document on
stdout; clip progress JSONL and errors go to stderr. Require exit 0, parse the
version/revision, then inspect the saved PNG/sheet or decode/play the clip before
claiming verification. Handled failures/cancellation clean temporary output;
SIGINT/SIGTERM exit 130/143. SIGKILL cannot clean up. A generated preview is visual
inspection evidence, not evidence of interactive playback performance.
