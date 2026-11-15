# ADR 0017: Gate local video effects by measured capability

Status: Accepted. Headless recipes expose low-latency interpolation, opt-in super-resolution, and temporal denoising on supported hardware.

## Decision

| Capability          | Primary candidate                                                                                                                                                                                                   | Fallback                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frame interpolation | VideoToolbox low-latency interpolation (macOS 26+), as an offline job. Probe the source size and pixel format, then verify the session. Bypass the model across cuts.                                               | Return an actionable error for unsupported AI requests. The separate frameRate recipe offers conventional conversion. The tested offline Normal configuration scored below frame duplication. RIFE remains a future candidate. |
| Enhancement         | Keep conventional resize available. Expose opt-in VideoToolbox low-latency super-resolution and revision 1 of the temporal 4× model. Reduce the native model output to the exact requested dimensions with Lanczos. | Return an actionable error for unsupported AI configurations. Use a separate Lanczos resize as the reference for detail and temporal consistency.                                                                              |
| Denoising           | Expose the VideoToolbox temporal noise filter when the hardware, dimensions and reference-window budget support it. Reset references at detected cuts.                                                              | Return an actionable error when unavailable. The conventional `hqdn3d` baseline remains a benchmark.                                                                                                                           |

Probe each feature independently. `VTFrameProcessor` and offline frame-rate
conversion first appeared on macOS 15.4; the tested low-latency effects, offline
video SR, and temporal noise filter require macOS 26. Inspect the actual
configuration, input and output formats, model readiness and session result.
Do not bundle or automatically fetch third-party weights. The headless AI
recipes open a VideoToolbox session for the actual source and fail before
publishing an artifact if inference cannot run. The high
super-resolution recipe uses the 4× model with prior-frame references. It
rotates portrait sources for the model and restores the original orientation
before encoding. The new recipes and capability limits are documented in
[Video definitions](../VIDEO_DEFINITIONS.md#ai-enhancement). Apple's
[algorithm overview](https://developer.apple.com/videos/play/wwdc2025/300/) and
[configuration guidance](https://developer.apple.com/forums/thread/821701)
describe the runtime checks.

## Evidence and reproduction

The tested host was a 10-core CPU / 24-core GPU M1 Max, 32 GB, macOS 27.0.1
(native arm64). **MacBook Air M4, 16 GB: untested.** The results also do not test
the minimum macOS versions. Hardware-only H.264, HEVC, ProRes 422 and ProRes
4444 encode sessions prepared successfully at 1920×1080; VideoToolbox also
reported hardware decode for those codecs. It did not report AV1 or VP9 decode,
and the hardware-only encoder attempts failed for those codecs. Restricted
processes can expose fewer capabilities than an unrestricted terminal.

Run from the repository root with the existing workspace dependencies, Python
3.11+, FFmpeg/ffprobe (with FFV1 and libx264), and a macOS 26+ SDK:

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
node apps/cli/dist/index.js system inspect --json
python3 scripts/t42/benchmark.py t42-local
python3 scripts/t42/benchmark.py t42-native-uhd --native-follow-up
```

Set `SDKROOT` to an installed newer SDK when the default SDK is too old.
To repeat the optional Real-ESRGAN comparison, pass
`--upscayl-resources /Applications/Upscayl.app/Contents/Resources` on the main
run. The benchmark uses an existing installation and fingerprints the runtime
and weights. It installs no tools or models. The output label must be new; the
benchmark writes only beneath `tests/fixtures/generated/`. The default 60-second
portrait test needs about 16 GiB of temporary disk for uncompressed frames. Use
`--sustained-seconds 0` to omit that case.

The M1 Max rerun recorded 25 completed cases and six unsupported configurations
in the main matrix, plus three completed UHD and rotation cases.
[Main baseline](../../tests/baselines/t42-m1-max.json) ·
[UHD and rotation baseline](../../tests/baselines/t42-m1-max-native-follow-up.json)

Each run writes `benchmark.json` and playable MP4s to
`tests/fixtures/generated/<label>/`. A completed row with a `sample` field gives
the MP4 filename in that directory. Original inputs and clean references are
saved where applicable. A row with `sceneCutInputFrame` records the zero-based
index of the first input frame in the next shot. Unsupported configurations
appear as failed cases with process diagnostics so the remaining cases can run.

The UHD clips are four frames at 4 fps; use them as a sizing and artifact check,
not a representative video-throughput workload. PSNR and SSIM use lossless
intermediates where available. Interpolation scores withheld odd frames and
excludes the known cut and final frame. Native wall times include cold or warm
session startup and raw staging, but exclude FFmpeg decode and presentation
encode; those are timed separately. Upscayl timing includes model load, inference
and PNG I/O in one process. Peak RSS and peak footprint come from macOS
`time -l`. Neither measures total unified memory used by the OS, driver, other
processes or Electron in a real editing session.

| Test                                         | Measured result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1080p 24 → 48 and 30 → 60, both orientations | Low-latency Apple: 10.4–10.8 synthesized frames/s, 4.9–6.1 s processing per 2 s clip, 275–282 MiB peak footprint, 33.4–33.7 dB versus 26.1–26.8 dB for duplication. All eligible midpoints differed from both neighbors. Offline Apple: 22.7–22.8 dB using the prototype's RGBA-half path.                                                                                                                                                                                                                                                                                                                              |
| 1080×1920, 60 s at 30 fps                    | Apple low-latency: 1,799 synthesized frames, 3,600 output frames, 179.8 s processing and 282 MiB peak footprint. First 30 calls averaged 94.2 ms and the remaining calls averaged 92.6 ms. The reported end thermal state was nominal. This is one M1 Max run without a concurrent editor workload.                                                                                                                                                                                                                                                                                                                     |
| 720p → 1080p, both orientations              | Apple low-latency: 0.58 s in each orientation for 48 frames, 219–225 MiB peak footprint. 34.4/34.0 dB versus 35.6/35.7 dB for Lanczos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 720p → UHD, both orientations                | Apple low-latency rejected 3×. Offline Apple exposed 4× and rejected native portrait; rotating portrait before inference and rotating back after resizing produced 2160×3840, square pixels. Apple 4× processing took 2.12–2.87 s for four frames and peaked near 2.73 GiB footprint. The Apple pipeline scored 29.7–29.9 dB versus Lanczos at 33.1–33.4 dB, and Upscayl at 29.0–29.3 dB. Upscayl took 46.35–46.43 s and 1.53–1.54 GiB per four frames. The Apple model was initially listed as download-required in a preliminary diagnostic; the measured runs found it ready. The harness never requests a download. |
| 1080p denoise, both orientations             | Apple temporal noise filter returned unsupported. `hqdn3d` processed 48 compressed noisy frames in 0.36 s including decode and lossless write, at 187–191 MiB peak footprint. PSNR improved from 29.5 to 40.0 dB wide and from 31.1 to 39.8 dB portrait.                                                                                                                                                                                                                                                                                                                                                                |

A video stored landscape with a 90° display matrix decoded to the intended
1080×1920 and produced the same held-out SSIM as pixel-oriented portrait.

The two-shot fixtures use a known cut. At frame 24, offline super-resolution
drops its previous source and output references and uses random submission
mode to clear the VideoToolbox cache. The landscape case processed all 48 frames
at native 4× in 20.5 seconds, with a 2.73 GiB peak process footprint. The
conventional FFmpeg denoise baseline ran across the cut.

In selected stills, low-latency interpolation kept moving text legible;
offline conversion softened moving details. The 4× neural UHD variants smoothed
diagonal texture. Upscayl sharpened text but changed some digit strokes. The
conventional denoise output removed visible grain while preserving edges in the
inspected crop. This synthetic material cannot validate faces, fast occlusions,
film grain, difficult compression, color fidelity, flicker across whole shots,
or variable frame rates. The headless interpolation recipes are documented in [Video definitions](../VIDEO_DEFINITIONS.md#ai-interpolation). Sustained performance with Electron active on the fanless M4 Air remains unmeasured.

## Distribution constraints

Apple features depend on the system framework and Apple-managed models; do not
redistribute those model assets. [RIFE](https://github.com/hzwer/ECCV2022-RIFE/blob/main/LICENSE)
and [rife-ncnn-vulkan](https://github.com/nihui/rife-ncnn-vulkan/blob/master/LICENSE)
publish MIT code; a standalone RIFE build and exact checkpoint were not run or
cleared for distribution. [rife-metal](https://github.com/cinemore/rife-metal)
is also a candidate for separate evaluation, not a verified fallback.
[Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE) uses
BSD-3-Clause for its repository, [ncnn](https://github.com/Tencent/ncnn/blob/master/LICENSE.txt)
uses BSD-3-Clause with dependency notices, and
[MoltenVK](https://github.com/KhronosGroup/MoltenVK/blob/main/LICENSE) uses
Apache-2.0. The measured Upscayl 2.15.0 executable is an external local
[AGPL-3.0 backend](https://github.com/upscayl/upscayl-ncnn). The exact installed
model binaries were used as local evaluation inputs; model identifiers and
hashes do not establish their redistribution terms. No third-party executable
or weight is included in OpenCut. Before adopting RIFE or Real-ESRGAN, pin and
confirm commercial use and redistribution terms for the exact weight artifacts,
runtime build, and dependencies, including required notices or source offers.
FFmpeg remains external; its [distribution terms](https://ffmpeg.org/legal.html)
depend on build options, including whether libx264 is enabled.
