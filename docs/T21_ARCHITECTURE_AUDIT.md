# T21 — Architecture audit and playback baseline

This is the durable capability boundary and benchmark protocol for completed
T01–T20, audited in T21. It is not a new playback engine. T22–T27 below are
recommendations, not implemented features or commitments.

## Deliverables and acceptance boundaries

1. This capability matrix, source map, correctness risks and prioritized roadmap.
2. `scripts/t21-projects.ts`: five deterministic, portable project recipes; all
   generated projects/media/exports live in a fresh `tests/fixtures/generated/t21-*`
   directory. No existing fixture directory or user media is overwritten.
3. `pnpm audit:t21`: build, generate, compile render plans, export and measure
   actual Electron playback. `baseline.json`, `desktop.json` and `desktop.log`
   retain machine-readable samples, environment, failures and runtime evidence.
4. `tests/baselines/t21-macos-arm64.json`: historical measurement evidence for the
   recorded revision and harness hashes; generated absolute paths identify that
   run, not portable inputs.
5. Headless project-contract tests plus existing editing, native export and
   Electron tests. Validation outcomes belong in the completion chat; this
   document describes lasting capabilities and reproducible measurement semantics.

Acceptance of this audit does **not** require inventing live timeline FPS. Missing
capabilities are recorded as unavailable with a reason and a route to later
verification. Failed benchmarks are not passing benchmarks.

## Architecture and evidence map

`desktop renderer → typed sandbox preload → main ProjectSession → core` and
`CLI → core` share project validation, timeline operations and transaction/history
semantics. Node persistence and rendering are behind `@opencut/core/node`.
`core render plan → media → FFmpeg/ffprobe` is the offline export path.
`renderer HTMLMediaElement → authorized range-serving protocol → local file` is
an independent source playback path. It does not consume `ProjectRenderPlan`.

Relevant implementations:

- `packages/core/src/{project,timeline,editing,time}.ts`: schema, rational time,
  same-track overlap validation, snapshots, revision guards and pure edits.
- `packages/core/src/{project-files,render-files,render-plan}.ts`: locking,
  atomic publication, source resolution and frame-grid render compilation.
- `packages/media/src/{render,probe,process}.ts`: decoded stream inspection,
  sequential filter-graph composition, audio mix and bounded subprocesses.
- `apps/desktop/src/main/{index,project-session,preview-file}.ts` and preload:
  sender validation, serialized project sessions, authorized media URLs and byte
  ranges. Renderer remains sandboxed; audit adds no IPC or production privileges.
- `apps/desktop/src/renderer/{project-workspace,project-timeline,timeline-geometry,
video-preview,preview}.tsx/.ts`: independent project playhead, source transport,
  viewport indexing, presentation callbacks and process telemetry.
- `apps/cli/src/`: public commands invoke the same core and Node adapters.

The audit reuses installed Playwright, Electron, core serialization/render planning,
FFmpeg and the existing preview benchmark. No new dependency or media-engine
abstraction is needed to observe these behaviors.

## Capability matrix

**Implemented** means verified within the stated scope, not universal media support.
**Partial** means a working subset with a material gap. **Missing** means no current
execution path. **Unverified** means no sufficient runtime evidence in this audit.
Test paths below are relative to `tests/` unless prefixed otherwise.

