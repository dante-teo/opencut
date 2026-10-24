# ADR 0001: Share a headless core between desktop and CLI

Status: Accepted

Date: 2026-10-24

## Context

OpenCut must support desktop editing and independent scripting with the same
editing behavior. Making the renderer the owner of editing state would tie
scripts to Electron. Separate GUI and CLI implementations would risk different
results for the same operation.

## Decision

Keep editing rules and operations in `@opencut/core` as they are implemented.
Core must remain independent of Electron, React and the CLI.

The CLI imports core directly. Electron main calls core and exposes only explicit,
typed capabilities to the renderer through the sandboxed preload. React owns
presentation state rather than editing business logic.

Keep media implementation separate from the editing model. The media package
remains empty until FFmpeg/MLT evaluation establishes the required contracts.
Using FFmpeg for development fixtures does not select an application backend.

## Consequences

- Core behavior can be tested in Node without a desktop session or native media tools.
- GUI and CLI adapters translate inputs and present results while sharing editing rules.
- New renderer capabilities require narrow IPC methods and sender validation.
- Backend selection, project/time models, persistence and editing APIs remain open.

At T01, the shared integration is application identity only. No editing model,
commands or media engine are implemented. See [the architecture overview](../ARCHITECTURE.md)
for current package boundaries.

T02 follow-up: [ADR 0002](0002-external-ffmpeg-media-tools.md) replaces the empty
media placeholder with external ffprobe inspection and FFmpeg frame extraction.
Shared core ownership of editing behavior and the desktop trust boundary remain
in effect.

T05 follow-up: [ADR 0004](0004-versioned-project-model.md) establishes the project
format, rational time model and persistence boundary in core. Editing commands,
undo/redo and desktop/CLI project integration remain deferred. The original
shared-core ownership and renderer trust boundary continue to apply.

T06/T07 follow-up: project create/info/validate and media import/list/info/remove
now invoke shared core APIs from the standalone CLI. The optional core Node
adapter coordinates probing through the headless media package; the main model
API remains independent of media tools. Timeline editing and desktop project
integration remain deferred. See [the current core architecture](../ARCHITECTURE.md)
and [the project format decision](0004-versioned-project-model.md).

T08 follow-up: [ADR 0005](0005-explicit-timeline-editing.md) defines the first
shared timeline editing operations and their CLI adapter. Core remains independent
of Electron and media-tool access; GUI timeline integration remains deferred.
