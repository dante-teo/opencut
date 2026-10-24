# Media boundary

This headless package provides `probeMedia(file)` and
`extractFrame(file, timestampSeconds, output)` using external ffprobe/FFmpeg
executables. It exports typed metadata/results and `MediaError`, depends only on
Node built-ins, and is independent of Electron, React and the CLI.

See the [CLI/API contract](../../docs/CLI.md) for fields, prerequisites, limits
and file safety, and the [architecture](../../docs/ARCHITECTURE.md) for package
boundaries. Playback and rendering pipelines remain future work. Media binaries
are neither installed nor bundled here.
