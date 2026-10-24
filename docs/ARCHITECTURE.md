# Architecture

## Workspace boundaries

| Package            | Owns                                                            | Actual dependencies   |
| ------------------ | --------------------------------------------------------------- | --------------------- |
| `@opencut/desktop` | Electron lifecycle, restricted IPC, React shell                 | core, Electron, React |
| `@opencut/cli`     | Argument parsing, stdout/stderr and exit codes                  | core, Node built-ins  |
| `@opencut/core`    | Headless application identity in T01; future editing behavior   | none                  |
| `@opencut/media`   | Reserved location for validated media backend contracts         | none                  |
| `@opencut/shared`  | Reserved location for utilities/types used by multiple packages | none                  |

Actual runtime dependency direction is `desktop → core ← cli`. The rationale is
recorded in [ADR 0001](adr/0001-shared-headless-core.md). Core never
imports Electron, React, CLI or desktop code. Media and shared deliberately
export nothing: add APIs and dependencies only when a real task needs them.
The root uses core as a development dependency to test built workspace imports.
All workspace dependencies use `workspace:*`; package exports point to built
JavaScript and declarations rather than TypeScript path aliases.

## Shared headless core

`getApplicationInfo()` provides a small, usable integration proof. CLI imports it
directly. Desktop main imports it and answers the renderer's narrow read-only IPC
request. React holds only view state for that response; it owns no editing state.
Future GUI actions, CLI commands and scripts must execute the same core editing
operations. T01 invents no project model, command bus or serialization format.
The application version is currently returned by core and kept aligned with the
workspace manifests; release/version automation is deferred.

The future editing model describes intent and validates operations. A media
engine performs probing, decoding, playback and encoding. Neither is implemented.
The process/thread that hosts a future engine, its API and how core coordinates
with it remain open decisions. FFmpeg versus MLT (or a combination) requires
technical evaluation. Using FFmpeg to generate test input does not select it as
the application backend.

## Desktop shell

The desktop follows the system light/dark appearance, including live changes,
through Electron nativeTheme and CSS prefers-color-scheme. On macOS the native
title bar is hidden; the full header (including its padding and text) is draggable,
while the standard window controls and normal resizable window behavior remain.

## Desktop trust boundary

Electron main owns native privileges. React runs with `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, web security enabled and webviews
disabled. A bundled **CommonJS preload** exposes one typed capability:
`window.opencut.getApplicationInfo()`. ESM is used elsewhere. CommonJS here keeps
Electron's renderer sandbox enabled; sandboxed preloads cannot use native ESM.
No raw IPC, arbitrary channel, filesystem or shell API reaches React.

Main validates the sending WebContents, main frame and exact URL for the one IPC
handler. Navigation, new windows, webviews and permission requests are denied.
Production assets use the secure `opencut://app` custom protocol with a path
containment check. The production CSP allows only local scripts/styles and no
network connections. Development listens only at `127.0.0.1:5173`; its CSP permits
the Vite websocket and inline styles for CSS reloads. JSX is compiled by Vite;
no extra React refresh framework is needed for the placeholder.

These choices follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
and [sandboxed preload constraints](https://www.electronjs.org/docs/latest/tutorial/sandbox).
They secure this local shell; future file import/export and IPC need their own
validated capabilities and tests.

## Tooling and build

Node 24 and pinned pnpm 11, TypeScript 6, ESM, pnpm recursive dependency ordering,
electron-vite/Vite for Electron and React, tsc for headless packages/CLI, Vitest
for headless tests, Playwright for the separate real Electron smoke test, the Node
test runner for optional native fixture regressions, ESLint and Prettier. TypeScript stays on the compiler major supported by typescript-eslint;
newer tool majors are not required for T01. The lockfile fixes transitive versions.
Only Electron and esbuild dependency build scripts are explicitly allowed.
There is no root postinstall, fixture generation hook, native media dependency,
Turborepo, command framework or runtime service.

Build packages before importing their exports. Root dev/test/typecheck commands
do this automatically. The dev command rebuilds package declarations once;
restart it after changes to a headless package. The production build produces
assets under each package/app's `dist/`; distribution packaging is deferred.

## Fixture validation boundary

Ordinary tests run without FFmpeg, ffprobe or an Electron window. The native
fixture regression is a separate opt-in suite that creates synthetic media in
an OS temporary directory and cleans it up. It does not use or change the
working fixture set.

Fixture validation decodes media with ffprobe and checks `nb_read_frames` against
the expected video frame count. Container headers alone are insufficient: an MP4
can retain its declared duration and frame count after its media data is truncated.
Missing readable-frame counts and error-level decoder diagnostics fail validation,
including diagnostics from tools that exit successfully. The expected metadata,
tolerances and regeneration rules live in the [fixture contract](../tests/fixtures/README.md).
These optional development tools do not select or implement the application media backend.

## Open decisions for subsequent tasks

- Validate FFmpeg/MLT capabilities, licensing, distribution and process isolation.
- Define time representation, project/command model, persistence and undo semantics.
- Specify versioned structured CLI/JSON output and a real scripting contract when
  editing behavior exists; stdout is reserved for results, stderr for errors.
- Define media access, IPC authorization and rendering/playback ownership.
- Choose distribution tooling and signing, then validate other operating systems.

These are decisions to investigate, not APIs promised or implemented by T01.
