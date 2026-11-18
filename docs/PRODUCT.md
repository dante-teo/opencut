# OpenCut product scope

TypeScript video definitions describe a canvas, ordered tracks,
media, clip timing, effects, titles, subtitles, and transitions. The CLI and
TypeScript SDK compile them into the same render plan. Headless commands can
inspect exact frames, render previews and contact sheets, produce final MP4,
and export subtitle sidecars.

Electron provides local playback and read-only review of a watched
definition. It retains the last playable revision through a failed build and
can export the displayed revision. A successful rebuild keeps the playhead
at the same timeline time, even when the frame rate changes. If the edited
timeline ends before that position, the playhead moves to its last frame.
Click or keyboard-activate a clip, subtitle, or transition to pause on the
first frame at or after its start. Selections made while playback loads
take effect when the preview is ready. All authoring happens in the
definition.

OpenCut also provides
media probing, frame extraction, optional dialogue separation using an
external model, and licensed media download tools. See the
[definition reference](VIDEO_DEFINITIONS.md) for the current authoring features.