| Capability                                     | Status      | Evidence and boundary                                                                                                                                                                 |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned project, rational time, validation   | Implemented | Core project/time suites; T21 project round-trip and render-plan contracts.                                                                                                           |
| Track/clip add, move, trim, split, delete      | Implemented | Core timeline/editing, CLI integration, Electron timeline-editing tests. No ripple/transitions; same-track overlap rejected.                                                          |
| Clip gain/mute/position/scale/opacity          | Implemented | Core, clip-properties Electron persistence tests, native compositing/audio tests. These are intent and export controls.                                                               |
| Source video play/pause/seek/frame step        | Implemented | T21 real Electron cold/warm seeks and playback; preview Electron tests. Frame numbers from average FPS are nominal.                                                                   |
| Source image/audio selection                   | Implemented | asset-preview/media-library Electron tests. Audio uses native transport; these are not timeline audio/image composition.                                                              |
| Linked clip preview and playhead               | Partial     | timeline Electron test verifies mapped source seeks and playhead clamping; playback does not advance to the next clip or enforce a trimmed source-out stop.                           |
| Full edited-timeline playback                  | Missing     | Every T21 project opens to a visible placeholder with no video element in Project viewer. Project Space does not start a timeline clock.                                              |
| Multi-track live video/audio composition       | Missing     | Source player owns one original source. No project compositor, mixer or cross-clip scheduling path. Overlapping-track FPS is unavailable.                                             |
| Multi-track offline export                     | Implemented | T21 five exports pass metadata/decoded-frame verification; native T10–T13 tests check boundary pixels, audio and lifecycle. Up to 64 clips/600 seconds.                               |
| Preview/export visual and audio parity         | Missing     | Source preview ignores stored transforms/gain/mute and gaps; export uses ordered layers, fitting, background, mix/limiter. Export playback is not parity.                             |
| GUI/CLI saved project interoperability         | Implemented | desktop-project integration and project/clip-properties Electron tests verify CLI readback and save/reopen.                                                                           |
| Automatic external edit refresh                | Missing     | Explicit reopen required; save conflicts refuse to overwrite external edits. No watcher/merge.                                                                                        |
| Undo/redo and persistence                      | Implemented | Core editing and project session tests plus GUI save/reopen. UI selection is transient; project/history are persisted.                                                                |
| Decoding and seeking                           | Partial     | Chromium source decoder vs FFmpeg export decoder; T21 H.264/AAC and VP9 sources measured. Arbitrary VFR/HDR/rotation/color parity unverified.                                         |
| Cache and prefetch                             | Partial     | Chromium/OS caches, byte-range source serving (`no-store`), per-render metadata Map and timeline index exist. No editor-owned decoded-frame cache, proxies or adjacent-clip prefetch. |
| Source FPS/dropped frames/process telemetry    | Implemented | Existing renderer measurement reused by T21; raw quality counters, callbacks and Electron app metrics retained.                                                                       |
| Concurrent-decoder load/long-session stability | Unverified  | 48-clip/six-track case measures source playback with timeline UI loaded and offline export, not six live decoders. Eight-second media is not an endurance test.                       |
| Windows/Linux parity; broad device coverage    | Unverified  | Retained baseline is one macOS arm64 machine; no cross-platform claims.                                                                                                               |

## Reproduction and fallback contract

From the repository root with the pinned pnpm/Node environment and installed
workspace dependencies:

```sh
pnpm audit:t21
pnpm audit:t21 --headless
```

Both build first. The second is the explicit fallback for no usable desktop/display:
it still creates projects, compiles plans and attempts exports, and labels desktop
seek/FPS/CPU/memory **unavailable**. Neither command installs FFmpeg, codecs or other
prerequisites. Missing FFmpeg/ffprobe produces portable offline projects/plans and
explicit unavailable media/export entries. If Electron can launch, offline projects
can still be inspected; missing media is not treated as successful playback.

A decoder/encoder, assertion, timeout or Electron launch failure records diagnostics
and exits nonzero. Existing measurements are retained as partial evidence; resolve
the recorded cause and rerun in a new directory. If the desktop cannot run, use
`--headless` and keep both runs. If the build itself fails, the command stops before
benchmarking: retain the build output and fix it; do not use an older baseline as
current evidence. Killing the runner cannot guarantee a final report, but stage
checkpoints and the isolated generated directory remain inspectable.

The final console line names `baseline.json`. To reproduce only desktop measurement
against a retained generated directory after a successful build:

```sh
OPENCUT_T21_DIR=/absolute/path/to/tests/fixtures/generated/t21-RUN pnpm exec playwright test --config playwright.t21.config.ts
```

This rewrites only that run's desktop result. For a coherent baseline including
exports, rerun the complete command. Generated output is intentionally retained for
opening each `.opencut.json` in the GUI, CLI inspection and playback of exports.
Delete only a reviewed generated run directory when no longer needed.

### Workloads

All projects use 1280×720, 30 fps, blue background. Inputs are synthetic:
H.264/AAC 1280×720 30 fps, eight seconds, GOP 120, CRF 23, fast preset;
VP9/WebM 640×360 25 fps, eight seconds, GOP 100; 48 kHz stereo PCM WAV;
and a 320×180 red PNG. Actual ffprobe metadata, SHA-256 and tool versions are saved.

| Project  | Intended observable result                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| cuts     | H.264 to VP9 cut at 3 seconds; six-second output, mixed frame rates/resolutions.                                         |
| gaps     | Initial 0–1 s and internal 3–4 s background gaps; video ends at 6 s, audio tail extends output to 8 s.                   |
| overlays | Red image above video from 1–5 s, half scale/opacity and offset; six-second output.                                      |
| mixing   | Original audio at 0.5, WAV at 0.25 from 1–6 s; half-scale VP9 layer at 2–6 s, muted.                                     |
| stress   | 48 one-second clips, six concurrent video tracks, eight-second output; silent, progressively smaller translucent layers. |

