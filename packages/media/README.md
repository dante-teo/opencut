# Media boundary

This headless package provides `probeMedia(file)`,
`extractFrame(file, timestampSeconds, output)`, `composeMedia(options)` and
`renderVideoTimeline(options)` using external ffprobe/FFmpeg
executables. It exports typed metadata/results and `MediaError`, depends only on
Node built-ins, and is independent of Electron, React and the CLI.

See the [CLI/API contract](../../docs/CLI.md) for fields, prerequisites, limits
and file safety, the [headless API example](../../docs/CLI.md#headless-media-api)
for composition options, and the [architecture](../../docs/ARCHITECTURE.md) for package
boundaries. Composition is a T03 FFmpeg spike for sequential clips and background
music, with normalized video/audio, source-preserving export and metadata checks.
T11 timeline rendering executes a resolved integer-frame video plan plus positioned
audio clips, with original audio, overlapping music, gain/mute and silent gaps.
See [project rendering](../../docs/CLI.md#project-rendering) for timing and limits.
Desktop timeline playback remains future work. Media binaries
are neither installed nor bundled here.
