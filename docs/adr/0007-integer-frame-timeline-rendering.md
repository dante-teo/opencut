# ADR 0007: Render saved timelines through integer-frame plans

Status: Accepted

Date: 2026-10-25

T11's [ADR 0008](0008-positioned-audio-mixing.md) extends this plan with audio
mixing and replaces the T10 audio-track rejection and video-only output limits.
The video sampling decisions below remain in effect. T13's
[ADR 0010](0010-foreground-render-lifecycle.md) retains exclusive publication by
default and adds verified atomic replacement when explicitly requested, plus
progress, cancellation and export presets.

## Context

T10 connects saved project timelines to the existing FFmpeg media infrastructure.
The core already stores exact rational times and provides shared timeline edits;
T03 composes whole source files independently of project data. Rendering must
preserve trim/split boundaries and gaps at integer and fractional project rates,
without tying project operations to Electron or a second editing model.

## Decision

Compile a validated saved-project snapshot into ordered clip/gap segments in the
pure core. Convert rational boundaries with bigint and require exact alignment
to the project-frame grid. Compute clip counts from integer source endpoints;
never round each clip's duration independently. Resolve media through the core
Node adapter, using the physical project directory for relative references.
Pass resolved segments to the media package, which has no project-model dependency.

Reuse FFmpeg subprocess execution and T03 aspect-ratio normalization. Normalize
each source's timestamps to its first video frame and sample on the project-rate
grid before trimming by integer frame indices. A split then selects the same
sampled frames as the original clip, including when source/project rates differ.
Generate black segments for leading/interior gaps. After concatenation, regenerate
global timestamps from frame indices in the exact rational project time base;
use the frame-rate numerator as the MP4 track timescale.

Render to a temporary sibling directory. Verify H.264 codec, dimensions, exact
frame rate, duration, and decoded frame count before publishing through an
exclusive hard link. Refuse existing outputs and destination races. Rendering
reads sources and the saved project without changing metadata, revision or history.

## Consequences and alternatives

- T10 supports exactly one video track and emits video-only MP4. Additional tracks,
  including empty/audio tracks, are rejected. Still images, effects, transitions,
  audio mixing and desktop project integration remain outside this milestone.
- Rejecting subframe boundaries preserves exact intent. Silently rounding them
  or summing decimal durations could shift trims, gaps or later clip boundaries.
- Sampling a source before trimming preserves split equivalence. Restarting rate
  conversion independently at each clip's in-point could change its sampling phase.
- Whole-source sampling can make late in-points expensive. Seek optimization must
  preserve the same source grid and decoded frame sequence before replacing it.
- The existing model still accepts more timelines/settings than this renderer.
  Rendering restrictions do not change the project schema or offline editing.
- Decoded frame-count verification adds work but detects short or damaged exports
  that container headers alone would not establish as complete. Publication requires
  a destination filesystem with hard-link support; forced termination can leave
  owned temporary output. Source files must remain stable during rendering.
- T03's path-based composition and audio behavior remain separate. This decision
  selects FFmpeg for T10 export without deciding future multi-track effects,
  audio architecture, desktop playback ownership or distribution.

The [rendering contract](../CLI.md#project-rendering) defines commands, supported
limits, result fields, failure behavior and a worked example.