### Measurement definitions

Keep Electron foreground and visible at its default window size; do not run other
benchmarks concurrently. Record hardware, OS, Electron/Chromium, GPU features,
display, window bounds and media metadata. Background user/system load, power mode,
thermal state and filesystem cache are uncontrolled, not assumed idle or identical.

- **Decoder-cold seek**: five fixed target fractions, `video.load()` and loaded-data
  readiness before each seek; latency excludes loading and metadata probing.
  Completion requires both `seeked` and a presentation callback near the target.
  This resets the media element, **not** the OS disk cache or the Electron process.
  Decoder internals are not directly inspected; decoder-cold is this operational label.
  Five samples make p95 the maximum; this is a small baseline, not a tail SLA.
- **Warm seek**: existing T04 benchmark, three warmups then 30 deterministic
  alternating jumps. Store raw `seeked` and presented-frame latency separately;
  median and nearest-rank p95 are not interchangeable with first-open latency.
- **Playback**: up to eight media seconds at 1×; browser total/dropped-frame deltas,
  callback gaps, stalls and waiting events. Decoded FPS = total frame delta / wall
  seconds; presented FPS = (total − dropped) / wall seconds. Startup/polling overhead
  is included, so rates may fall slightly below nominal without sustained drops.
- **Resources**: existing Electron metrics sampled about every 500 ms after priming
  CPU deltas; sum over app processes. Working set can double-count shared pages and
  is not unique resident memory or a leak measure. CPU is Electron's process CPU
  percentage aggregate, not system-wide utilization; do not compare blindly across OSes.
- **Multi-clip load**: source playback is measured with each representative project
  open. The cuts case uses VP9; other cases use H.264. Mixing also plays its rendered
  MP4 as a separate, explicitly labeled file benchmark. No result is live composition.
- **Export wall time**: includes CLI startup, probing, encode and verification;
  it is not pure encoder throughput. Source/render hashes and versions allow comparison,
  but encoded bytes need not match across runs, even with the same toolchain.
  Regenerated WebM container hashes can differ while decoded video matches.
  Use hashes to identify exact inputs and verify preservation within a run;
  compare decoded frames/audio when assessing media equivalence across runs.

Raw data is observational with no hardware-independent pass threshold. Re-run before
claiming a regression; compare like workload, cache condition, window and runtime.
The diagnostics popover remains open during telemetry, so part of the video is
occluded. Screenshot pixel checks close it first to avoid sampling the popover.
The smaller T21 sources complement `pnpm test:preview` (existing 1080p30/59.94 source
pixel-frame verification); they do not replace that wider source-preview suite.

## Bottlenecks, debt and correctness risks

**Verified architectural gaps:** no consumer of the render plan in the live viewer;
no master project clock, decoder scheduling, audio mixer or rendered-frame feedback.
The source and project playheads are intentionally separate. A linked source clamps
the displayed project position at the clip end while source playback can continue.
Clip-property edits return to Project viewer, where their result cannot be previewed.
This is a product correctness/feedback limitation, not evidence of slow decoding.

**Verified export limits:** the planner accepts at most 64 clips, 600 seconds,
1–120 fps and bounded even H.264 dimensions. Each visual clip introduces an FFmpeg
input/filter chain, even when sources repeat; only probe metadata is deduplicated.
Filters run with one complex-filter thread and encoding with two threads. Six-layer
export cost is measured; attributing cost specifically to re-decoding needs profiling.
An audio-only timeline cannot render without a visual clip.

**Verified synchronization boundary:** saved JSON is shared, but a GUI in-memory
session does not receive CLI edits automatically. Optimistic revision/content checks
and locks prevent cooperating writers from silently clobbering saved work. There is
no external-change merge UI. Audit fixtures do not change production session logic.

**Code-supported risks requiring profiling or broader fixtures:** history stores full
before/after snapshots; validation/serialization visits those snapshots, so long edit
histories may dominate memory, IPC and save latency despite virtualized timeline DOM.
This audit does not establish a leak or a measured history bottleneck. Chromium and
FFmpeg can disagree on VFR sampling, stream origins, rotation, color/HDR and codec
support. Exact project-grid export and nominal average-FPS source stepping are distinct
contracts. Browser resource counters alone cannot establish A/V synchronization or
pixel/color parity. These need independent decoded-frame/audio oracles and longer runs.

