# ADR 0003: HTML video for the initial source preview

Status: historical. The Electron application has been retired.
Date: 2026-10-24.

T16 retains this approach for the reusable desktop source player and imported
asset preview. Project FPS supplies nominal clock/frame/timecode labels; source
PTS is displayed separately. Revocable asset-ID capabilities extend the original
picker boundary, and abortable actions unload cleanly on asset/project changes.
The precision and codec limits below still apply; T16 does not add a frame index
or timeline compositor.

## Decision

Use one HTML video element inside the sandboxed Electron renderer for the initial
single-source preview. Keep the controller in desktop, separate from the future
editing domain. Reuse `probeMedia` from the headless media package for metadata.
Use browser A/V playback, timestamp seeking and compositor frame callbacks. Do not
add native media bindings or an MLT/FFmpeg preview process at this stage.

The native seek slider remains enabled throughout a pointer drag and commits the
final target on release, including releases outside the input. Cancellation or
window blur releases the interaction lock. Keyboard seeking remains immediate.
Native-picker replacement disables the old player's controls through selection/probing;
picker requests, seeks and validation are mutually exclusive. T16 library selection
can replace a busy player by aborting its pending work and unloading its element.

This decision covers source preview only. It does not select a multitrack,
effects, synchronization or export architecture. T05 is outside this change.

## Rationale and alternatives

The browser already provides the required controls and an integrated audio/video
clock. No player framework is needed for this prototype. A custom FFmpeg decoder
or MLT preview would also require frame transport, buffering, audio output,
synchronization and packaging work. The measured single-source workload has not
shown a need for that complexity. FFmpeg remains the existing headless inspection,
frame-extraction and composition tool; it is not replaced by browser playback.

