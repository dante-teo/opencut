# ADR 0008: Mix positioned audio alongside the integer-frame video plan

Status: Accepted

Date: 2026-10-25

## Context

T11 adds original video audio and independent background audio to saved-project
rendering. The timeline already has audio tracks, explicit source ranges and
non-ripple positioning. [ADR 0007](0007-integer-frame-timeline-rendering.md)
established the pure render plan, FFmpeg executor and verified publication path,
but T10 rejected audio tracks and exported video only. T03's separate composer
already supplies resampling, mixing and latency-compensated peak limiting.

## Decision

Extend the existing render plan with positioned audio entries for video and
audio-track clips. Convert each clip's rational boundaries once and use those
frame indices for both video segments and audio entries. Keep project compilation
in the pure core, path resolution in its Node adapter, and stream probing and
FFmpeg filter execution in the headless media package.

Add optional per-clip `volume` and `muted` fields to prerelease schema version 1.
Volume is linear amplitude in [0, 1], default 1; mute defaults to false and
overrides gain without changing it. Keep omitted fields omitted in old projects
and history snapshots. Reuse the existing editing and transaction paths through
`clip audio` / `clip.audio`; splits copy these settings and moves/trims retain
them. No separate audio editing model or track-level gain is introduced.

Select the default audio stream, falling back to the first, and resample/downmix
to 48 kHz stereo. For video assets, source zero is the first video frame; for
audio-only assets, it is the first audio sample. Preserve relative stream delays
and timestamp gaps before applying source trims and timeline positioning.
Round absolute project-frame boundaries to the nearest audio sample, half up,
rather than accumulating independently rounded clip durations.

Mix gains without active-input normalization. Reuse T03's peak limiter at 0.95
with latency compensation. A finite silence bed fixes the mix duration and fills
gaps. The latest exclusive clip end across all tracks determines duration,
including muted or zero-gain clips. Extend video with black frames when audio
continues beyond it. Always export H.264/AAC MP4 with 48 kHz stereo audio, even
when the complete audio stream is silent.

Video clips without audio, or whose audio ends early, supply silence. Independent
audio-track clips require a current audio stream and a known, in-bounds source
range, even when muted. Keep the existing one-video-track restriction, same-track
overlap validation and source-preserving publication path. This decision replaces
ADR 0007's audio-track rejection and video-only output restriction; its video
sampling and publication decisions still apply.

## Consequences and alternatives

- Simultaneous audio sources use separate tracks. An audio clip referencing a
  video asset does not detach or mute that video's original audio; callers must
  mute the video clip explicitly when they want only the independent audio clip.
- Gains stay stable as sources enter or leave, while the limiter can reduce loud
  peaks. Averaging active inputs would instead change perceived gain with overlap.
- Using the longest clip avoids cutting off background audio at the last video
  frame. Muting affects sound, not timeline coverage or output duration.
- Fractional frame/sample boundaries can differ by one sample at a split. AAC
  is lossy and can expose decoded EOF padding; this is not a sample-exact lossless
  audio contract.
- Old version 1 projects remain readable without inserted defaults. Older strict
  binaries reject clips containing the new fields; no migration or silent field
  stripping is introduced.
- No new dependency, audio effects, keyframes, fades, transitions, GUI project
  integration or T12 behavior is introduced. Music does not loop automatically.

The [rendering contract](../CLI.md#project-rendering) defines commands, limits,
stream requirements and output verification. The
project format describes stored timing
and clip properties.

The saved project format was retired. See [video definitions](../VIDEO_DEFINITIONS.md) for current authoring.
