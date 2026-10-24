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

## Current scope: T04

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

## Excluded

T04 does not implement a timeline, final rendering architecture,
project editing commands, project serialization or project media integration. No FFmpeg or
MLT runtime is bundled; media commands require manually installed external tools.
Fixture generation remains an optional development utility.

The product is not an AI-native editor. An embedded assistant, LLM APIs and an
MCP server are outside the product direction. Cloud infrastructure, databases,
authentication, telemetry and backend services are also excluded from this setup.
User media must never be silently changed or overwritten.

macOS is the initial required platform. Package boundaries should stay portable;
Windows/Linux support requires explicit validation later. No distribution,
installer, updater, signing or notarization work is included in T04. T05 is not implemented.
