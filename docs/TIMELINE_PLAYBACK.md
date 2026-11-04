# Edited timeline playback (T24–T26)

**Project viewer** plays the edited timeline. **Source preview** plays original media
independently; **Preview selected clip** still links that source transport to one
clip. Select Project viewer to hear clip volume/mute and all overlapping audio
tracks. Play/Pause, the project seek slider, ruler, Space and frame steps operate
on the edited timeline. Seeks pause playback. End stops at the exact timeline end;
Play at end restarts at zero. Selection does not change playback.

Cuts, trims and splits use T23 source mapping. T26 composites all eligible video
and image tracks, bottom to top in track array order, with per-clip X/Y, scale,
opacity and contain/cover/stretch fitting. Visual gaps and audio-only tails show
the canvas background. Transparent image/video pixels reveal lower layers.
Canvas colors accept `#RRGGBB`, `#RRGGBBAA` or `transparent` (default black).
Preview retains canvas alpha; H.264 export flattens it over black.
Audio from every eligible clip, including original video audio, is summed
through individual linear gain nodes. Mute silences that clip. A browser compressor
protects the summed output; it is not the offline FFmpeg limiter.

## Clock, scheduling and lifetime

`TimelinePlayback` stays in the desktop renderer. Chromium performs asynchronous
media decoding. T25 proxy and paused-frame subprocesses run through the headless media worker; main and renderer perform no synchronous cache or transcode work.
Native media APIs supply decoders, transport, Web Audio routing and counters, so a
player framework or native decoder dependency is unnecessary for this scope.

`AudioContext.currentTime` is the sole running timeline clock. Pause/seek anchors
remain exact rationals; elapsed audio time is converted once to microseconds and
added to the anchor without accumulating per-frame deltas. T23's
`createTimelineEvaluator` validates/indexes a snapshot once and performs exact
half-open interval queries. No timeline/source arithmetic is duplicated in playback.
The UI reports at most 20 times per second; painting follows animation frames.

Each nearby timed audio/video run gets a media element routed through its own
GainNode. Still-image runs use native image elements.
Two seconds of upcoming clips are loaded and pre-seeked. T25 caps this at four
speculative runs within an estimated frame-memory allowance, and 16 owned
source-run entries (including still images);
excess active runs produce a diagnostic instead of unbounded allocation. Persisted
limits apply on the first cache-status response. Subsequent budget changes adjust
lookahead while playing without restarting active clips. Contiguous source ranges
on one track share a decoder across splits. Noncontiguous cuts switch between
preloaded decoders. Media positions are compared with the audio clock: errors over
15 ms use 0.98/1.02 rate correction; errors over 120 ms seek to the authoritative
position. A 250 ms settling window excludes startup/correction transients from
steady-state skew measurements. Gain automation closes a source exactly at its
scheduled end even when a UI tick is delayed. Starts use asynchronous browser play,
so this architecture does not promise sample-accurate joins on arbitrary media.
A slow decoder leaves lower layers/background rather than an old clip's picture; the clock
continues and diagnostics record unavailable or blank visual ticks.

Seeks and interruptions mute the master immediately, pause every decoder and
invalidate pending play actions. Toggling playback or seeking while startup is
pending cancels that start; press Play again to resume healthy media without
switching viewers or reopening the project. Each startup request captures its
playback action. A rejected play promise marks media unavailable only while that
action is still current, so a canceled request's `AbortError` cannot disable a
healthy decoder. Failures belonging to the current action still surface normally.

