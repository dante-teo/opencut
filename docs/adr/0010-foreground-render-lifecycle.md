# ADR 0010: Foreground render lifecycle and verified publication

Status: Accepted (T13)

Date: 2026-10-26

## Context

T10–T12 already compile saved project snapshots into exact visual/audio plans,
execute FFmpeg in the headless media package, verify the MP4 and publish through
an exclusive hard link. Scripts need observable progress and cancellation without
moving editing logic into the CLI or introducing a persistent job system.

## Decision

Extend the existing renderer and Node subprocess utility. Reuse maintained FFmpeg
and Node APIs without a new backend or runtime dependency. A render remains a
foreground call; no job queue, daemon, database or saved job state is introduced.

Media consumes structured FFmpeg `-progress` records, independent of stdout chunk
boundaries, and emits progress through a synchronous callback. Frame counts are
monotonic and bounded by the planned total. Elapsed time starts with encoding;
remaining time estimates average encoding throughput and is absent when unknown.
Encoder completion transitions to verification; it does not establish publication.
The CLI owns human formatting, JSONL progress and terminal events, diagnostics on
stderr, process signal handlers and exit codes. Other CLI commands retain their
existing JSON contracts.

Pass an `AbortSignal` through the core Node adapter to input probing, encoding and
output verification. SIGINT/SIGTERM abort the call; the active tool receives SIGTERM,
then SIGKILL after two seconds if needed. Wait for child closure before rejecting
and removing temporary output. Bound execution time and captured stdout/stderr;
preserve meaningful tool diagnostics on failures. Core's pure planner remains
independent of signals, subprocesses, CLI streams and Electron.

Expose small quality and resolution preset sets. Quality selects encoder speed/CRF;
resolution fits the completed canvas, preserving project-space layer transforms.
Compare integer products to select the limiting dimension and retain the scale
as an integer ratio until final division to even pixels, minimum 2. Exact even
preset dimensions must not shrink through floating-point multiplication. Export
quality/resolution controls do not change frame timing, project schema, saved
content or history.

Write only inside an owned temporary directory on the destination filesystem.
Verify codecs, dimensions, timing and decoded frame count before publication.
Keep exclusive hard-link publication as the default, including destination races.
An explicit overwrite option permits atomic rename over a regular output file;
source media, the project file and output symlinks/directories are protected.
Handled failure or cancellation before publication preserves the previous export.
Publication is the commit point; cancellation after it cannot retract the export.

## Consequences

- Scripts must parse each render JSONL line and require exit 0 plus a `completed`
  event before consuming the destination. Encoding 100% alone is insufficient.
- Preflight probing and output verification have no remaining-time estimate;
  FFmpeg stalls can delay structured progress records.
- Cancellation is shared by headless callers through `AbortSignal`; CLI signal
  handling stays outside core and media. Shutdown escalation is bounded, but
  cleanup still waits for the child to close.
- New-file publication needs hard-link support; replacement needs same-filesystem
  rename. Atomic visibility does not promise power-loss durability. SIGKILL of
  the caller or power loss can leave an owned temporary directory.
- Existing T10–T12 sampling, compositing and audio behavior remains in effect.
  Desktop integration was deferred at T13 and is added by T28 below.
  Windows/Linux validation remains separate.

The [rendering contract](../CLI.md#render-presets-and-progress) defines exact preset
values, progress fields, JSONL events, exit codes and filesystem limits.

## T28 extension: desktop snapshots and output selection

Electron main owns one foreground export using the same headless renderer,
progress callback, cancellation signal, verification and temporary-file cleanup.
Capture the accepted project revision and detached project document before
asynchronous preparation, then resolve original-media references from that snapshot.
GUI edits and preview proxies cannot alter the active job. Source files remain
referenced in place; the snapshot does not freeze externally modified media bytes.

Keep the native destination selection separate from the last job's output path.
Restoring job status after a reload or window recreation must not populate the
next output field from historical job data. A successful native picker selection
is required again before another export. GUI publication always uses the exclusive
no-overwrite path; the CLI's explicit atomic replacement option remains available.
Job state stays in memory for the current process, without a persistent queue.

T28 adds optional HEVC and output-rate conversion to the shared media API.
Composition and source trims stay on the project grid; conversion samples the
finished composition and rounds duration up to a complete output frame, extending
the last picture and audio silence as needed. CLI flags and defaults are unchanged.
See [desktop export](../EXPORT.md) for settings, lifecycle and supported bounds.

## T43 durable jobs

The former durable job queue reused render verification in independent
worker processes and adds persistent immutable inputs, recoverable publication
and attempt leases. This is a separate entry point from the foreground CLI and
desktop exports described above.

T47 retired the queue. See the [current architecture](../ARCHITECTURE.md).
