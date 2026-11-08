# Desktop export

Open a project and choose **Export** in the toolbar. Choose an output file in an
existing writable directory, select a preset or adjust the settings, then press
**Export video**. Unsaved projects and unsaved edits can be exported. Export does
not save or change the project. FFmpeg and ffprobe must be installed manually and
available on PATH; H.264 requires `libx264`, HEVC requires `libx265`, and both require
AAC. OpenCut does not bundle or install these tools.

The presets are **Project · balanced**, **1080p · high quality**, **720p · quick
review**, and **1080p · HEVC**. All preserve project FPS by default. Resolution
presets fit the finished canvas inside 1280 × 720 or 1920 × 1080, swapping the
bounds for portrait projects and rounding down to even dimensions. They can
upscale a smaller canvas. Project-space transforms and aspect ratio are retained.
Project resolution exports the existing canvas size. HEVC needs both output sides
to be at least 16 pixels. All exports are SDR 4:2:0 MP4 with 48 kHz stereo AAC.

Frame rate can follow the project or use 24, 25, 30, 60, 24000/1001, 30000/1001,
or 60000/1001 fps. Conversion samples the completed project-grid composition;
it does not reinterpret source trims or move clips. When the timeline duration
does not end on an output frame boundary, the output rounds up to the next frame
and extends the final picture/audio silence by less than one output frame.
The panel shows the estimated duration before starting and exact output metadata
after validation. Project-rate exports retain the established
[T27 sampling, color and timing contract](PREVIEW_EXPORT_CONSISTENCY.md).

**Draft**, **Balanced**, and **High** quality use FFmpeg's ultrafast/CRF 28,
veryfast/CRF 20, and medium/CRF 16 settings respectively. CRF targets quality,
so file size depends on the content and codec; no file-size estimate is promised.

Starting an export captures the project ID, revision, settings and a detached
project snapshot. Original asset references are resolved from that snapshot and
its project directory, independently of preview proxies, selection and playhead.
You can hide the export panel, continue editing, switch projects, and reopen it
from the toolbar. The job's project name and captured revision remain visible.
After reloading the renderer or reopening the window, choose an output file again
before starting another export; the previous job's destination remains in its status.
Canceling that picker leaves the next export disabled until a file is chosen.
Hiding and reopening the panel without reloading the window keeps the current
selection.
Job status is kept only for the current application process; quitting does not
retain job history or resume exports on the next launch.
Edits accepted after capture affect later exports. Original source files are
referenced in place; do not move or externally modify them during a render.

Before encoding, validation checks timeline references, supported project bounds,
frame alignment, required source streams and current source duration/readability,
output extension/directory/conflicts, and required FFmpeg encoders. Only assets
referenced by the timeline need to be available. Validation errors are separate
from failures during rendering or verification. Repair the problem or choose a
new output, then retry. Validation probes metadata; corruption encountered only
while decoding can still cause a render failure.

Progress shows processed output frames, elapsed time and an approximate remaining
encoding time when FFmpeg has enough information. Preflight and verification have
no remaining-time estimate. A 100% encoding counter can still be verifying;
**Export complete** appears only after independent output checks and publication.
If a title requests a font family unavailable on the export machine, OpenCut
uses bundled Noto Sans SC and lists the substitution in the completed job's
status. Export renders all active text layers from the captured project,
including layers deferred by the viewer's memory budget. See the
[typography contract](PREVIEW_EXPORT_CONSISTENCY.md#text-layers-t33).

Progress events are bounded to at most five updates per second. One foreground
export is supported; there is no persistent queue or background service.

**Cancel export** stops validation, encoding or verification and waits for native
process closure and temporary-file cleanup before showing **Export cancelled**.
Closing the Electron window or quitting cancels and cleans an active job as well.
A cancellation racing after completed atomic publication reports success.

Exports render to an owned temporary directory beside the destination. The
headless renderer verifies codecs, dimensions, frame rate, duration, zero stream
starts and decoded frame count before atomically publishing the complete file.
**Existing files are always refused**, including when a native picker offers
replacement or another process creates the file during export. Failed and
cancelled jobs leave existing files intact. The destination filesystem must
support hard links. Forced termination or power loss can leave temporary files;
normal cancellation and failure remove them.

### Subtitles in video and sidecars

The video export dialog includes **Burn subtitles into video** when a project
has cues. It is enabled by default. Burn-in uses the shared subtitle style
and includes cues visible at each project frame above the other visual layers.
Clear the checkbox to export clean video at the same duration. Use
**Subtitles → Export SRT…** or **Export WebVTT…** in the timeline to write a
separate UTF-8 file with cue text and timing. Shared project styles stay with
the project and burned video. Burn-in supports up to 256 sampled, nonempty
cues per render range. See [subtitle timing and sidecar limits](CLI.md#editable-subtitles-t34).

## Desktop and CLI settings

The desktop and [`project render`](CLI.md#project-rendering) share the same headless
renderer and verified publication path. Their controls differ:

| Setting              | Desktop                                     | CLI `project render`                                          |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Video codec          | H.264 or HEVC                               | H.264                                                         |
| Output frame rate    | Project rate or a supported conversion rate | Project rate                                                  |
| Existing destination | Always refused                              | Replaced only with explicit `--overwrite`, after verification |

Both support the existing quality and resolution presets. T28 adds no CLI codec
or output-frame-rate flags.

Current limits include 64 non-subtitle timeline clips, 600 seconds, even canvas
sides from 2 to 3840 and at most 3840 × 2160 pixels, and project rates from 1 to
120 fps. Browser
preview codec support can differ from FFmpeg export support. HDR, transitions,
keyframes, distribution/signing, persistent queues and cloud rendering are outside
the current scope.
