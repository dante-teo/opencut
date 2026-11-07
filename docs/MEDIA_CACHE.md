# Preview proxies and bounded cache (T25–T26)

Project viewer automatically selects a validated proxy when one exists. A missing
proxy leaves original preview usable while generation runs asynchronously. The
original source must still exist. Source preview and final rendering always resolve
original media; proxy paths never enter project files, history or export plans.

## Generation and timing

Automatic candidates are at least 1920×1080 pixels, over 60 fps, or HEVC/AV1/ProRes.
Manual generation also accepts smaller sources. FFmpeg scales down to fit 960×540
without upscaling, encodes H.264/yuv420p at CRF 28, GOP 30, no B frames and two
encoder threads. Audio is copied AAC. No frame-rate conversion or source-time
remapping is permitted: `-copyts -start_at_zero -fps_mode passthrough` retains VFR
intervals. Generation decodes source and output video timestamps with ffprobe,
requires equal frame counts and each timestamp within 2 ms, then checks duration,
audio presence/start and unchanged source identity before publication.

Eligibility is deliberately conservative: known positive duration up to 600 seconds,
known video frame rate, container/video origins within 2 ms of zero, opaque video,
and either no audio or AAC starting within 2 ms of zero. Alpha-bearing video stays
on the original because H.264 proxies cannot preserve its alpha. Other unsupported
timing/audio returns the original
with a reason; tool, encode and verification errors leave original preview available.
T26 shares SDR YUV matrix selection with export and paused PNG extraction, and
proxy grants carry the original display aspect independently of rounded proxy
dimensions. Arbitrary Chromium codecs, HDR/wide-gamut color and unusual stream
origins remain outside the validated parity contract. Audio sample preservation
and VFR intervals have independent native regression tests. Physical speaker/display
latency is not measured by those tests.

A finished proxy takes effect at the same exact project position on the next paused
cache refresh (roughly one second) or a fresh timeline grant. Playing decoders retain
their media until paused, avoiding an asynchronous A/V discontinuity. A media error
on an existing proxy grant requests the original and seeks using T23's current source
mapping; it never substitutes original bytes into a proxy byte-range response.

## Identity, storage and invalidation

