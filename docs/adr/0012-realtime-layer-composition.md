# ADR 0012: Shared real-time layer composition

Status: Accepted (T26)

## Decision

Extend T24's Canvas adapter using T23's ordered visual evaluation and authoritative
Web Audio clock. Chromium decodes all needed media asynchronously; Canvas 2D
submits scaled/clipped image draws without pixel readback or per-layer React state.
Retain T25's worker-backed proxies, paused frames, scoped grants and decoder budget.
Measured short workloads do not justify another graphics library, WebGL engine,
native decoder, or extra clock.

Put dependency-free composition geometry, canvas-color validation and SDR matrix
rules in `@opencut/shared`. Both browser drawing and FFmpeg consume the same even
fitting rectangles, source display aspect, centered crops and pixel-grid positions.
Export converts sources to RGBA and blends in encoded RGB source-over like Canvas,
then emits tagged BT.709 H.264. Clip opacity multiplies source alpha. Untagged HD
uses the browser's BT.709 matrix fallback; SD uses BT.601. HDR remains outside this
SDR contract. Existing operations and prerelease schema version 1 remain in use.

Extend the existing canvas color to `#RRGGBBAA` and `transparent`. Preview preserves
canvas alpha; H.264 flattens it over black. Originals remain export inputs. Opaque
H.264 proxies must not replace alpha-bearing video. Cache settings change identity
when interpretation changes; proxy grants carry original display aspect so scaled
proxy pixel rounding cannot move a layer.

Only evaluated, ready layers may paint. Seeks invalidate pending frame generations;
edits dispose snapshot resources. Invisible silent clips are skipped, audible ones
keep audio, and active clips take priority over lookahead at the decoder bound.
Paused PNG extraction is bounded across layers; decoded image memory is bounded
independently of encoded worker memory. Unknown-alpha occlusion is not optimized.

## Consequences

The former playback contract
defines coordinates, alpha, timing, tolerance gates, diagnostics and reproducible
Electron conformance/performance checks. Geometry agrees at project-pixel precision;
lossy encoding, scaling kernels, source-frame sampling and SDR/browser conversions
prevent pixel-identical output. Browser codec limits, asynchronous joins and the
16-source-run ceiling (including still images) remain visible limitations. Audio routing and its existing
compressor/FFmpeg limiter distinction remain unchanged. Transitions, keyframes,
advanced effects, new editing operations and T27 are deferred.

T47 replaced the live project compositor with watched definition playback.
See [preview and export consistency](../PREVIEW_EXPORT_CONSISTENCY.md).
