# Edited timeline playback (T24–T25)

**Project viewer** plays the edited timeline. **Source preview** plays original media
independently; **Preview selected clip** still links that source transport to one
clip. Select Project viewer to hear clip volume/mute and all overlapping audio
tracks. Play/Pause, the project seek slider, ruler, Space and frame steps operate
on the edited timeline. Seeks pause playback. End stops at the exact timeline end;
Play at end restarts at zero. Selection does not change playback.

Cuts, trims and splits use T23 source mapping. Visual gaps and audio-only tails
show the canvas background. The last eligible visual track is displayed with
contain fitting; lower visual tracks are not composited. Still images can be held.
Visual position, scale, opacity blending and fit changes remain export properties
until T26. Audio from every eligible clip, including original video audio, is summed
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

Each nearby source run gets a media element routed through its own GainNode.
Two seconds of upcoming clips are loaded and pre-seeked. T25 caps this at four
speculative runs within an estimated frame-memory allowance, and 16 total decoders;
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
A slow decoder leaves background rather than an old clip's picture; the clock
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
VFR sources. A ready native decoder takes precedence over the cached image. One
adjacent frame is prefetched; old asynchronous completions cannot paint after a
new seek. New snapshots (including synchronized CLI edits), viewer changes and
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
capabilities into Web Audio; renderer fetch and filesystem privileges stay blocked
by CSP and the sandbox.

## Diagnostics and verification

Expand **Playback diagnostics** for current position/state, audible candidate count,
visible-video frame callbacks, visible and all-decoder dropped-frame deltas, late
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
there is no timestamp index or VFR frame-selection guarantee. Fractional project
frame steps request exact timeline instants but can repeat source frames. Media
end shorter than saved clip bounds is not extended with generated content.

Extreme rational anchors whose clock arithmetic exceeds safe JSON integers pause
with a diagnostic rather than rounding timeline mapping. Lookahead comparisons
use bigint and do not limit valid paused navigation.

Long recordings, sustained heavy overlap, HDR, unusual stream offsets, and
speaker/display loopback are not validated by the short synthetic suite. T25 adds a separate synthetic 1080p/4K benchmark. Canvas
preview is capped at 1920 pixels wide; decoding uses an available verified proxy or the source.
Startup and cut latency depend on browser readiness and scheduling. Full visual
compositing remains T26. Effects, transitions and export UI are outside this scope.
See [the T25 cache contract](MEDIA_CACHE.md) for supported proxy timing, native memory limits, cancellation and resource accounting.