These identity/storage rules apply to persisted proxy and PNG entries.
[Navigation artwork](#navigation-artwork) uses memory for waveforms and a separate JPEG LRU.

Source identity combines SHA-256 of the entire source with its real path, device,
inode, size, nanosecond mtime/ctime and normalized media metadata. A bounded 64-source
metadata LRU avoids rehashing unchanged identities during one process lifetime.
Keys include source content, media metadata and versioned derivative settings;
frame keys additionally include the exact requested source time so opposite sides
of a presentation boundary cannot alias through microsecond rounding. Paths
alone never establish validity. T27 uses proxy settings version 3 and frame settings
`frame-v4-covering-sdr-640x360`; older derivative interpretations are cache misses
and can be regenerated without changing originals. Source replacement, including the same path/size
and restored mtime, invalidates the identity through ctime/inode and content hashing.

Each entry has a digest-named file and manifest with its content hash. Lookups check
regular-file identity, size and full derivative hash; incomplete or corrupt files
are cache misses. Source changes during generation prevent publication. Staging
files are unique and never selected. Handled cancellation/failure removes staging;
cleanup or the next writer removes abandoned staging and manifest/file orphans.
Cache directories must be dedicated and empty on first initialization; a marker
records ownership. Originals inside the cache directory are refused. Clear/cleanup
only remove owned derivative/staging names.

A cross-process directory lock serializes writes, transcoding and extraction for
one cache. `proper-lockfile` supplies a heartbeat and recovers stale ownership after
a crash (10-second stale threshold); waiting generation can be cancelled. The
worker queues at most 16 proxy jobs and retains at most 64 job records. FFmpeg
subprocess buffers/timeouts are bounded; proxy encoding allows 30 minutes and
video timestamp verification allows two minutes per input with 16 MiB output caps.
Unsupported or excessive timestamp output fails safely to original preview.

## Budgets, frames and decoder lifetime

The default is `~/.cache/opencut/media-v1`, shared by GUI and CLI. Set
`OPENCUT_MEDIA_CACHE` or the CLI `--directory` flag to isolate it. Defaults are
2048 MiB on disk and 64 MiB in memory. Configure accepts 1 MiB–1 TiB for disk
and 1 MiB–1 GiB for memory. Disk accounting includes derivative manifests and
staging bytes. The small config, ownership and lock files are administrative overhead.

Disk entries evict by oldest manifest access time, with at most 4095 published
entries. Before encoding, the writer reserves a staging allowance of at most the
disk budget (at least 1 MiB, otherwise 1 MiB per source second); FFmpeg has a smaller file-size cap and validation rejects
truncated/oversized derivatives. Publishing evicts as needed, and configuring a
smaller budget immediately evicts. Severe budgets may prevent proxy creation or
cause useful derivatives to be regenerated. Cache maintenance may evict a granted
proxy; the media-error path falls back to its original.

640×360-or-smaller PNG frames are cached on disk and in a byte-bounded `lru-cache`.
The worker holds up to 256 encoded PNG and waveform buffers in that cache.
The exact-PTS frame path serves playback and CLI frame requests.
On a cache miss, ffprobe reads a seek-local interval and returns integer presentation timestamps in
the source time base, bounded to 4 MiB output, 60 seconds and two decoder threads.
The last presentation timestamp at or before the requested instant identifies the
covering frame; source FPS is not used to guess VFR boundaries. Extraction seeks
just before that timestamp so microsecond rounding cannot skip the chosen frame.
If timing cannot be resolved, the renderer keeps its ordinary decoder path; the CLI
reports an error. Versioned frame keys bypass older seek images, and exact requested
times keep opposite sides of a frame boundary distinct.

Paused extraction serves the current source times of visible video layers, with
at most two requests in flight in both the player and main process. No adjacent
frame sequence is prefetched. Seek/playback generations discard stale completions.
Cached images bridge paused seeks; ready native decoders take precedence. The
renderer retains decoded PNGs within the configured memory allowance and releases
them on seek, playback start or disposal. Lowering the limit trims them immediately.
The worker applies the memory limit to encoded playback PNGs and waveform
peaks. The renderer applies the same limit separately to decoded playback PNGs.
No unbounded decoded video-frame sequence or full-file PCM lives in JavaScript.

Chromium owns native decoder buffers outside these cache budgets. The player
caps owned source-run entries at 16, including
still images as well as media-element decoders, and speculative
lookahead runs at four/two seconds, with estimated three RGBA frames per source
constrained by the configured memory allowance. The first cache status applies
persisted budgets directly to the current player. Later budget updates apply to
lookahead on the next playback tick. While playing, they adjust speculative work
without interrupting active clips; proxy-selection changes still wait until paused.
Active clips take priority over speculative runs;
exceeding 16 active runs reports a diagnostic and omits excess runs. Contiguous
splits share one decoder. Leaving a run/viewer or changing a project unloads media,
disconnects audio nodes and releases grants. Cache work stays in a Node worker;
FFmpeg executes outside Electron main/renderer.

## Navigation artwork

Library video thumbnails and timeline filmstrips use the worker's JPEG LRU,
capped at 8 MiB and 128 entries. The key includes source path, device/inode, size,
mtime/ctime, requested source time, batch size, sample interval and decoder
options. A filmstrip atlas can be reused at the same sample spacing across
scrolling, window resizing and reopened projects.

Waveform chunks share the T25 memory cache and its configured byte limit with
playback PNGs. Each chunk uses the original file's resolved path, nanosecond file
identity, a summary version and a 16-second source-grid offset as its key.
Waveform memory use and cache hits/misses are included in the desktop cache
status. Zoom and clip dimensions only change the drawing, so a single chunk can
serve clips with different trims or zoom levels. A cleared cache releases both
artwork caches. JPEG bytes and waveform peaks are stored in memory only. If
disk cache setup fails, waveform decoding continues with the last valid memory
limit, or the default on a fresh worker. Disk cache operations still report the
setup error.

The worker checks file identity before lookup and after decoding. Navigation
lookups avoid whole-source hashing and the disk cache lock, so a late seek in a
long file does not require reading its earlier contents. The renderer holds only
mounted artwork and coalesces matching in-flight requests for a project snapshot.
A reopened project always performs a new authorized lookup. See
[timeline artwork](TIMELINE_PLAYBACK.md#timeline-clip-artwork) for source
sampling, cancellation and decoding limits.

## Management and measurement

Expand **Proxy & cache** in Project viewer for the proxy toggle, disk and worker
memory usage, cache hits, jobs and progress, regeneration and cancellation,
limits, stale cleanup and clearing. These actions do not
create edits. Project invalidation cancels obsolete work and forgets the affected
queued/generating jobs, so a fresh valid selection can restart them even while old
work finishes cancelling. **Cancel generation** retains cancelled job records;
ordinary edits and selections do not restart those jobs. Use **Regenerate proxies**
to retry a cancelled or failed job. Job records are bounded and transient; clearing
the cache or restarting the app resets them. Cache limits persist in the cache
directory; the preview toggle is transient per app process.
Use `opencut cache --help` and [the CLI contract](CLI.md#preview-proxies-and-cache-management-t25)
for the same headless operations. FFmpeg/ffprobe remain manual prerequisites.

Behavioral coverage is separate from performance measurement:

- `pnpm test` covers cache bounds/invalidation and the [worker lifecycle](../tests/integration/media-worker.test.ts),
  including queued/running job restart, cancellation races and explicit cancellation.
- `pnpm test:media` includes the [native cache checks](../tests/integration/cache.native.spec.ts).
  Cached CFR/VFR images are compared with a full-decode, frame-index oracle at
  boundaries and inside intervals; proxy timing, audio and original-only export
  are checked independently.
- `pnpm test:desktop` includes [proxy/cache controls](../tests/desktop/cache.spec.ts),
  fallback and same-key regeneration, plus persisted limits on the initial player
  and changed limits during its lifetime. The [artwork regression](../tests/desktop/timeline-artwork.spec.ts)
  checks the actual displayed filmstrip/waveform pixels and layout.
- `pnpm test:media` also includes [thumbnail timing and decode-cost checks](../tests/integration/thumbnail.native.spec.ts)
  and [waveform timing and cache fallback checks](../tests/integration/waveform.native.spec.ts).
  The fallback regression covers a non-dedicated cache directory and a malformed config.
  Thumbnail measurements use a newly generated eight-second 3840×2160/30 fps
  H.264 source (`libx264`, ultrafast, CRF 28, two encoder threads), sampling every
  0.9 seconds from 0 through 6.3 seconds. They compare the playback PNG path,
  individual JPEGs, and four-sample software or VideoToolbox atlases. Source bytes
  are checked before/after; warm JPEG cache timings are separate. The paths produce
  different formats/sizes, so this measures navigation-pipeline cost rather than
  isolated decoder throughput, whole-editor speed or a hardware-independent
  performance guarantee.

`pnpm benchmark:t25` builds and runs a dedicated visible Electron benchmark. It
generates new eight-second 1080p and 4K H.264/AAC synthetic sources with GOP 120,
generates proxies, then measures original and proxy modes twice at the default
window size. Three warmups precede 20 deterministic alternating seeks. Completion
requires both mapped media time/seek completion and a painted timeline canvas.
Four-second playback samples include callback FPS, drops, waits, blank ticks, skew,
500 ms Electron aggregate CPU/working-set samples, proxy generation wall time and
disk sizes. Source hashes, metadata and environment accompany raw samples in
`tests/fixtures/generated/t25-benchmark-*/benchmark.json`; paths print to stdout.

This complements the historical [T21 baseline](T21_ARCHITECTURE_AUDIT.md), whose
source-only workload predates edited-timeline playback. There is no universal
performance pass threshold. Order is original then proxy; OS caches, thermal state,
power mode and other system load are uncontrolled. Aggregate working set can count
shared pages twice and CPU excludes FFmpeg generation. These short synthetic runs
do not prove long-session, heavy-overlap, HDR or cross-platform performance.

`pnpm benchmark:t26` separately measures overlapping videos and an alpha image in
original/proxy modes. See [composition semantics and benchmark definitions](TIMELINE_PLAYBACK.md#composition-and-export-agreement-t26)
for layer ordering, SDR tolerances, all-layer seek completion and resource limits.
