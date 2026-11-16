# OpenCut CLI

`opencut --help` lists the primary commands. From a checkout use
`node apps/cli/dist/index.js` after `pnpm build:packages` and
`pnpm --filter @opencut/cli build`. FFmpeg and ffprobe are required for
rendering media. Use `opencut system inspect --json` for hardware diagnostics.

```sh
opencut validate edit.video.ts
opencut inspect edit.video.ts --json
opencut timeline inspect edit.video.ts --frame 60 --json
opencut preview edit.video.ts --watch
opencut preview frame edit.video.ts --frame 60 --output review.png
opencut render edit.video.ts --output final.mp4
opencut subtitles export edit.video.ts --output captions.srt
```

Use `opencut render --help` for quality, resolution, codec, frame rate and
audio settings. Outputs are new files unless a supported render explicitly
requests `--overwrite`. Use `--json` for machine output and SIGINT or SIGTERM
to cancel foreground work. Render runs in the CLI with FFmpeg subprocesses.

## Render quality profiles

`render` and `batch` default to `quality`. All `preview` commands, including
`preview --watch`, default to `fast`. Set `--quality fast|quality|maximum`
to select a profile. It controls encoding and any interpolation or
super-resolution step that has no authored quality override.
`timeline inspect` defaults to `quality` and accepts the same flag to inspect
another recipe profile.

| Profile   | AI interpolation                                                        | AI super-resolution                  | MP4 encoder preset and CRF |
| --------- | ----------------------------------------------------------------------- | ------------------------------------ | -------------------------- |
| `fast`    | VideoToolbox low-latency midpoint                                       | VideoToolbox low-latency 1.5× or 2×  | ultrafast, 28              |
| `quality` | VideoToolbox offline frame-rate conversion revision 1, quality priority | VideoToolbox temporal 4×, revision 1 | veryfast, 17               |
| `maximum` | Same as `quality`                                                       | Same as `quality`                    | medium, 16                 |

