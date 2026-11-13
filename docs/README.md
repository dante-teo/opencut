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
complete files without overwriting existing destinations. Hide the panel to keep editing.

T29 adds [agent discovery and headless visual inspection](CLI.md#agent-discovery-and-visual-inspection-t29):
`help --json`, revision-tagged project inspection, exact frame-based timeline
inspection, composited PNGs, labeled contact sheets and short preview clips with
mixed audio. Previews use the existing original-media export compositor without
launching Electron and preserve the project and source media. Clips are limited
to 30 seconds and sheets to 16 samples; existing export limits still apply.

T30 adds the [TypeScript workspace SDK](SDK.md) and
[`opencut run`](CLI.md#typescript-scripts-and-sdk-t30) for trusted local scripts.
Scripts can stage edits, inspect and render them, and publish the edits as a
single undo step in headless or open Electron projects.

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

Select a media clip to edit **Timeline position**, **Duration**, **Source in/out** in
whole project frames, **Volume** (linear 0–1), **Mute**, **Fade in/out**, and video **Position X/Y**
(pixels), **Scale** (0.01–4), and **Opacity** (0–1). Enter or leave a numeric field
to apply; Escape discards its draft. Sliders apply on release as one undo entry.
Typing in another field while an edit finishes preserves that field's draft.
Changes to its stored value, including undo/redo, synchronize the field.
Core validation rejects overlaps, invalid source ranges and invalid values without
changing the project. Off-grid or unrepresentable timing remains visible as exact
stored times but cannot be silently rounded through the numeric editor.
Source preview plays original media. Project viewer applies clip volume/mute and
mixes overlapping audio and composites ordered video, image and text layers.

Outside text fields and native controls, **Space** toggles the active viewer,
**Command+Z / Command+Shift+Z** undo/redo, **Command+S** saves, **S** splits at the
playhead, and **Delete/Backspace** removes the selected clip. Windows/Linux use
Control as the command modifier. Left/Right step the active video source, or the
project playhead in Project viewer. Focused clips and edge handles retain their
existing arrow-key move/trim behavior; controls retain their native keys.
Undo/redo spans library imports, timeline gestures and properties, restores a
deleted clip's selection when it returns, and remains available after save/reopen.

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

Use **New project** to enter a name, width, height and integer or rational frame
rate (for example, `30000/1001`). **Create project** opens an unsaved project;
**Save project** chooses a new `.opencut.json` file in an existing directory.
Existing files and symlinks are refused for new projects, even if the native
save dialog offers replacement. **Open project** reads the same JSON files as
the CLI. **Save project** on an existing project uses the core's lock, revision
check and atomic update; saving unchanged content preserves timestamps and history.
External changes are refused: reopen the project to refresh before saving.
On macOS, first Save on exFAT can fail with `Writer sidecar changed during acquisition`.
Use a local APFS volume for the project file in that case. See the
[shared writer limits](adr/0011-shared-project-session.md#failure-semantics-and-limits).

Project metadata/settings, imported assets (including missing-media warnings),
and video/audio tracks and clips appear in a docked editor workspace: media
library on the left, viewer in the center, inspector on the right, and a timeline
below. Select an asset or clip to inspect its stored details. Timeline blocks
show relative positions and durations. Video and still clips have filmstrips.
Video clips with audio and audio-only clips also show waveforms. Artwork follows
the trimmed source range and loads for visible clips with FFmpeg. Placeholders
appear while artwork loads or if decoding fails. The graphics show source
content before applying clip transforms or gain.
See [timeline artwork](TIMELINE_PLAYBACK.md#timeline-clip-artwork) for sampling,
cache and hardware-decoding behavior.

Stored timing remains exact. The inspector uses project timecode for frame-aligned
timing and rational seconds for off-grid boundaries. If either source-range
endpoint is off-grid, both endpoints retain their exact rational values.
Playback and cache disclosures open over the viewer without resizing the picture;
diagnostics use readable values instead of JSON. T22 synchronizes CLI edits
through the active session and pushes updates immediately; there is no
file-watching loop.
Project management needs no FFmpeg or ffprobe. Closing, quitting, creating or
opening another project offers **Save**, **Discard**, and **Cancel** when the
current project is unsaved. Canceled dialogs and failed saves preserve it; failed
opens leave the current project displayed. Operations run one at a time, with
loading indicators and errors shown in the workspace. New projects and edited
timelines can be unsaved. **Save snapshot** writes a separate project copy and
**Package project** gathers the project and media in a new folder. Use **Export**
for local MP4 export.

Use **Import media** to choose several video, audio or image files, or drop files
from Finder into the media library. Import requires ffprobe on PATH; original
files are referenced in place. Each batch is one undoable edit and commits only
if every source succeeds. Existing file identities (including aliases) reuse the
existing asset. Progress identifies the current file; errors preserve the session.
Picker imports and file drops queued while a property edit is applying run after
that edit, using the resulting project revision. The property change and import
remain separate undo steps.
Unsaved projects can import before their first save, using absolute references.
Saving preserves those absolute references; it does not relocate the media or
convert them to project-relative paths.

With a project open, choose **Browse online** to search Wikimedia Commons for
images, audio or video, or Openverse for images and audio. Search and previews
use the providers' public services without an account, API key or OpenCut
server. Results show the creator and reuse terms. **Open source** opens the
provider's original listing. **Add to project** downloads the file into
OpenCut's application data and imports it as one undoable edit. Imports support
files up to 512 MiB. Wikimedia videos in formats that the editor cannot play,
such as Ogg Theora, use the best available Wikimedia WebM rendition. When a
result offers only **Open source**, download the file there and use the local
importer. GIF and APNG results appear in image searches. On import, OpenCut
classifies them as timed video when ffprobe reports a duration and as still
images when it does not. Openverse direct downloads currently support Wikimedia
Commons files and Flickr images.

Imported media plays and exports offline. Keep the downloaded originals in
place, including when restoring or moving a project to another machine. Select
the imported asset in **Project** to read its source and credits. The project
records the provider, creator, source and license. Verify reuse requirements on
the source page before publishing, especially for ShareAlike works.

Use **Search media** to filter filenames, and **Filter media type** to show video,
audio or images. Filters combine, affect only the library view, and reset when
switching to a different project. **Clear filters** shows the full library when a
search has no matches.

The library shows type, duration and cached video thumbnails when FFmpeg is available;
still thumbnails use the native service where supported, with icon fallback. Select media for source
preview: video uses the existing transport, audio uses native playback controls,
and images show a still. Browser codec support limits source playback.
Drag a library asset onto a compatible track, or onto **+ Video track** / **+ Audio
track** to create a track and clip together at the playhead. Drop x-position includes timeline
scroll and zoom, rounds to project frames and respects **Snap**. Timed sources use
all complete project frames; stills default to the nearest five-second frame
count. A video with audio may also be placed on an audio track. Core validation
rejects overlaps and incompatible tracks without partial changes. External files
must enter through the library first; scroll manually to reach distant lanes.
Select an unused asset and click **Remove asset**; used assets are protected.
Named projects automatically persist library changes, clips and shared undo/redo history;
`media list` and `timeline list` expose the same saved data in the CLI.

The timeline preserves project track order, with separate video/audio styling.
Gaps and overlaps across tracks follow stored rational timing. Select a clip for
inspection; selection leaves the playhead unchanged. Click/drag the ruler to seek,
or focus it and use Left/Right (one project frame) and Home/End. The timeline clock
uses exact project-frame non-drop labels, including `30000/1001`. Choose **Zoom**
or use +/− to zoom around the viewport center. Ctrl/Command + wheel zooms around
the pointer. Use horizontal/vertical scrolling to reach distant clips and tracks.
Zoom, both scroll axes, and snapping preferences survive synchronized CLI edits
and undo/redo. Zoom and scroll also survive selection, playback and saving;
replacing/reopening the project resets view state. Older backups can be opened
even when they retain the same project ID and have a lower revision.
Clips and tracks outside the viewport are culled.
Ruler ticks support valid rational rates even when their frame times exceed JSON
integer limits. In that case, playhead seeks and preview positions use a bounded
rational approximation; extreme rates or positions can skip frame labels.
See the [exact-time contract](PROJECT_FORMAT.md#exact-time) for the distinction
between transient UI positions and persisted project timing.

Drag a clip body to move it; drag vertically to another compatible track. Drag
an edge to trim the source range, keeping the opposite timeline edge fixed.
The core enforces source limits, track compatibility and no same-track overlaps.
A translucent outline shows the core-validated proposal; invalid proposals mark
the original clip red and show an error. Release commits one undoable transaction.
Escape, pointer cancellation, lost capture or window blur cancel a gesture. Pointer
movement never writes the project file. Completed edits and history are saved
atomically for named projects; errors retain the last valid session.
**Save project** gives an untitled project its first path or checks a named project's consistency.

**Snap** aligns either moving edge or the trimmed edge to other clips' boundaries,
sequence zero or the playhead. **Snap px** configures the screen-pixel radius
(default 8), independent of zoom; disable Snap for frame-only positioning. Edited
boundaries use integer project frames. On a clip with a stored playback speed,
edge trims map those positions to exact source times. For clips using the
implicit 1× default, edge trims require a frame-aligned clip start and source-in.
Use `clip trim --in-time` or `--out-time` to edit exact source seconds at any
speed. Before trimming the left edge of a title, align its right edge to a
project frame.
**Split at playhead** (S) splits the selected clip; **Delete clip**
(Delete/Backspace) removes it. **Undo** / **Redo** and Ctrl/Command+Z / Shift+Z
restore shared CLI/GUI history, including after save/reopen.
Shared history can also restore or remove imported asset entries. When undo/redo
changes assets or their references, the library refreshes availability before
accepting the restored state; a failed refresh retains the previous session.
This also applies before the first save: undoing an unused asset's removal restores
its current availability, so readable sources can be dragged again and missing
sources remain marked offline. This checks source readability without re-probing codecs or changing source files.
Clip-only edits keep the existing availability snapshot. Reopen the project to
refresh availability after external file changes.

Focus a clip and use Left/Right to move one frame (Shift: ten); Up/Down moves it
to the next compatible track. Focus an edge handle and use Left/Right to trim.
Keyboard edits use frame stepping without proximity snapping. Scroll to reach
other tracks/times; there is no automatic edge scrolling during a drag. Zoom is
locked while dragging. Successful edits and undo/redo pause and unlink source preview,
retaining the project playhead.
Use **Export** to render the edited project.
Use the **Export frame** camera button in the Project viewer to save a PNG
of the composited frame at the playhead.

In the Inspector, **Fit → Cover** fills the canvas and **Crop** trims the
edges of the fitted layer. Project settings allow resizing the canvas. Use
**Replace media** to change the source of a clip, optionally shifting later
clips on the same track. **Freeze at playhead** writes a PNG and inserts a held
frame. **Flash from white** adds an animated white overlay. **Color**
adjusts exposure, white balance, contrast, saturation and a piecewise linear
curve, and can copy the grade to other clips.

In the timeline, select the incoming video clip and open **Transitions** to
add a **Cross-dissolve**. The clips must touch on the same track and have enough
trimmed source media on both sides of the cut. The dissolve preserves clip
positions, project duration and audio timing. The same menu adds picture fades,
and selecting a transition bar opens its duration and removal controls.

Use **Relink media** in an offline asset's information panel to restore the
source while preserving clip references. **Import font** embeds a TTF/OTF
file of up to 2 MiB in the selected title or subtitle cue. Subtitles can use
shadow, highlighted words, an entrance pop, and a style applied to selected cues.
Select a cue and open **Word timing** in the Inspector to assign each word a
start and end in seconds relative to the cue. The initial rows divide the cue
evenly. Adjust them to match the speech, then click **Apply word timing**.
Timed highlights appear in the Project viewer and in burned-in exports.

**Detach audio** puts the original audio on a new track and mutes the video clip.
Volume keyframes multiply the existing fades and gains. Audio effects can be
ordered and edited per clip, with Dialogue and Room presets. **Separate dialogue**
imports two sample-aligned WAV files, dialogue and residual background, after
local Bandit v2 inference. See [dialogue model setup](CLI.md#dialogue-separation).

Use **Add text** to create a clip of about three seconds at the playhead on a
new text track. Edit its content, timing, typography and effects in the
Inspector, then choose **Apply text** to commit the fields as one undo step.
Use the Project viewer to check the result. The CLI and SDK use the same
[text operations](CLI.md#text-layers-t33).

Select a video clip and click **Preview selected clip** to link source playback.
This explicit action sets the playhead to the clip start and opens its source-in.
Ruler seeks within the linked clip seek the matching source time. Source playback
updates the playhead, clamped to the clip range, while the source transport retains
its full-source bounds. Selecting another clip only changes the inspector; the
source link stays with the explicitly previewed clip. Seeking outside the linked
range switches to Project viewer and pauses/unlinks the source. Library selection
and **Open video** also unlink. Audio, image and text clips have no linked source preview;
linked source playback stays within that source. Project viewer provides edited
timeline cuts/gaps, audio mixing and ordered video, image and text compositing.
Very long timelines use a proportional scrollbar to stay within browser layout
limits; scrollbar precision becomes coarser at extreme durations.

Known limitation: after repeated ruler seeks, pressing **Play** can intermittently
leave the linked source paused, with its source clock and the timeline playhead
remaining fixed.

In **Project viewer → Preview quality**, use **Exact paused frames** to check
which source frame covers the playhead, or **Render full timeline** to review
a cached MP4 with mixed audio on the project frame grid. **Live preview**
returns to interactive Chromium playback. See [controls and limits](TIMELINE_PLAYBACK.md).

Select an imported video in the media library to open **Source preview**
automatically, or use **Open video**
for a local file. CLI imports update the open library immediately.
In Source preview, Play/Pause, the Seek slider and Previous/Next frame operate on one source.
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
Unsupported codecs and missing files show an error. After repairing a source,
reselect the asset, including clicking the same asset again to retry. Audio and image
assets open their own source previews; switching to Project viewer pauses audio.
Asset replacement pauses/unloads the old media element and revokes its media URL. Closing or
replacing a project clears the player. Preview state is transient and does not
modify the project or source files. This is source playback; it does not composite
timeline tracks or implement editing/render controls.

Open **Details & shortcuts** for source-frame diagnostics and
**Run performance validation**, which runs a positioning seek, three warm-up seeks,
30 fixed target seeks, then up to eight seconds of playback. Keep the window visible.
Open **Details & measurements** after validation for median/p95 seek latency,
dropped frames and waiting events in a readable report. The disclosure also
explains keyboard controls and preview precision limits.
For the reproducible fixture/1080p suite, run `pnpm test:preview` after generating
fixtures. It uses FFmpeg/ffprobe already on PATH, creates and cleans only an owned
`tests/fixtures/generated/t04-*` directory, and writes environment, raw samples,
source hashes, metadata and screenshots under ignored `test-results/preview-performance/`.
It tests the production build and native picker IPC (stubbing only the dialog result).
The shell/security checks run without fixtures or media tools. Fixture-backed
playback, dragging and import/validation regressions need the generated fixture
set and `ffprobe` on PATH for nominal frame assertions; individual cases skip
when their required fixtures are absent. A separate case deliberately removes ffprobe from the
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

Project regressions cover GUI/CLI file compatibility, offline
assets, invalid files, stale saves, unsaved-close/quit choices, loading states and
IPC rejection from another window. T28 export checks cover original-media snapshots
with active proxies and concurrent edits, metadata/presets/output FPS/HEVC, missing
media/tools, output conflicts, cancellation, failure recovery and shutdown cleanup.
A restoration regression checks fresh output selection after renderer reload and
macOS window recreation, canceled pickers and preservation of the prior export.
These tests exercise the production preload and main handlers with native dialog
results stubbed; real native dialog interaction is a separate manual check. T19 regressions cover unsaved import/remove/undo/redo,
readable and missing source availability, and dragging restored library assets.
T20 regressions cover numeric properties and rejected values, slider history,
keyboard focus, restored clip selection, and save/reopen against CLI inspection.
They hold a real edit IPC request pending to verify that another field's draft
survives its response and that queued picker/file-drop imports use the accepted
revision with separate undo entries. These checks use explicit release events,
not timing delays; the import cases require the generated video fixture and ffprobe.
T24–T26 checks cover multi-layer preview, proxy fallback/budgets, rapid seeks,
visual property edits with undo/redo, preview/export frame comparisons and audio
pulse/flash synchronization. See [the playback contract](TIMELINE_PLAYBACK.md)
for coverage, tolerances and benchmark definitions. T27 adds the
[preview/export consistency gate](PREVIEW_EXPORT_CONSISTENCY.md), also runnable
with `pnpm test:consistency`, with full-frame metrics, diffs and independent
source-frame and audio checks.
T22's `tests/desktop/shared-session.spec.ts` covers older backups opened from a
different file or restored at the same path, subsequent GUI undo, and timeline
navigation/snapping preservation after CLI edits and undo. A gated Save reply
checks that a delayed response cannot replace a newer pushed CLI revision.
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