Only the current evaluation can paint; seeking media frames are withheld. A cached
PNG for the paused asset/source-time may bridge that seek. It represents the frame
whose presentation interval covers the requested instant, including mixed-rate and
VFR sources. A ready native decoder takes precedence over the cached image. Paused
frame extraction is bounded to two requests across visible layers. The decoded-PNG
cache applies the configured memory limit independently of the worker encoded-PNG
cache; lowering the limit immediately evicts older decoded images. No adjacent
frame sequence is prefetched. Old asynchronous completions cannot paint after a
new seek or playback start. New snapshots (including synchronized CLI edits), viewer changes and
component cleanup dispose decoders, frame callbacks and URL grants. Project
invalidation cancels obsolete proxy work but permits fresh valid selections to
restart it; explicit user cancellation retains the cancelled job until retry or
job-record reset. See [cache management](MEDIA_CACHE.md#management-and-measurement).
Hidden documents and suspended audio devices pause playback. Transport state is
transient and creates no edits or history. Re-enter Project viewer or reopen the
project to retry a repaired media file.

Timeline grants are separate from the single source-preview grant. The typed
preload accepts only an asset ID, project ID and revision; main checks sender,
revision, file readability and project generation. Opaque range-serving URLs are
released when unused and revoked after edits/project replacement. There are at
most 128 simultaneous timeline grants. T25 also accepts an original-only retry flag and separately validates bounded cached-frame requests. Missing or failed proxies retry original media through a new grant, never by mixing different file bytes in one response. CORS is enabled only to allow these media
capabilities into Web Audio and origin-clean Canvas composition/readback; renderer fetch and filesystem privileges stay blocked
by CSP and the sandbox.

## Diagnostics and verification

Expand **Playback diagnostics** for current position/state, audible candidate count,
visible-video frame callbacks (summed across layers), complete project-frame composite FPS, visible/painted layer counts, maximum composition submission time, last/maximum all-layer seek latency, visible and all-decoder dropped-frame deltas, late
callbacks, waiting events, blank visual ticks, clock corrections, maximum tick gap,
media/audio/presented-frame skew and browser output latency. Errors appear outside
the disclosure too. Counters cover the current player lifetime and reset on a new
snapshot or viewer re-entry. Hidden video decoders can discard frames while their
audio continues; `decoderDroppedFrames` therefore includes work that is not a
visible preview drop. Callback lateness is `now > expectedDisplayTime + 2 ms`.
These browser observations do not measure physical speaker/display latency.

`pnpm test:desktop` includes `tests/desktop/timeline-playback.spec.ts`: actual T21
cuts, gaps and mixing, continuous split playback, trimmed source mapping, emitted
440/880 Hz signals, gain/mute, silence after pause, rapid seeks, audio-device
interruption, viewer separation, media revocation and offline recovery. Separate
pause/seek startup regressions gate the first play request and reject it with
`AbortError` when interrupted. Replay must reuse the same decoder, paint video and
emit the source audio without an unavailable-media diagnostic; clock advancement
alone is insufficient. An extra trimmed pulse/flash fixture compares Web Audio
analyser onset with canvas markers.
Inputs are synthetic and owned under `tests/fixtures/generated/`; FFmpeg is needed
for marker generation and existing complete T21 assets are reused when available.
Headless clock/evaluator tests run in `pnpm test`. Performance samples print in the
test output and screenshots go to ignored `test-results/`; no source files change.

## Limits

The Chromium codec/container set applies: common H.264/AAC MP4, VP9 WebM, PCM WAV
and browser-supported stills are exercised. FFmpeg-only codecs, unusual containers,
corrupt files, absent streams and missing media may fail locally without a decode
fallback. Browser stream origins/edits and delayed tracks can differ from export;
native media seeking does not use the worker's covering-frame timestamp selection
and has no VFR frame-selection guarantee. Fractional project
frame steps request exact timeline instants but can repeat source frames. Media
end shorter than saved clip bounds is not extended with generated content.

Extreme rational anchors whose clock arithmetic exceeds safe JSON integers pause
with a diagnostic rather than rounding timeline mapping. Lookahead comparisons
use bigint and do not limit valid paused navigation.

Long recordings, sustained heavy overlap, HDR, unusual stream offsets, and
speaker/display loopback are not validated by the short synthetic suite. T25 adds a separate synthetic 1080p/4K benchmark. Canvas
preview is capped at 1920 pixels wide; decoding uses an available verified proxy or the source.
Startup and cut latency depend on browser readiness and scheduling. Effects, transitions, keyframes and export UI are outside T26.
See [the T25 cache contract](MEDIA_CACHE.md) for supported proxy timing, native memory limits, cancellation and resource accounting.

## Composition and export agreement (T26)

`@opencut/shared` is the pure geometry/color contract for both Canvas and FFmpeg.
Coordinates are project pixels, origin at top left, positive X/Y right/down.
Scale multiplies the canvas fitting rectangle; its sides round to nearest even
pixels, at least two. Contain fits display aspect with transparent margins;
cover fills and centrally crops; stretch fills independently. Source sample aspect
and quarter-turn rotation are applied before fitting. Chromium intrinsic video
sizes already describe display pixels; proxies carry the original display aspect
so their rounded dimensions cannot change composition. Offsets move the centered
fitted layer, with both crop and placement snapped to the even FFmpeg chroma grid.
Geometry is computed before the preview's 1920-pixel width cap/downsampling.
No DOM layout, readback, per-pixel loop or React state update occurs per layer.
Canvas 2D submits browser drawing work; no extra compositor library, WebGL engine
or native decoder is necessary for the measured short workloads.

Both paths use encoded RGB source-over blending. FFmpeg converts
sources into RGBA before layering and tags final SDR output BT.709. FFmpeg-supported
source YUV matrix tags are used. Untagged sources use BT.709 for VP9 or when coded width is
at least 1280 or height exceeds 576 pixels, and BT.601 otherwise. Proxy and PNG
extraction use the same matrix rule. H.264 proxies cannot
retain source alpha, so alpha-bearing videos stay original. Image alpha is
multiplied by clip opacity; unavailable upper layers leave lower layers visible.
This is SDR parity, not HDR/wide-gamut color management.

Only current T23-visible layers are painted. Zero-opacity or entirely offscreen
silent clips are not decoded; audible invisible clips retain audio. Decoder
lookahead is bounded and yields to active clips at the 16-source-run limit. Geometric
occlusion by upper layers is deliberately not inferred from unknown source alpha.
Each seek invalidates cached-frame generations and immediately clears stale
content. Pending grants/images/frames cannot paint after snapshot disposal.
Editing pauses and reconstructs the current snapshot at the retained playhead.

`tests/desktop/compositing.spec.ts` launches real Electron at its default window
size, compares sampled Canvas pixels with original-media CLI exports at exact
boundaries, and exercises mixed-resolution/rate video, alpha PNGs, fitting modes,
track reversal, transparent backgrounds, frame steps, rapid seeks and inspector
edits. The SDR comparison gate is mean absolute RGB channel error <10/255 and
95th percentile <30/255 on a 16-pixel sampling grid, allowing H.264 loss, chroma
subsampling and different resampling kernels. This is not pixel identity: spatial
edges and VFR temporal selection can still differ. The [T27 consistency gate](PREVIEW_EXPORT_CONSISTENCY.md)
adds full-frame comparisons, independent CFR source-frame identities and decoded audio checks. Native
T12 tests separately gate alpha, SAR, original audio and exact export boundaries. The independent T10 source-frame comparison allows mean channel error <6/255 for RGB composition plus H.264/chroma conversion.

`pnpm benchmark:t26` measures 2/4/6 overlapping videos plus an alpha image, with
original and proxy decoding, mixed resolutions, 12 measured seeks and short
playback runs. It records FPS, visible decoder drops, missing-layer ticks, seek
latency, audio/media skew, CPU and memory (where Electron exposes them), GPU status
and environment in an ignored generated-fixture directory. Complete composite FPS
counts distinct project frames painted with every eligible visible layer, including
background-only gaps; video callback FPS sums all visible video callbacks.
Submission time measures browser drawing submission and scheduling, excluding GPU
execution and media decoding.
Harness seek times include UI/report polling. The renderer seek counter updates
when a paused seek paints every eligible visible layer; unavailable layers prevent
completion, leaving the previous completed measurement. Playback start cancels a
pending paused-seek measurement. CPU aggregates Electron processes and working set can
double-count shared pages. These synthetic warm-cache measurements do not promise
long-running, cross-platform or physical speaker/display synchronization.
