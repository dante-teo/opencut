# Media boundary

This headless package provides `probeMedia(file)`,
`extractFrame(file, timestampSeconds, output)`, `composeMedia(options)` and
`renderVideoTimeline(options)` / `validateVideoTimeline(options)`. It exports
typed metadata, results and `MediaError`. It uses FFmpeg and ffprobe for
codec work and the bundled Rust media engine for decoded-frame indexing,
export verification and audio-dependent graphics. TypeScript prepares
the render plan and publishes verified outputs.

See the [CLI/API contract](../../docs/CLI.md) for fields, prerequisites, limits
and file safety, the [headless API example](../../docs/CLI.md#headless-media-api)
for composition options, and the [architecture](../../docs/ARCHITECTURE.md) for package
boundaries. Composition is a T03 FFmpeg spike for sequential clips and background
music, with normalized video/audio, source-preserving export and metadata checks.
T11 timeline rendering executes a resolved integer-frame video plan plus positioned
audio clips, with original audio, overlapping music, gain/mute and silent gaps.
See [project rendering](../../docs/CLI.md#project-rendering) for timing and limits.
[Exports](../../docs/EXPORT.md) support preflight, HEVC, and output-rate
controls. The CLI defaults to project-rate H.264. Cargo builds the
OpenCut media engine into `dist/`. The prebuilt distribution supplies that
worker and discovers FFmpeg and ffprobe on `PATH`.
