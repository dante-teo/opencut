# Install OpenCut

## Homebrew

OpenCut runs on Apple Silicon with macOS 15 or later. The Homebrew formula
installs Node.js 24 and FFmpeg as dependencies. The release bundles the
Rust media engine. Cargo is a build-time dependency.

```sh
brew install dante-teo/tap/opencut
opencut doctor --json --compact
```

Use `brew upgrade dante-teo/tap/opencut` to upgrade and
`brew uninstall dante-teo/tap/opencut` to uninstall. The
[doctor report](CLI.md#check-the-installation) describes hardware, media
tools, graphics, and optional AI models.

If you have an older OpenCut installation, run `type -a opencut` to see which
copy your shell runs first. You can call the Homebrew copy directly with
`"$(brew --prefix opencut)/bin/opencut"`.

Run the CLI from any directory. A trusted `.video.ts` definition can import
`@opencut/sdk` and use relative imports such as `./scenes.ts`. OpenCut
resolves `@opencut/sdk` to its bundled copy when the project has no local SDK.
Third-party imports resolve from the definition's project.

The installed guides, examples, and [Agent Skill](../skills/video-editor/SKILL.md)
are under `$(brew --prefix opencut)/libexec`. To try the bundled example, run
these commands in your project directory.

```sh
cp -n "$(brew --prefix opencut)/libexec/examples/video/opening-card.video.ts" .
opencut preview frame opening-card.video.ts --frame 0 -o preview.png
opencut render opening-card.video.ts -o final.mp4
```

## Move from OpenCut Review

OpenCut Review, the Electron preview app, has been retired. To watch an
existing `.video.ts` project as you edit, run:

```sh
opencut preview edit.video.ts --watch
```

Open the MP4 path printed by OpenCut in your video player. For a preview
file you can keep or share, use [a clip preview](VIDEO_DEFINITIONS.md#inspect-preview-and-render).

## Use the bundled SDK from a Node project

For editor type checking or scripts run directly with Node, link the SDK
from the Homebrew install into your project. Import `@opencut/sdk` and use
Node.js 24.12 or later within the 24.x series. For standalone scripts that
render media, keep Homebrew's `ffmpeg` and `ffprobe` on `PATH`.

```sh
mkdir -p node_modules/@opencut
ln -s "$(brew --prefix opencut)/libexec/node_modules/@opencut/sdk" node_modules/@opencut/sdk
```

For type checking `@opencut/graphics` imports, link the bundled graphics
package from the same install.

```sh
ln -s "$(brew --prefix opencut)/libexec/node_modules/@opencut/graphics" node_modules/@opencut/graphics
```

See the [TypeScript SDK guide](SDK.md) for examples.

## Optional React graphics

OpenCut uses the pinned Chromium Headless Shell to render React graphics. Follow the [graphics browser setup](GRAPHICS.md#install-the-optional-react-browser)
on each machine that renders a React composition. Static SVG renders
without a browser.

## Optional AI

`opencut doctor --json` reports native worker versions, hardware, VideoToolbox configurations and model status for sample input sizes. Apple manages those models with macOS. Offline interpolation needs macOS 15.4 or later. Low-latency interpolation, super-resolution and denoising require macOS 26 or later. Hardware, input format, dimensions and model readiness also affect support. Selecting an unavailable recipe fails with a diagnostic.

For dialogue separation, install ELUATE 0.0.3 in a Python 3.10–3.12 virtual environment using its [upstream installation instructions](https://pypi.org/project/eluate/0.0.3/). Set `OPENCUT_DIALOGUE_PYTHON` to that environment's Python executable. Model installation explicitly downloads the multilingual Bandit v2 checkpoint (about 447 MB), verifies SHA-256 and then makes it available to ELUATE. The [checkpoint from the authors](https://zenodo.org/records/12701995) is licensed CC BY-SA 4.0. The commands use ELUATE's shared multilingual checkpoint path, so removal also affects other ELUATE installations that use that file.

```sh
opencut models install bandit-v2
opencut models inspect --json
opencut models remove bandit-v2
```

The Python runtime, model and user caches are managed separately from Homebrew upgrades and uninstallations.

For local transcription and corrected-text alignment, configure a Python
environment and Qwen model directories. Check `ai.transcription` in
`opencut doctor --json` for readiness.
[Local transcription setup](CLI.md#local-transcription-and-corrected-timing)

## Release builds

Build on Apple Silicon with the Node and pnpm versions pinned in the
repository, Rust and Cargo 1.85 or later, and Xcode with the macOS 26 SDK.
Only the build machine needs Rust, Cargo and Xcode. The release workflow
selects Xcode 26.6, uses the frozen pnpm lockfile and checks that the tag
matches the workspace version.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm release:pack
(cd dist/release && shasum -a 256 -c SHA256SUMS)
```

Use a fresh output directory for a local rebuild, for example
`pnpm release:pack cli dist/release-check`. The packer writes the CLI
archive, Homebrew formula, and `SHA256SUMS`.

The staging tool bundles the SDK, core, media runtime, native addons, Noto
fonts, the Rust media engine, VideoToolbox workers and the macOS RSS helper.
It checks the Rust protocol and the Mach-O architecture,
deployment target, library paths and executable versions. The CLI archive
uses sorted paths and fixed timestamps and retains its dependencies' license
notices and package manifests. Rust dependency licenses are under
`libexec/licenses/rust/` in the installed package. See the [libvips build source](https://github.com/lovell/sharp-libvips/tree/v1.3.4)
and [component versions](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4)
for the shared library bundled with sharp.

Before cutting a release, synchronize the version in the root and workspace
package manifests. Run the manually dispatched [release workflow](https://github.com/dante-teo/opencut/actions/workflows/release.yml)
on the matching `vMAJOR.MINOR.PATCH` tag with `publish` off to generate
test artifacts. The workflow checks installation, upgrade, and uninstall
in a temporary Homebrew tap, then renders the bundled opening card and runs
the installed-runtime suite with Python 3.11+, FFmpeg and ffprobe.
For an isolated local check, put the test Homebrew first on `PATH` and set
`OPENCUT_TEST_BREW_PREFIX` to its absolute prefix. The script checks that
prefix and its Cellar before installing. Supply a previous archive and
formula as arguments three and four to test an upgrade from that release.
For local release checks, set `PLAYWRIGHT_BROWSERS_PATH` to the cache
containing the pinned Headless Shell to include graphics package relocation.
Software rendering, Lanczos upscaling, and failure handling run on every host.
The recovery check uses a software recipe when offline interpolation is
unavailable. A passing run can include skipped AI cases. Check the
`skipped` entries in `evaluation.json` for the processor or model reason.
From the checkout, pass an installed executable and a new temporary project
directory outside the checkout to retain the results for local review.

```sh
work="$(mktemp -d)"
bash scripts/release/test-workflows.sh "$(command -v opencut)" "$work/project"
```

To keep results from a local Homebrew installation check, set
`OPENCUT_RELEASE_EVALUATION_DIR` to the absolute path of a new directory
outside the checkout before running the check.

The evaluation records input and output hashes, exact decoded cadence,
command timings, sampled process RSS and workspace/cache usage in
`evaluation.json`. The raw doctor and render results identify the host,
worker versions, profiles and cache keys. Sampled process RSS measures
the CLI and observed descendants. Check system memory pressure separately
for allocations outside those processes. When both UHD outputs are present,
compare the decoded AI and Lanczos results.

For authorized publication, configure the protected `release-publish`
environment with required reviewers and tag restrictions. Enable immutable
GitHub Releases. The publish option uploads the verified CLI archive,
formula, and checksums to a new release. Homebrew downloads the archive
from that release. The workflow fails when a release for the tag already
exists.

## Update the Homebrew tap

Once the GitHub release URL resolves, add the generated `opencut.rb` to
`Formula/opencut.rb` in `dante-teo/homebrew-tap`. Verify with
`brew install dante-teo/tap/opencut` or `brew upgrade dante-teo/tap/opencut`.
Use a new version to replace published artifacts.
