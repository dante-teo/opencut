# Install OpenCut

The first distribution target is Apple Silicon with macOS 15 or later. The CLI needs native Node.js 24.12 or later within the 24.x series. Rendering also needs FFmpeg and ffprobe on PATH. Use a build with libx264 and AAC for default MP4 exports and libx265 for HEVC exports.

## pnpm

Install the CLI from the npm registry or run it on demand. If pnpm's global
bin directory is missing from `PATH`, run `pnpm setup` and open a new shell
before using `pnpm add -g`.

```sh
pnpm add -g @dantea/opencut
opencut doctor --json
pnpm dlx @dantea/opencut --help
```

You can also install the packed archive directly.

```sh
pnpm add -g ./opencut-cli-0.2.0-macos-arm64.tgz
```

Run the CLI from any directory. A definition can import `@opencut/sdk` and
use relative imports such as `./scenes.ts`. OpenCut uses its bundled SDK when
the project has no local `@opencut/sdk`. If a local SDK fails to load, OpenCut
reports the import error. Repair or reinstall the project's SDK. Third-party
imports resolve from the definition's project as usual.

For editor type checking or SDK use from a separate Node program, install
locally with `pnpm add @dantea/opencut` and import from `@dantea/opencut/sdk`.
Use ESM and TypeScript syntax supported by Node's type stripping.

The package includes the official [Agent Skill](../skills/video-editor/SKILL.md),
its references, the CLI and SDK guides, and the authoring examples. In a
local Node project, find the Skill at
`node_modules/@dantea/opencut/skills/video-editor/SKILL.md`.
Copy the bundled [opening card](../examples/video/opening-card.video.ts)
into your project before running it. Node's TypeScript loader excludes
definitions under `node_modules`.

```sh
opencut preview frame my-video.video.ts --frame 0 -o preview.png
opencut render my-video.video.ts -o final.mp4
```

Use `pnpm remove -g @dantea/opencut` to uninstall and rerun the install command to upgrade. The CLI executes trusted local TypeScript.

## Homebrew

Once the release and dedicated tap are available, Homebrew supplies Node and FFmpeg.

```sh
brew install dante-teo/tap/opencut
brew upgrade dante-teo/tap/opencut
brew uninstall dante-teo/tap/opencut
```

Find the Skill at
`$(brew --prefix opencut)/libexec/skills/video-editor/SKILL.md`.
Definitions use the SDK bundled with the formula. For SDK calls from a
separate Node program, use the local Node package installation above.

## OpenCut Review for macOS

Download the signed `OpenCut-Review-<version>-macos-arm64.zip` from the [GitHub release](https://github.com/dante-teo/opencut/releases). Compare its SHA-256 with the entry in `SHA256SUMS`, unzip it and move **OpenCut Review.app** to Applications. The app includes Electron and the SDK. Install FFmpeg separately for rendered previews and export. The packaged app can also find FFmpeg and ffprobe in the standard Apple Silicon Homebrew bin directory when opened from Finder.

## Optional AI

`opencut doctor --json` reports native worker versions, hardware, VideoToolbox configurations and model status for sample input sizes. Apple manages those models with macOS. Offline interpolation needs macOS 15.4 or later. Low-latency interpolation, super-resolution and denoising require macOS 26 or later. Hardware, input format, dimensions and model readiness also affect support. Selecting an unavailable recipe fails with a diagnostic.

For dialogue separation, install ELUATE 0.0.3 in a Python 3.10–3.12 virtual environment using its [upstream installation instructions](https://pypi.org/project/eluate/0.0.3/). Set `OPENCUT_DIALOGUE_PYTHON` to that environment's Python executable. Model installation explicitly downloads the multilingual Bandit v2 checkpoint (about 447 MB), verifies SHA-256 and then makes it available to ELUATE. The [checkpoint from the authors](https://zenodo.org/records/12701995) is licensed CC BY-SA 4.0. The commands use ELUATE's shared multilingual checkpoint path, so removal also affects other ELUATE installations that use that file.

```sh
opencut models install bandit-v2
opencut models inspect --json
opencut models remove bandit-v2
```

The Python runtime, model and user caches are managed separately from npm or Homebrew upgrades and uninstallations.

## Release builds

Build on Apple Silicon with the Node and pnpm versions pinned in the
repository and Xcode with the macOS 26 SDK. Only the build machine needs
Xcode. The release workflow selects Xcode 26.6, uses the frozen pnpm lockfile
and checks that the tag matches the workspace version.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm release:pack all
(cd dist/release && shasum -a 256 -c SHA256SUMS)
```

Use a fresh output directory for a local rebuild, for example
`pnpm release:pack all dist/release-check`. The `cli` target builds the CLI
archive and Formula, and `desktop` builds the local review ZIP. Each target
writes its own `SHA256SUMS`.

The staging tool bundles the SDK, core, media runtime, native addons, Noto
fonts, VideoToolbox workers and the macOS RSS helper. It checks the Mach-O architecture,
deployment target, library paths and executable versions. It omits Electron
from the npm archive. The CLI archive uses sorted paths and fixed timestamps.
Both distributions retain their dependencies' license notices and package
manifests. See the [libvips build source](https://github.com/lovell/sharp-libvips/tree/v1.3.4)
and [component versions](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4)
for the shared library bundled with sharp.
The local app ZIP is for smoke testing. Developer ID signing and notarization
add Apple-issued timestamps and a stapled ticket to the distribution app.

Before cutting a release, synchronize the version in the root and workspace
package manifests. Run the manually dispatched [release workflow](https://github.com/dante-teo/opencut/actions/workflows/release.yml)
on the matching `vMAJOR.MINOR.PATCH` tag with `publish` off to generate
test artifacts. The workflow tests the CLI with pnpm, a temporary Homebrew
tap and an unpacked review app. The pnpm smoke test installs the tarball
offline, then serves the same archive from a local test registry to exercise
global install, `pnpm dlx`, local SDK import and uninstall. A Homebrew
upgrade test uses the same archive under a simulated older keg version for
the first release.
The two CLI installation checks render the bundled opening card and run the
installed-runtime workflow suite with Python 3.11+, FFmpeg and ffprobe.
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

To keep results from a local pnpm or Homebrew installation check, set
`OPENCUT_RELEASE_EVALUATION_DIR` to the absolute path of a new directory
outside the checkout before running the check.

The evaluation records input and output hashes, exact decoded cadence,
command timings, sampled process RSS and workspace/cache usage in
`evaluation.json`. The raw doctor and render results identify the host,
worker versions, profiles and cache keys. Sampled process RSS measures
the CLI and observed descendants. Check system memory pressure separately
for allocations outside those processes. When both UHD outputs are present,
compare the decoded AI and Lanczos results.

For authorized publication, configure protected `release-signing` and
`release-publish` environments with required reviewers and tag restrictions.
Store `MACOS_DEVELOPER_ID_P12_BASE64`, `MACOS_DEVELOPER_ID_P12_PASSWORD`,
`MACOS_NOTARY_KEY_BASE64`, `MACOS_NOTARY_KEY_ID` and `MACOS_NOTARY_ISSUER`
in `release-signing`. Enable immutable GitHub Releases. The publish option
signs and notarizes the app, tests the signed app and uploads the validated
artifacts to a new release. It fails when a release for the tag already exists.

Publish the verified npm tarball separately from an account authorized for the
`@dantea` scope. Use a narrowly scoped publish credential. Once the release
URL resolves, add the generated `opencut.rb` to `Formula/opencut.rb` in
`dante-teo/homebrew-tap` and verify with `brew install dante-teo/tap/opencut`.
Use a new version to replace published artifacts.
