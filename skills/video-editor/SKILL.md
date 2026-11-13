---
name: video-editor
description: Edit local videos with OpenCut using its CLI or TypeScript SDK. Use when a user wants to assemble a rough cut, trim, split or retime footage, animate clip transforms, add editable text or subtitles, layer images or music, mix and fade audio, inspect an edited timeline, or export and verify a playable MP4 from media files or an OpenCut project.
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
   Keep those files in place and leave their contents unchanged. Desktop
   **Browse online** imports from Wikimedia Commons and Openverse into local
   application storage. Preserve those files and the asset provenance when
   using the CLI or SDK to edit the resulting project.
3. **Plan and apply.** Use stable IDs from inspection and integer project-frame
   indices, including source in/out. The out point is exclusive. Dry-run a
   revision-guarded CLI batch or stage edits with the SDK and dry-run its save.
   Add editable titles with `text.add` and change them with `text.set`. Use
   `subtitle import` for SRT or WebVTT, `subtitle list` for cue IDs, and
   `subtitle.*` batch operations with exact rational seconds for cue edits.
   Set constant clip speed with `clip speed PROJECT CLIP_ID --speed 3/2` or
   the `clip.speed` operation. Speeds range from 0.25× to 4×. Recheck the
   new clip end and neighboring clips before applying. Use `clip trim --in-time`
   or `--out-time` for exact source seconds, including at default speed.
   Animate position, scale, rotation or opacity with `clip.keyframe.add`,
   `clip.keyframe.set` and `clip.keyframe.remove`. Use exact clip-local seconds.
   Verify sampled transforms around keys, trims and splits with `timeline inspect`
   and inspect decoded preview frames.
   Use `media relink` to restore an offline source and `media import-font`
   to embed a font in a title or cue. `project freeze` inserts a held frame.
   Discover replacement, transitions, color, audio automation, ordered
   effects and subtitle styling through `help edit apply --json`.
   Use `subtitle.words` for cue-relative word timing. Check timed highlights
   in rendered frames and use SRT or WebVTT for cue-level text and timing.
   Set fades with `clip audio --fade-in/--fade-out` in project frames. Use
   `track audio` for a track's volume and mute. Clip and track linear gains
   multiply. Re-read the project after publication. On a revision conflict, inspect the
   newer edits and rebuild the plan against them.
4. **Review what the viewer will see.** Use `timeline inspect` to confirm active
   layers and source mappings. Open the rendered PNGs or contact sheet at cuts
   and overlay boundaries. Use a short preview clip to review motion and sound
   when playback is available. Use `project cache-preview` for a full-timeline
   review with VFR sources sampled on the project frame grid. Check text
   wrapping, alignment, legibility and glyph coverage in the rendered frame.
   Match the reviewed revision to the export.
5. **Export and verify.** Choose a new MP4 path in an existing directory.
   For CLI rendering, require exit 0 and a terminal `completed` JSONL event.
   Probe the published file for the expected streams, dimensions and duration.
   Play it or decode it through the end. Report the editable project and output
   paths, and distinguish what you saw or heard from automated checks. For
   subtitles, verify the sidecar text and timing or inspect visible cues in
   decoded video frames, according to the requested deliverable.
   Use `project snapshot` to save a separate revision or `project package`
   to gather its referenced files into a portable folder.

## Read as needed

- [CLI](references/cli.md) for discovery, batch fields, visual review, export,
  and error recovery.
- [TypeScript SDK and script runner](references/sdk.md) for staging, saving,
  and writing reusable creator scripts.
- [Creator workflows](references/workflow.md) for a worked rough cut with
  music and an image overlay, vertical photo stories, and screen recordings.
