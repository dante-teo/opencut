# OpenCut architecture

The source of truth is a TypeScript or JSON [video definition](VIDEO_DEFINITIONS.md).
A compile reads the definition and probes the referenced media, validates the
result against the timeline model, and binds a render plan. The in-memory
snapshot is immutable. Preview and render verify the identity of each media
file they use and keep a private copy for the duration of the operation, so
one output uses a consistent set of source bytes.

- `@opencut/shared` holds platform-neutral time, color, compositing, transition,
  and animation primitives.
- `@opencut/core/video` is the Node entry for compiling, inspecting, previewing,
  watching, and rendering definitions. The timeline evaluator and
  render planner are shared by all these operations.
- `@opencut/media` runs FFmpeg and ffprobe, prepares generated layers, mixes
  audio, and publishes completed output. It also provides standalone media
  processing and the optional dialogue-separation backend.
- `@opencut/sdk` exposes the definition workflow. The CLI uses the same core
  functions; foreground rendering runs in the CLI process and starts only the
  subprocesses needed for that invocation.
- Electron opens local video or watches a definition. It previews the last
  valid revision and can export that revision to a destination chosen in the
  native save dialog. Its renderer remains isolated and sandboxed; it never
  receives a filesystem API.

A watch scopes its temporary media copies and rendered preview to a single
definition. It observes source, imported modules and referenced media. Failed
or superseded builds cannot publish over the last valid preview. Export pins
the selected revision's source copies for the duration of the render. The
watcher removes superseded copies after the last export using them finishes.
