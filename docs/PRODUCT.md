# Product

OpenCut will be a lightweight, local desktop video editor for YouTubers,
TikTok and Instagram creators, vloggers, and streamers. A clear conventional
interface should make everyday editing accessible without code: media library,
timeline and editing controls are intended future capabilities. A source preview prototype is available.

## Two equally important workflows

**GUI-first usability:** creators should be able to edit entirely in the desktop
application, with discoverable controls and understandable feedback.

**CLI-first architecture:** editing behavior belongs to an independently usable
headless core. The GUI and a standalone CLI will invoke the same operations.
Scripts and compatible external AI coding agents should be able to control that
core without launching Electron. Neither interface gets a separate editing model.
A maintained official Agent Skill will teach agents the actual CLI as it grows.

The editing model (projects, intent, commands, validation) and the media engine
(probing, decoding, playback and encoding) are separate concerns. Detailed editing
contracts and the playback/render backend require later technical validation.

## Current scope: T10

Implemented: pnpm workspace, Electron/React shell, standalone help/version
CLI, importable core identity, headless media package, reserved shared package,
strict TypeScript, linting, formatting, tests, synthetic fixture tooling, and
documentation. T02 adds structured media inspection with ffprobe and single-frame
PNG extraction with FFmpeg, through standalone CLI commands supporting JSON.
T03 adds a headless FFmpeg composition spike: sequential video clips, background
music mixed with original audio, normalization of media properties, and verified
H.264/AAC MP4 export through the CLI. T04 adds a desktop-only source preview prototype: local file selection,
play/pause, timestamp seeks, nominal forward/backward frame stepping, presented
frame PTS and reproducible seek/playback/resource measurements. HTML video is the
recommended initial source-preview architecture; frame stepping is best effort,
not a frame-accurate editing contract. See [ADR 0003](adr/0003-html-video-preview.md).

T05 adds a headless versioned project data model with metadata/settings, media
assets, video/audio tracks, source ranges and timeline positions linked by stable
IDs. Rational time supports exact frame boundaries. Creation, strict validation,
deterministic JSON serialization, file save/load and separate missing-media
checks are available as core APIs. Relative paths keep project bundles portable.
See [PROJECT_FORMAT.md](PROJECT_FORMAT.md) for the version 1 contract.

T06 adds standalone `project create`, `project info` and `project validate`
commands over the T05 APIs, with configurable resolution/rational frame rate,
JSON reports, scoped help, predictable exit codes and exclusive project creation.
Validation reports project-data issues and local media availability separately.
These three commands require no Electron or media tools. See [CLI.md](CLI.md#projects).

T07 adds CLI media import/list/info/remove backed by shared headless core APIs.
Imports probe video, audio and images, persist metadata and stable UUIDs, and
reference original files without copying. Normalized paths, symlinks and hard
links deduplicate by source identity. Inspection reports offline files and
referencing clips; removal refuses referenced assets and never deletes source
files. Project mutations use atomic replacement and a writer lock. Only import
needs ffprobe. See [the asset command contract](CLI.md#project-media-assets).

T08 adds shared headless timeline operations through `timeline list`, video/audio
`track add/remove`, and `clip add/move/trim/split/remove`. CLI frame indices convert
to exact rational seconds at the project rate. Source bounds and compatibility
are validated, same-track overlaps fail, and touching exclusive ends or cross-track
overlaps are allowed. Splits preserve source mapping and total duration; no edit
implicitly shifts neighbors. Stable IDs and guarded atomic persistence support
scripts and external agents. See [timeline editing](CLI.md#timeline-editing).

T09 adds atomic timeline batches, exact undo/redo, persistent history, dry-run
validation and revision checks through `edit apply|undo|redo|history`. Existing
individual timeline/media edits share the same snapshot history. Failed batches
leave no partial content or history; changed edits after undo discard redo.
See [transactions, undo and redo](CLI.md#transactions-undo-and-redo).

T10 adds `project render` over saved timelines, supporting one video track,
sequential trimmed/split clips, black gaps and exact integer/rational frame timing.
Output is H.264 MP4 at project resolution/rate. Sources and project history remain
unchanged. See [project rendering](CLI.md#project-rendering) for limits.

## Excluded

T10 does not implement multiple-track rendering, audio output/mixing, transitions,
effects, or desktop project media integration. No FFmpeg or
MLT runtime is bundled; media commands require manually installed external tools.
Fixture generation remains an optional development utility.

The product is not an AI-native editor. An embedded assistant, LLM APIs and an
MCP server are outside the product direction. Cloud infrastructure, databases,
authentication, telemetry and backend services are also excluded from this setup.
User media must never be silently changed or overwritten.

macOS is the initial required platform. Package boundaries should stay portable;
Windows/Linux support requires explicit validation later. No distribution,
installer, updater, signing or notarization work is included in T10. T11 is not implemented.