CRF applies when the video bitrate is unspecified. H.264 and HEVC use
libx264 and libx265 respectively. PNG previews use lossless encoding.
An unsupported AI step reports how to check its requirements. Select a
different profile or adjust the recipe explicitly. `system inspect --json`
lists the profile defaults, model configuration probes, host worker cap and
memory pressure. Run the actual render to verify support for a particular
source. The [benchmark instructions](#performance-benchmarks) use generated
motion, audio and subtitle fixtures.

Media tools include `probe`, `extract-frame`, and `separate-dialogue` on
source paths. Choose a destination that supports hard links for
`extract-frame` so it can publish the completed PNG atomically. Dialogue
separation requires a separately installed ELUATE model.

`online search` reads a JSON request. `online download` returns the downloaded
file's path and provenance for use in a definition. Cancelling an in-flight
frame extraction or download discards partial output.

See the [definition reference and examples](VIDEO_DEFINITIONS.md).

## Media recipes

```sh
opencut recipes inspect edit.video.ts --json
opencut recipes validate edit.video.ts
opencut render edit.video.ts --recipe-cache ./recipe-cache --recipe-workers 2 --output final.mp4
```

`recipes inspect` and `recipes validate` check source streams and ordered
steps without transcoding. The normal `validate`, `inspect`, and `render`
commands and all preview modes accept these processing options when compiling referenced
recipes.

| Option                     | Default and scope                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--recipe-cache`           | `$XDG_CACHE_HOME/opencut/recipes-v3`, or `~/.cache/opencut/recipes-v3`. Use a private local directory that supports file locks and atomic rename.                                                                            |
| `--recipe-workers`         | Defaults to 1. Accepts up to 16 as a ceiling, with a host cap based on CPUs and memory (at most 4). macOS memory-pressure warnings limit new work to one active stage.                                                       |
| `--recipe-temp-bytes`      | 4 GiB for staged media per invocation, split evenly among workers. The OS file limit rounds down and can be stricter on Linux depending on the shell.                                                                        |
| `--recipe-memory-bytes`    | Total native budget, capped at a quarter of installed memory (up to 8 GiB on Apple Silicon). Stages reserve up to 1 GiB normally, 2 GiB for offline interpolation, and 4 GiB for offline super-resolution.                   |
| `--recipe-buffered-frames` | 32 frames per FFmpeg filter graph. VideoToolbox interpolation needs 3 surfaces, fast super-resolution 2, and offline super-resolution 4. Denoise needs the current and output surfaces plus the configured reference window. |
| `--recipe-max-pixels`      | 8,847,360 pixels per input or output frame.                                                                                                                                                                                  |
| `--recipe-timeout-ms`      | 1,800,000 milliseconds per step.                                                                                                                                                                                             |

Processing limits apply to fresh recipe work. Cached media and composition
outputs have their own disk usage. Matching inputs, effective AI profiles,
algorithm settings, and backend versions reuse completed entries. A backend version change rebuilds affected
steps and their dependents on the next run. Older entries stay on disk until
removed. Stop active builds before clearing the cache directory.

Foreground rendering reports step starts, media time, completions, and cache
hits on stderr. A successful `render --json` includes `recipeProcessing` when
recipes were used. Each entry has `assetId`, a zero-based `step`, a cache
`key`, and a `status` of `completed` or `cache-hit`.

SIGINT and SIGTERM cancel active steps. See [build recovery](#build-recovery)
for abrupt exits and retries.

Fresh recipe execution requires macOS or Linux and FFmpeg with
`-filter_buffered_frames` and FFV1 encoding in MOV. Verified on macOS with
FFmpeg and ffprobe 9.0.2. Node versions that mark the built-in SQLite module
experimental may print a warning on stderr when opening the build cache.

`interpolateFrames` and `smoothSlowMotion` add local VideoToolbox inference to
referenced video recipes. Source identity, prior steps such as `trim`, target
rate, quality, scene settings, and the backend build and OS identify the
cached result. The memory budget samples the combined RSS of the decoder,
model worker, and encoder every 50 ms. macOS pressure is sampled separately
to account for allocations outside that tree. New stages fail when pressure
is critical. Native inference checks happen on a fresh execution of
`validate`, `inspect`, `preview`, or `render`. See the
[AI recipe settings and supported inputs](VIDEO_DEFINITIONS.md#ai-interpolation).

`superResolution` and `denoise` use the same cache, progress, and cancellation
controls. Put `trim` first to limit inference to a source range. For UHD,
start with one recipe worker. Use `system inspect --json` for the supported
configurations and model readiness, then `validate` to run the actual job.
See [enhancement presets and limits](VIDEO_DEFINITIONS.md#ai-enhancement).

## Build recovery

```sh
opencut build inspect edit.video.ts --recipe-cache ./cache --json
opencut render edit.video.ts --recipe-cache ./cache --output final.mp4
```

Foreground compilation and rendering write local receipts in the recipe
cache. `build inspect` resolves the current definition and inputs and reports
their build ID, last compilation state, recorded recipe stages, and render
states. Use the same cache, parameters, `--quality` and `--no-subtitles` selection as
the original build. Inspection evaluates trusted TypeScript and hashes
inputs. If the definition or inputs changed, inspection addresses the new
build.

- `steps[].reusable` means the recorded SHA-256 receipt matches a published
  or staged recipe result. Inspection leaves verified staging in place for
  the next retry, which checks the current recipe inputs and backend.
- `renders[].state` describes the output. A `rendered` entry includes its
  verified checksum. The optional `renders[].lastAttempt` describes a newer
  attempt separately, so a failed overwrite can coexist with a valid MP4.
  `missing-or-corrupt` means the published file is missing or its bytes no
  longer match the receipt.

After a crash, rerun the command with the same cache. Completed processing
is checked against its SHA-256 receipt before reuse. The key includes the
source bytes, relevant probed inputs and step settings, upstream output,
and the backend fingerprint. A layout-only edit can reuse the same media
stages. An interrupted encoder starts over in new scratch space. A retry
removes the old scratch for the same build and output. A verified MP4 is
published atomically; a failed or interrupted overwrite leaves any previous
output intact until a replacement is verified. If inspection finds the MP4
was already published, use it, or choose a new output explicitly.

## Portable projects

```sh
opencut package src/edit.video.ts --root . --resource src/captions.txt --output ./bundle
opencut package verify ./bundle --json
opencut render ./bundle/opencut.bundle.video.ts --output ./final.mp4
```

Move the entire bundle. The generated TypeScript entry rebuilds the selected
composition using the bundled inputs, even without the original TypeScript
packages installed. Use `--params` at packaging time to choose a variant.
Keep the generated entry named `opencut.bundle.video.ts` at the bundle root.
When rendering that entry, OpenCut verifies the package inventory and hashes,
then reads the generated default export as data. Verification rejects symlinks
at the manifest or entry and anywhere along a listed dependency path.
Copy the editable sources from `project/` to make changes, then package them
again.

Choose a new output directory under an existing parent. The default root is
the authored definition's directory. Use `--root` to include shared files
in a common ancestor. The package collects declared media and fonts, static
relative imports (including type imports), and computed imports run for
the selected composition. Supply `--resource` once per additional local
authoring file, such as a subtitle file read directly with Node. Resource
paths are relative to the project root. Files required only by other
parameter selections or arbitrary filesystem reads are not inferred. Unresolved
relative imports, escaping paths, symlinks, and destination collisions fail.

The `opencut-package.json` manifest records input hashes, payload bytes,
recipes, toolchain and native backend requirements. `package verify` checks
the inventory and hashes. Rendering checks the backend requirements on the
receiving machine. Package only assets and fonts you can redistribute.
Caches, native models, system frameworks and third-party Node packages
are not copied. Choose a compatible OpenCut build and FFmpeg
installation. VideoToolbox recipes still require supported Apple Silicon
hardware and macOS; Apple does not expose a separate model version, so
results can vary with the OS. OpenCut requires the recorded backend
version and does not substitute another algorithm.

Packaging needs space for the listed payload once, plus small manifest
and filesystem overhead. Sources shared by clips are copied once per path;
the filesystem can use copy-on-write clones. Recipe cache and render
scratch usage are separate. Verification checks integrity, not authorship;
only run the archived TypeScript if you trust it.

## Batch rendering

```sh
opencut render examples/video/short-batch.video.ts --params examples/video/short-batch.params.json -o final.mp4
opencut batch examples/video/short-batch.video.ts --variants examples/video/short-batch.variants.json --output-dir ./outputs --concurrency 2 --json
# After correcting a failed tall variant in the manifest
opencut batch examples/video/short-batch.video.ts --variants examples/video/short-batch.variants.json --output-dir ./outputs --only tall
```

The variant file is a JSON array of entries with `id`, optional `params`,
and optional `output`. Each output is a flat MP4 basename in the output
directory and defaults to `<id>.mp4`. Use letters, digits, hyphens, and
underscores for IDs and basenames, starting with a letter or digit. The
batch creates its output directory, rejects duplicate names
case-insensitively before compiling, and publishes each verified file
atomically to a new path. Use `--only id,id` to retry selected IDs after
fixing the manifest. Use a fresh directory to rebuild successful IDs.

Each variant validates its own parameters. The default is to continue when a
variant fails. `--fail-fast` cancels outstanding work after the first
failure. SIGINT or SIGTERM stops active and queued jobs. Completed files
remain available. With `--json`, stdout contains `{ ok, variants }` in
manifest order. Each variant result has `id`, `output`, `elapsedSeconds`, and
`status`. A `completed` result contains `render`. A `failed` result contains
`phase` and `error` with a code and message. A `cancelled` result contains
`reason`. A batch with failed or cancelled variants exits nonzero.

Stderr includes one JSON object per progress event with
`event: "batch-progress"`, the variant `id` and `output`, and a `status`
of `compiling`, `recipe`, `rendering`, `render`, or `finished`. The
`recipe` and `render` events carry `progress`, and `finished` carries the
final variant `result`. Filter these events by their `event` field when
reading stderr, which also carries diagnostics and authoring logs.

Batch runs directly on macOS or Linux. `--concurrency` accepts 1–8 and defaults
to 1. The host caps active slots using the same worker ceiling as recipe work.
Each slot owns at most one recipe step at a time. An AI step can run one
inference worker with a decoder and an encoder. A transformed render layer
can run a decoder and an encoder together. Shared source probes and the
recipe cache reuse work across slots. Cache keys depend on the relevant
source, ordered step parameters, and backend. Changes to layout, title, or
captions alone leave matching recipe steps reusable.

`--temp-bytes` (default 8 GiB) and `--memory-bytes` (default host native budget) divide
the batch budgets evenly across active slots. Recipe overrides may lower a
slot's limits. The temporary budget covers staging for recipes and renders,
including copied sources, layer intermediates, and the unfinished MP4.
Published outputs and completed cache entries consume persistent disk space.
OpenCut samples native child-process RSS with `/bin/ps` and caps FFmpeg
allocation sizes. If the host blocks or cannot run `/bin/ps`, the active
render or recipe stops and reports a sampling error. TypeScript authoring
runs with a capped V8 old-generation heap. These limits
have the granularity of process sampling, file limits, and heap accounting.
Canvas allocations, shared process memory, and VideoToolbox driver
allocations contribute to system memory outside the native RSS budget.

Each batch MP4 and each parameterized single render stores an `opencut_build`
format tag with resolved parameters, definition and composition SHA-256
digests, effective processing and render settings, and recipe cache keys.
The batch record also gives the variant ID and its resource limits. Read
the record from `build` in a single render's JSON result or from
`variants[].render.build` for completed batch variants. Keep secrets out of
parameters since the tag travels with the output.

```sh
ffprobe -v error -show_entries format_tags=opencut_build -of json ./outputs/wide.mp4
```

## Performance benchmarks

Build with the macOS 26+ SDK, then run the benchmark from the repository root
with Python 3.11+ and FFmpeg/ffprobe on PATH.

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
python3 scripts/t54/benchmark.py t54-local
```

Use a new label for each run. The harness saves its metrics and playable
outputs under `tests/fixtures/generated/<label>/`. It covers TypeScript
validation, a preview clip, early and late frame seeks, 1080p and UHD
composition with captions and audio, interpolation, super-resolution, a
combined workload with one and two requested workers, a two-worker run
with a 4 GiB recipe budget, and a 30-second
interpolation input. Set `--sustained-seconds` to change the duration.
Optionally pass `--action-fixture` with an existing redistributable 24 fps
SDR excerpt of at least two seconds under the generated fixtures directory
for visual review.

Cold runs use a new build and recipe cache. Warm runs repeat with that cache
and a fresh output file. macOS may retain models between runs. Wall time
includes TypeScript evaluation, probing and output verification. Peak RSS
samples the CLI and its descendants every 50 ms and excludes GPU driver
and system allocations. Inspect the recorded OS pressure and thermal state
before and after sustained runs. Frame metrics use matching dimensions and
exclude the caption area. Interpolation uses held-out frames, and the
temporal comparison scores differences between consecutive pictures against
the same differences in the reference. Review the MP4s for motion artifacts.
Check each case's `exitCode` in `benchmark.json`. The harness records diagnostics
for unsuccessful cases and runs the rest of the matrix.
