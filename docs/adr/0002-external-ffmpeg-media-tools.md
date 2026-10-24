# ADR 0002: Use external FFmpeg tools for T02 media operations

Status: Accepted

Date: 2026-10-24

## Context

T02 needs structured local media inspection and single-frame PNG extraction
through the standalone CLI. These capabilities belong in the headless media
package and must work without launching Electron. The scope does not include
editing, playback or a rendering pipeline.

## Decision

Implement `probeMedia` with ffprobe JSON and `extractFrame` with FFmpeg in
`@opencut/media`. The CLI imports this package directly; core remains independent
of media execution until an editing operation needs it. This replaces the empty
media placeholder from [ADR 0001](0001-shared-headless-core.md) while preserving
its rule that editing behavior belongs in the shared headless core.

Use asynchronous Node `execFile` with argument arrays, closed stdin, a timeout
and bounded buffers. Node's subprocess API is sufficient for this boundary;
no subprocess wrapper or native binding is needed. Users install the executables
manually and make them available on PATH. OpenCut does not download or bundle them.

Normalize metadata into typed results, retaining container and stream start
timestamps. Frame requests are relative to input start, so a video's end is its
start minus input start plus duration. Missing timing falls back to reported media
duration or an extraction attempt. The [CLI/API contract](../CLI.md) defines fields,
units, limits and errors.

Decode a PNG into a bounded buffer before creating the destination exclusively.
Existing files and symlinks are refused. Subprocess failures leave no output;
filesystem write failures can leave an incomplete newly created file. Source
media is never written.

## Consequences

- Help/version and ordinary headless tests remain independent of media binaries.
- Media commands need ffprobe; frame extraction also needs FFmpeg with PNG support.
- Opt-in native tests cover real metadata, extraction, timestamp offsets and errors
  using synthetic fixtures and outputs isolated from user media.
- This selects tools for T02 inspection and extraction. Playback/render backend
  choice, distribution, process isolation and GUI media access remain open.