The local-file transport requires byte-range streaming. Electron's
`net.fetch(file:)` returned 200/full content for a Range request in integration
validation, so main uses bounded Node file streams and the maintained
[range-parser](https://github.com/jshttp/range-parser) library. This is the only
new non-workspace runtime dependency. Unguessable URLs authorize one selected
source, selected through the native picker or resolved from an active-project
asset ID. Renderer code cannot pass filesystem paths to main. Releasing or
replacing the source, or closing/replacing the project, revokes future URL requests.

## Reproducible measurement contract

Run `pnpm test:preview` with a graphical desktop session, existing generated
fixtures and manually installed FFmpeg/ffprobe. It builds the production app;
only the native picker result is stubbed. The same controller is available via
**Run performance validation** for a manually selected file in `pnpm dev`.

The suite uses the three existing H.264 fixtures (24/25/30 fps), then creates
1920×1080 H.264 High/yuv420p sources at 30 and 60000/1001 fps, with AAC audio,
B-frames enabled, four-second GOPs, CRF 20 and the x264 fast preset. They are
12 and 10 seconds long. These are moving synthetic patterns representative of
common encoding properties, not camera/screen recordings. A burned-in ten-bit
frame ID permits independent screenshot pixel checks. Generation lives only in
an exclusively created `tests/fixtures/generated/t04-*` directory and is cleaned
on success or failure. Existing inputs are read only and hash-checked.

For each source, establish a distinct initial position, perform three excluded
warm-up seeks, then 30 deterministic alternating jumps across most of the duration.
Seek to the middle of the nominal frame's display interval using `currentTime`.
Record both the `seeked` event latency and time until `requestVideoFrameCallback`
reports a submitted compositor frame. Wait for both, even if their order differs.
Report all samples, arithmetic median and nearest-rank p95. A five-second
presentation timeout fails the run rather than discarding a slow seek. Failed
seeks and benchmark initialization release frame callbacks, event listeners and
seek timers before the UI permits another operation. These are
warm application/cache measurements; OS caches are not flushed.

Play once from the first frame at 1× for up to eight seconds (or until the end).
Record deltas of `getVideoPlaybackQuality()` total/dropped frame counters,
callback count and inter-callback median/p95, gaps exceeding two nominal frame
periods plus 2 ms, and waiting/stalled events. Counters describe different browser
pipeline stages, so total-frame deltas need not equal callback counts. These
metrics measure browser behavior, not physical display output or audio latency.

Prime `app.getAppMetrics()` just before playback, then sample approximately every
500 ms and at the endpoint. Sum Electron's raw CPU percentages and working-set
sizes across the app's processes (including GPU/utility processes); convert KiB
to MiB. Report median/p95 and raw samples. These are whole-app values including
UI/instrumentation overhead, not decoder-only CPU, JS heap, unique memory or a
leak test. Shared pages may be counted more than once. CPU percentages are kept
in Electron's platform-reported units without a cross-platform normalization.
No performance thresholds are asserted across machines.

Environment, codec/stream metadata, input hashes, raw samples and screenshots are
saved under ignored `test-results/preview-performance/`. The sequence uses one app
instance, so later files can retain buffers/caches from earlier files. Do not
interpret increasing working sets as a measured leak or as per-file allocations.
Raw outputs are regenerated per run and can be replaced or removed by subsequent
Playwright runs. This ADR records one selected local measurement, not a run history.

## Findings

The saved local run after the T04 interaction fixes on 2026-10-24 used an Apple
M1 Max (10 logical CPUs), macOS 27.0.1 arm64, Electron 45.0.0 /
Chromium 156.0.8078.48 and the built-in 120 Hz display, with FFmpeg/ffprobe 9.0.
The window was 1080×720; video decoding used the full source while the preview was
scaled to fit its 42vh display area. These are measurements from one
machine/run, not estimates or portable performance promises.

| Synthetic source                         | Seek to compositor callback median / p95 | Dropped / total frame counter delta | CPU median / p95 | App working set median / p95 |
| ---------------------------------------- | ---------------------------------------- | ----------------------------------- | ---------------- | ---------------------------- |
| 1080p30, H.264 High, ~8.0 Mb/s video     | 26.6 / 41.5 ms                           | 0 / 242                             | 2.39 / 2.73%     | 636.3 / 655.3 MiB            |
| 1080p59.94, H.264 High, ~12.5 Mb/s video | 41.4 / 87.1 ms                           | 0 / 481                             | 3.53 / 4.06%     | 676.0 / 706.9 MiB            |

For the same sources, `seeked` event median/p95 was 24.4/42.5 ms and
39.1/88.2 ms. Callback-gap p95 during approximately eight seconds of playback was
42.5 and 17.6 ms respectively. The 30 fps source had no callback gap over two
nominal frame periods; the 59.94 fps source had one. Neither reported dropped
frames, waiting or stalled events. A long callback gap therefore should not be
relabeled as a measured decoder drop.

The existing 24/30/25 fps fixtures had seek-to-callback median/p95 of 8.3/17.9,
14.1/23.4 and 8.4/16.8 ms, with zero reported drops or waiting/stalled events.
All 150 measured seeks matched the expected CFR presentation timestamps.
Screenshot pixel checks independently verified frame IDs 120 → 121 → 120 → 238,
then the actual last frame and a repeated forward step there, on both 1080p
sources. The fractional-rate source's audio/container tail extends beyond its
video; stepping uses the probed video end and tolerates microsecond metadata
rounding to avoid requesting a nonexistent final nominal frame.

Browser video supported H.264 playback, timestamp seeking and forward/backward
stepping in this workload. Retain HTML video for the initial single-source preview
and keep an explicit escape path for sources or editing operations requiring
stronger guarantees. The raw machine-specific output is saved in ignored test
results as described above; validation command results are reported in chat.

## Accuracy and synchronization limits

The [Chromium frame callback guidance](https://web.dev/articles/requestvideoframecallback-rvfc)
explicitly describes best-effort callbacks and no guaranteed frame-accurate video
seeking. A compositor callback is not a physical display timestamp. Its rate is
bounded by rendering cadence; a missed callback is not necessarily a dropped
video frame. Observe `mediaTime` instead of treating `currentTime` as the displayed
frame PTS. Display both values in the prototype.

Average FPS is sufficient to demonstrate stepping on known, zero-start CFR files;
it does not establish an exact frame index for variable-rate video, timestamp
gaps, delayed streams, nonzero starts or unusual track selection. The UI labels
frame numbers as nominal. The player does not build a frame PTS index. Without a
project, stepping needs average FPS from optional ffprobe; playback and timestamp
seeking remain available without it. T16 uses the project rate when a project is
open, including when source FPS is unknown. Imported media reuses saved metadata
and browser duration; an audio tail can extend the nominal clock past the final
video frame. Timecode uses nominal non-drop labels, which accumulate a difference
from elapsed wall-clock seconds at fractional rates. Browser codec/container
support is narrower than FFmpeg's; unsupported
sources surface a decode error. Nothing installs tools or changes user media.

One HTML video element owns the audio/video clock, but T04 does not measure
speaker/display synchronization, perceptual lip sync, drift in long recordings,
multiple simultaneous streams, 4K/HDR, heavy effects, or performance under editor
load. GPU feature availability does not prove that a particular file used
hardware decoding. macOS validation does not establish Windows/Linux behavior.

Use a frame-indexed extraction/decoding path when precise paused-frame selection
becomes an editing requirement, and investigate proxies for unsupported/expensive
sources. The existing FFmpeg extraction API is available for that investigation;
it is not integrated as a fallback in T04. Evaluate MLT/FFmpeg preview only if
representative workloads demonstrate missing functionality or unacceptable
latency, drops or synchronization. Neither alternative is benchmarked here, so
there is no measured claim that it would be faster.

API references: [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol/),
[Electron app metrics](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics),
[browser playback quality](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality).
