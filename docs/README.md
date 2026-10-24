# OpenCut

A lightweight desktop video editor for creators, with a GUI and a scriptable
headless core. **T02 adds media probing and PNG frame extraction.** The desktop
shows a React placeholder; the independent CLI supports help, version and media commands.
Editing, project files, playback, and rendering are not implemented yet.

## Quick start (macOS)

Run the commands below from the repository root.

Use Node **24.12+ within the 24.x line** and **pnpm 11.20.0** (pinned in
`packageManager`). Install these prerequisites manually if needed.

```sh
pnpm install
pnpm dev
```

The second command builds the workspace packages and opens the Electron window.
Electron downloads its development binary on first launch, requiring network access.
Quit the app and press Ctrl-C in the terminal to stop the dev server.
FFmpeg is optional and is not needed for either command.

The desktop follows the system light/dark appearance, including changes while
running. On macOS it uses a normal resizable window with native window buttons
and a hidden title bar. Drag the header, including the space above the logo,
to move the window.

To use the CLI independently:

```sh
pnpm build
pnpm cli --help
pnpm cli --version
# Direct executable entry point, without pnpm log output:
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js probe /path/to/video.mp4 --json
node apps/cli/dist/index.js extract-frame /path/to/video.mp4 --timestamp 0.5 --output /path/to/new-frame.png --json
```

To build only the headless packages and CLI, use `pnpm build:packages` followed
by `pnpm --filter @opencut/cli build` instead of the full workspace build.

Media commands require manually installed `ffprobe` on PATH; extraction also
requires `ffmpeg` with PNG support. Existing output files are refused. See
[CLI.md](CLI.md) for fields, timestamp behavior, limits and exit codes.

## Commands

| Command                                  | Purpose                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm install`                           | Install and link workspace dependencies                                              |
| `pnpm dev` / `pnpm dev:desktop`          | Build internal packages, run the desktop dev server, open Electron                   |
| `pnpm dev:cli --help`                    | Run the TypeScript CLI without launching Electron                                    |
| `pnpm cli --help` / `pnpm cli --version` | Run the built CLI (build first)                                                      |
| `pnpm build`                             | Build libraries, CLI and Electron main/preload/React assets in dependency order      |
| `pnpm typecheck`                         | Build library declarations and strictly check all source, scripts and tests          |
| `pnpm lint`                              | Run ESLint                                                                           |
| `pnpm format` / `pnpm format:check`      | Apply / check Prettier formatting                                                    |
| `pnpm test`                              | Build prerequisites and run headless unit + CLI/fixture-contract tests               |
| `pnpm test:desktop`                      | Build and check the desktop shell, sandbox, appearance switching and macOS reopening |
| `pnpm test:fixtures`                     | Run the optional native intact/truncated-media regression (FFmpeg + ffprobe)         |
| `pnpm test:media`                        | Build and test real media CLI against existing generated fixtures (FFmpeg + ffprobe) |
| `pnpm fixtures:generate`                 | Generate and validate five small synthetic media files (optional FFmpeg + ffprobe)   |
| `pnpm fixtures:validate`                 | Decode generated media and check metadata/readable video frame counts (ffprobe)      |

`build` emits development-ready production assets, not a signed `.app`, DMG,
or installer. `test:desktop` needs a graphical desktop session but no downloaded
Playwright browser; it also checks the typed core bridge and saves screenshots
under the ignored `test-results/` directory.

`pnpm test` runs the headless suite with Vitest and needs no native media tools.
`pnpm test:fixtures` runs the separate Node native regression with FFmpeg and
ffprobe, generating temporary media rather than depending on existing fixtures.
`pnpm test:media` requires all five existing generated fixtures and exercises the
built CLI, including delayed video with zero and nonzero input starts. It creates
and cleans only its own derived inputs and outputs under the generated directory.
`pnpm fixtures:validate` only needs ffprobe: it counts decoded video frames and
rejects decoder errors, even when a damaged file retains valid header metadata.
See the [fixture contract](../tests/fixtures/README.md) for prerequisites and safe
regeneration.

## Structure

```text
apps/
  desktop/             Electron main + sandboxed preload + React renderer
  cli/                 Standalone Node CLI
packages/
  core/                Headless application identity; future editing operations
  media/               Headless ffprobe inspection and FFmpeg PNG extraction
  shared/              Reserved home for genuinely shared utilities/types
skills/video-editor/   Product Agent Skill and its current CLI reference
tests/
  fixtures/            Expected metadata and fixture documentation
  integration/         Headless CLI/fixture-contract tests and opt-in native media tests
  desktop/             Optional real Electron smoke test
scripts/               Optional fixture tooling (TypeScript)
docs/                  Product, architecture and architectural decisions (adr/)
```

Read [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[AGENTS.md](../AGENTS.md), and the [fixture contract](../tests/fixtures/README.md).
The official [Agent Skill](../skills/video-editor/SKILL.md) describes only working
CLI capabilities. It is distinct from repository coding instructions.