## Recommended T22–T27 priorities

| Task | Priority and bounded outcome                                                                                                               | Verification gate                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T22  | P0: shared playback contract and project clock; consume a pure timeline plan for single-track cuts/gaps without changing export semantics. | Deterministic clock/state tests, cut/gap/end/seek behavior against frame-grid export oracle.                                                                            |
| T23  | P0: real-time ordered video/image composition, fitting/transforms/background.                                                              | T21 overlay frames match export at boundaries and alpha/scale/offset cases; explicit unsupported-media behavior.                                                        |
| T24  | P0: timeline audio scheduling, original audio + independent tracks, gain/mute and sync.                                                    | Mix amplitudes/silence/tails and A/V markers across seeks, pause/resume and fractional frame rates.                                                                     |
| T25  | P1: decoder lifecycle, bounded prefetch/frame cache and evidence-led proxy policy.                                                         | True concurrent-track cold/warm baselines, cancellation, eviction budgets and sustained resource measurements; choose libraries/backends from profiling evidence.       |
| T26  | P1: preview/export conformance across mixed rates, formats, timestamps and color metadata.                                                 | Independent frame/audio comparisons, VFR/rotation/HDR fixtures, explicit policy for unsupported formats; test multiple OSes.                                            |
| T27  | P1: scale/reliability gate and project synchronization UX.                                                                                 | Long-history/long-playback profiling, stale-file reopen/conflict behavior, save/undo stress and per-machine regression budgets; revisit export caps only with evidence. |

Clock, composition and audio correctness precede cache tuning. Do not choose a native
engine or rewrite the exporter from these short source-only performance numbers.

## Retained baseline

Retained JSON files describe the run that produced them. Check `revision`,
`workingTree` and `harnessSha256` before treating a result as evidence for a later
checkout. The table below predates the benchmark-runner cleanup: its recorded
`scripts/t21.ts` hash differs from the current runner. The figures remain historical
observations, not a playback measurement of the cleaned-up harness.

To refresh current playback evidence, run `pnpm audit:t21` and inspect the new
report's status, samples and provenance before retaining it and updating this table.
A headless run cannot refresh desktop playback evidence. Never change an old report's
hashes or timestamp to make its measurements appear current.

Measured on Apple M1 Max, 10 logical CPUs, 32 GiB RAM, macOS Darwin 27.0.0,
Electron 45.0.0/Chromium 156.0.8078.48.
Run timestamp: 2026-10-28T16:24:38.854Z (UTC). These are short, single-run observations.

| Loaded project / played file | Decoder-cold median / p95 ms | Warm median / p95 ms | Presented FPS | Dropped frames | Median app CPU % | Median working set MiB |
| ---------------------------- | ---------------------------- | -------------------- | ------------- | -------------- | ---------------- | ---------------------- |
| cuts/mixed.webm              | 19.9 / 29.7                  | 16.7 / 32.5          | 24.55         | 0              | 2.96             | 580.4                  |
| gaps/source.mp4              | 19.3 / 29.8                  | 20.4 / 34.2          | 29.33         | 0              | 3.08             | 683.5                  |
| overlays/source.mp4          | 23.2 / 26.4                  | 19.0 / 35.2          | 29.24         | 0              | 3.53             | 700.1                  |
| mixing/source.mp4            | 24.3 / 28.9                  | 18.1 / 33.5          | 29.26         | 0              | 3.55             | 707.7                  |
| mixing/mixing.mp4            | 33.7 / 46.8                  | 29.8 / 47.1          | 29.07         | 0              | 4.01             | 711.9                  |
| stress/source.mp4            | 26.0 / 27.5                  | 18.3 / 33.4          | 29.33         | 0              | 4.18             | 721.5                  |

Export wall times including verification: cuts 0.77 s, gaps 0.75 s, overlays 0.89 s, mixing 0.91 s, stress 4.78 s. All four generated source
hashes remained unchanged. Cases share an Electron process; working-set differences
include accumulated caches and cannot be attributed solely to track count.
No live timeline FPS, concurrent decoder throughput or A/V parity is implied.

Raw evidence: [T21 baseline](../tests/baselines/t21-macos-arm64.json),
[1080p source benchmark](../tests/baselines/t21-1080p-source.json), and
[unavailable-tools/headless fallback](../tests/baselines/t21-unavailable.json).
The fallback was exercised with FFmpeg/ffprobe deliberately excluded from PATH;
those tools remain installed on the host.
