---
name: video-editor
description: Use the OpenCut CLI to create, inspect and validate video projects, manage media assets and timeline tracks/clips, apply atomic batches, undo/redo edits, inspect media, extract PNG frames, render a saved timeline with video/image layers, canvas transforms and mixed audio to H.264/AAC MP4, or compose video clips with background music.
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
The **Project viewer** tab currently shows a canvas placeholder. With a project
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
Reopen after CLI edits; stale saves are refused. Project playback and rendering controls remain unavailable.

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
**Open video** also unlinks. No automatic clip switching, image/audio timeline
preview, mixing or compositing is available; T16 precision limitations still apply.
Known limitation: repeated ruler seeks followed by **Play** can leave the linked
source paused. Confirm that the source clock advances when checking playback.
Zoom/scroll persist during selection/playback/save, and reset on project replacement.
The timeline culls offscreen clips/tracks and caps the physical scrollbar for long
sequences; extreme-duration scrollbar navigation is coarser. No waveforms or
rendering controls are added. Reopen after CLI edits.

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
support Left/Right trims, without proximity snapping. Save persists completed
edits and history; reopen and inspect with `timeline list` to verify. Successful
edits pause/unlink source preview and retain the project playhead. Zoom is locked
during gestures; scroll manually to reach offscreen targets. Transitions, keyframes, project playback and rendering controls are not added.

T19 adds **Import media** (multi-selection) and Finder file drops into the library.
ffprobe must be installed manually and available on PATH. Imports reference
originals, reuse file identity duplicates and commit each batch as one undo step;
any failed file leaves the batch unchanged. Unsaved projects can import before
saving; these assets use absolute paths that remain absolute after saving.
Undo/redo refreshes changed asset availability even before the first save;
restored readable assets can be dragged again, while missing sources remain offline.
The library shows type, duration and native thumbnails where available (macOS/Windows; icon fallback otherwise).
Select video/audio/image assets for source preview; browser codec support applies.
Switching to Project viewer pauses audio, and replacing a source unloads the old
media element. Drag library assets to compatible timeline lanes or **+ Video track** / **+ Audio
track** targets (new tracks start their clip at the playhead). Lane drops use scroll/zoom-aware project frames and the Snap controls.
Timed sources use complete frames within their duration; stills default to about
five seconds. A new track and clip form one undoable edit. Incompatible or
overlapping drops fail without edits. External files must first enter the library.
Select an unused asset, then **Remove asset**; referenced assets are protected.
Save/reopen and use CLI `media list` / `timeline list` to inspect saved GUI edits.
No waveforms, advanced organization, transitions or rendering controls are added.

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
rename and serialize cooperating writers with a `.lock`; retry when busy.
Remove a stale lock only after checking that no writer is active. See
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
before parsing JSON; errors remain text on stderr. Timeline updates reuse the
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
the result and inspect the saved PNG before claiming delivery. Errors are text
on stderr even with `--json`; check exit status before parsing stdout.

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
