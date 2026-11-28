# OpenCut architecture

The source of truth is a TypeScript [video definition](VIDEO_DEFINITIONS.md).
A compile reads the definition and probes the referenced media, validates the
result against the timeline model, and binds a render plan. The in-memory
snapshot is immutable. Before decoding media, preview and render verify its
identity and stage a private copy for the duration of the operation.

- `@opencut/shared` holds platform-neutral time, color, compositing, transition,
  and animation primitives.
- `@opencut/core/video` is the Node entry for compiling, inspecting, previewing,
  watching, and rendering definitions. The timeline evaluator and
  render planner are shared by all these operations.
- `@opencut/media` runs FFmpeg and ffprobe, prepares generated layers, mixes
  audio, and publishes completed output. It also provides standalone media
  processing and the optional dialogue-separation backend. Its bundled Rust
  media engine runs decoded-frame verification, presentation indexing and
  the analysis used by audio-dependent graphics.
- `@opencut/sdk` exposes the definition workflow. The CLI uses the same core
  functions; foreground rendering runs in the CLI process and starts only the
  subprocesses needed for that invocation.

## Native execution

TypeScript owns composition and timeline evaluation, including rational
source sampling, clip and transition ranges, stream selection, effect
ordering, mix routing, output profiles and render plans. The graphics
runtime evaluates React, SVG and authored animations on that timeline.
The media package passes the result of those decisions to FFmpeg and,
for supported native jobs, an OpenCut Rust executable.

The executable accepts one typed request with the OpenCut release, the
protocol version, an optional FFmpeg allocation limit, and a job. A
graphics audio job receives the prepared mix path, exact sample count
and analysis window settings. The worker decodes that mix to mono
48 kHz float PCM and analyzes it as samples arrive. It reuses a ring,
Hann weights, an FFT plan and a scratch buffer. A video index job
receives the pinned asset path and stream index. It reads decoded frame
timestamps in the demuxer time base and checks that the presentation
clock stays ordered. An export verification job counts decoded frames
before TypeScript verifies the final stream metadata and publishes
the output.

The codec and DSP processes exchange bytes through pipes. Audio feature
rows use little-endian float32 values, with a 64 MiB response limit. The
frame index carries integer PTS, duration and relative presentation ticks,
with a 32 MiB limit. The Rust-to-Node pipe carries feature values and
timestamps. Node owns each completed response and retains it only as long as needed
by the caller or existing analysis cache. The Rust job and codec share a
private process group. The parent enforces cancellation and timeout, can
sample that group's memory under the render budget, and keeps an owner
pipe open. If the parent exits, EOF stops the group. Tool diagnostics
remain on stderr.

A short-lived executable fits these jobs because each consumes one
prepared source and produces a bounded result. It links against the
system runtime and uses the same FFmpeg and ffprobe on PATH as OpenCut.
Homebrew ships the worker with OpenCut. Source builds use Cargo and lock
dependency versions in `Cargo.lock`. Changing FFT implementations changes
the audio analysis key, so graphics rebuild with the matching features.
See [performance benchmarks](CLI.md#performance-benchmarks).

## Snapshots, caching and publication

A watch scopes its temporary media copies and rendered preview to a single
definition. It observes source, imported modules and referenced media. Failed
or superseded builds cannot publish over the last valid preview. Export pins
the selected revision's source copies for the duration of the render. The
watcher removes superseded copies after the last export using them finishes.

Foreground renders can cache lossless picture ranges on the project frame grid.
A range key describes its ordered visual layers and source samples in local
time, so moving the range preserves its key when its picture stays the same.
The renderer checks visual source identities on cache hits. It assembles the
ranges on the project clock before output frame-rate conversion, mixes audio
from the current plan, and encodes the MP4. Export preflight checks the plan
and required encoders. Render execution materializes the cache entries.
See [picture reuse between exports](CLI.md#reuse-picture-between-exports).

A batch compiles each TypeScript variant in a fresh worker and passes the
immutable composition to the shared renderer. Variants share source probes
and recipe cache entries. Each slot owns its temporary render files and
publishes its MP4 independently. The MP4 carries its own resolved parameters
and build record. See the [batch CLI contract](CLI.md#batch-rendering).

Asset resolution checks each recipe against its source and estimates the
output of each step. The processing pipeline materializes referenced assets
and probes each completed step before binding the timeline. A recipe is an
ordered chain of single-output steps. A step key includes the source content
hash or its predecessor’s key and output hash, plus the probed input metadata,
step parameters and format, and the FFmpeg and ffprobe build versions. AI
steps resolve the inherited or authored profile before cache lookup. Their
keys include effective quality, the algorithm and settings, the VideoToolbox
worker fingerprint, chip, and OS version. Equivalent prefixes share results
across assets and processes. Timeline-only edits leave those keys intact.

A SQLite writer lock per cache shard coordinates foreground processes. Only
one writer can encode or repair a particular entry. FFmpeg writes to a private
attempt directory within the staging directory for its key. OpenCut probes
the output, rechecks the input identity, and publishes the output and its
checksum receipt together with a directory rename. Aborted work removes its
stage. A guard stops the encoder process group if the build process exits
unexpectedly. A retry adopts an abandoned attempt if its committed receipt
matches the output checksum. Otherwise it discards the stage and starts a
fresh attempt. The AI recipe worker
receives decoded pixels and presentation timestamps through bounded pipes.
Interpolation keeps two input surfaces and one output surface. Video
super-resolution keeps the current and previous input and output surfaces.
Temporal denoising bounds its window by the model's reference counts and
the configured frame limit. The FFmpeg decoder, worker and encoder share
the step's process group and lifecycle. Watched revisions
pin copies of their final derived assets just as they pin unprocessed sources.
