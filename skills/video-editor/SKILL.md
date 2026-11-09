---
name: video-editor
description: Edit local videos with OpenCut using its CLI or TypeScript SDK. Use when a user wants to assemble a rough cut, trim or split footage, add editable text or subtitles, layer images or music, mix and fade audio, inspect an edited timeline, or export and verify a playable MP4 from media files or an OpenCut project.
---

# Edit videos with OpenCut

Use a built OpenCut CLI and Node.js 24.12+ within 24.x. Media import needs
ffprobe. Rendered previews and video export need FFmpeg and ffprobe on PATH.
Subtitle sidecar import and export work without those tools. Standalone SDK
scripts need the supplied `@opencut/sdk` package.

1. **Discover the interface.** Run `opencut help --json` and scope it with
   `opencut help GROUP ACTION --json`. Here `opencut` means the supplied
   executable or `node /absolute/path/to/the/built/dist/index.js`. Use the
   public CLI, the `@opencut/sdk` package root, and these references.
2. **Inspect before editing.** Read `project inspect PROJECT --json` for the
   revision, canvas, tracks, assets, clips and duration. Check `media list` for
   availability and `probe` for new footage. Create a project at a fresh path
   when starting from media alone. Import references to the original files.
   Keep those files in place and leave their contents unchanged.
3. **Plan and apply.** Use stable IDs from inspection and integer project-frame
   indices, including source in/out. The out point is exclusive. Dry-run a
   revision-guarded CLI batch or stage edits with the SDK and dry-run its save.
   Add editable titles with `text.add` and change them with `text.set`. Use
   `subtitle import` for SRT or WebVTT, `subtitle list` for cue IDs, and
   `subtitle.*` batch operations with exact rational seconds for cue edits.
   Set fades with `clip audio --fade-in/--fade-out` in project frames. Use
   `track audio` for a track's volume and mute. Clip and track linear gains
   multiply. Re-read the project after publication. On a revision conflict, inspect the
   newer edits and rebuild the plan against them.
4. **Review what the viewer will see.** Use `timeline inspect` to confirm active
   layers and source mappings. Open the rendered PNGs or contact sheet at cuts
   and overlay boundaries. Use a short preview clip to review motion and sound
   when playback is available. Check text wrapping, alignment, legibility and
   glyph coverage in the rendered frame. Match the reviewed revision to the export.
5. **Export and verify.** Choose a new MP4 path in an existing directory.
   For CLI rendering, require exit 0 and a terminal `completed` JSONL event.
   Probe the published file for the expected streams, dimensions and duration.
   Play it or decode it through the end. Report the editable project and output
   paths, and distinguish what you saw or heard from automated checks. For
   subtitles, verify the sidecar text and timing or inspect visible cues in
   decoded video frames, according to the requested deliverable.

## Read as needed

- [CLI](references/cli.md) for discovery, batch fields, visual review, export,
  and error recovery.
- [TypeScript SDK and script runner](references/sdk.md) for staging, saving,
  and writing reusable creator scripts.
- [Creator workflows](references/workflow.md) for a worked rough cut with
  music and an image overlay, vertical photo stories, and screen recordings.
