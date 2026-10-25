# ADR 0009: Positioned visual layers and canvas fitting

Status: Accepted (T12)

## Decision

Extend the pure render plan with positioned visual clips in bottom-to-top video
track array order. Same-track overlaps remain invalid. Preserve exact rational
project boundaries and sample timed sources before integer trimming, as in T10.
Still images repeat one decoded frame for the explicit clip range. Keep T11 audio
entries separate and reuse each video input for its audio entry once.

Add optional clip `visual` and settings `backgroundColor` fields to prerelease
schema version 1, including history snapshots. Omission preserves old serialized
content and renders as centered contain fitting, scale/opacity 1, black background.
Shared headless operations and CLI/batch mutations participate in existing history.

Scale multiplies the canvas fitting rectangle; each side rounds to even pixels.
Contain preserves display aspect with transparent margins, cover fills and crops
centrally, stretch fills independently. x/y are pixel offsets from the centered
fitted layer, positive right/down. Source alpha is multiplied by opacity and
composited over earlier layers, then an opaque canvas. Final H.264/yuv420p positions
use FFmpeg's chroma grid and cannot retain output alpha.

Reuse maintained FFmpeg scale/crop/lut/overlay filters and the existing process,
probe and publication utilities. No new rendering library or Electron dependency
is needed. Use a finite canvas and explicit half-open frame visibility, disabling
last-frame repetition after layer EOF. Keep each layer in the rational project
time base to avoid timestamp accumulation.

## Consequences

Portrait, landscape and square canvases share the same path. Gaps reveal lower
layers/background; audio tails reveal the background. Invisible clips retain their
audio and duration. Static images require explicit duration, and animated sources
with known duration retain timed-video semantics. Audio clips referencing videos
still play alongside original audio unless explicitly muted.

Limits bound canvas pixel count, scaled fitting rectangles, clips and duration;
whole-source sampling can be expensive for late in-points. Output alpha, keyframes,
transitions, effects, GUI integration and HDR/color management remain deferred.
The [CLI contract](../CLI.md#project-rendering) defines exact defaults and bounds.
