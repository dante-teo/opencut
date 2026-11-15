# Headless capability matrix

This matrix describes the current public interfaces. `edit apply` accepts the
operation types and fields in `opencut help edit apply --json`; the SDK accepts
the same operations through `project.apply`. Both use the core validation and
history model. Inspect the project revision before editing. Whole-video
definitions support validation, inspection, frame previews, contact sheets,
short clips, watch mode and final renders. The SDK exposes `defineVideo()`,
`compileVideo()`, `previewVideo()` and `watchVideo()`. See
[Video as code](VIDEO_DEFINITIONS.md). Electron follows source definitions
and saved project revisions, and exports saved projects.

| Capability                                                              | CLI                                                           | TypeScript SDK                                                                                          | Notes                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Project and timeline inspection                                         | `project inspect`, `timeline list`, `timeline inspect`        | `project.inspect()`, `project.inspectTimeline()`                                                        | JSON CLI output; SDK returns structured data.                                                            |
| Tracks, clips, groups, links, markers, ripple, replace and detach audio | `edit apply`; common operations also have individual commands | `project.apply(...)`                                                                                    | Batch edits are atomic project edits.                                                                    |
| Speed, transforms, crop and animation                                   | `edit apply`; `clip speed`, `clip visual`                     | `project.apply(...)`                                                                                    | Keyframe times are clip-local rational seconds.                                                          |
| Color grading and curves                                                | `edit apply` (`clip.grade`)                                   | `project.apply(...)`                                                                                    | Grade applies to the specified clip IDs.                                                                 |
| Audio levels, fades, gain keys and effects                              | `edit apply`; `clip audio`, `track audio`                     | `project.apply(...)`                                                                                    | `clip.gain-keys` and `clip.effects` use the shared schemas.                                              |
| Transitions and visual fades                                            | `edit apply`; `transition add/set/remove`                     | `project.apply(...)`                                                                                    | Transition constraints are validated by core.                                                            |
| Text, subtitles, word timing and subtitle effects                       | `edit apply`; `subtitle import/export/list`                   | `project.apply(...)`, `project.importSubtitles()`, `project.exportSubtitles()`                          | SRT and WebVTT sidecars do not preserve all project styling.                                             |
| Local media import, removal and relink                                  | `media import/remove/relink`                                  | `project.importMedia()`, `project.removeMedia()`, `project.relinkMedia()`                               | Originals remain external to the project.                                                                |
| Embedded fonts                                                          | `media import-font`                                           | `project.importFont()`                                                                                  | Applies to a title or subtitle cue.                                                                      |
| Freeze frame                                                            | `project freeze`                                              | `project.freezeFrame()`                                                                                 | Creates an external PNG as well as an edit. SDK stages the edit for save.                                |
| Dialogue separation                                                     | `media separate-dialogue`, then `media import` for each stem  | `project.separateDialogue()`, then `project.importMedia()` for each stem                                | Requires FFmpeg, ffprobe and a separately installed ELUATE model. Import each generated stem separately. |
| Online media                                                            | `online search`, `online import`                              | `project.searchOnlineMedia()`, `project.importOnlineMedia()`                                            | Direct provider search and provenance-preserving import; network required.                               |
| Preview and export                                                      | `preview`, `project render`, `project cache-preview`          | `project.previewFrame()`, `project.previewContactSheet()`, `project.render()`, `project.cachePreview()` | Media tools and source files are required.                                                               |
| Undo and redo                                                           | `edit undo/redo/history`                                      | `project.undo()`, `project.redo()`, `project.history()`, then save                                      | Undo and redo advance the revision.                                                                      |

For hardware and VideoToolbox capabilities, use the
[CLI system diagnostics](CLI.md#system-diagnostics). This command runs without
a project and is available through the CLI.

## Contract limitations

- Discovery checks FFmpeg and ffprobe availability at runtime. Network access,
  fonts and the installed dialogue model are checked when used.
- Revision checks prevent a stale batch from being applied twice, but there is
  no persisted operation ID for safely recognizing an already committed retry.
  Inspect the project and history after an uncertain result before retrying.
- External outputs are not part of project history. A successful SDK freeze
  preparation writes its PNG before `save()`, so a failed or abandoned save can
  leave that artifact behind. Online imports also download before publication;
  an uncertain CLI commit retains its download for recovery. Reimporting an
  offline online result creates a new asset rather than relinking existing clips.
  Dialogue output and imports are separate actions.
- Errors have machine-readable CLI envelopes, but some unrelated failures share
  generic codes rather than the full requested error taxonomy.
