# Product

OpenCut will be a lightweight, local desktop video editor for YouTubers,
TikTok and Instagram creators, vloggers, and streamers. A clear conventional
interface should make everyday editing accessible without code: media library,
preview, timeline and editing controls are intended future capabilities.

## Two equally important workflows

**GUI-first usability:** creators should be able to edit entirely in the desktop
application, with discoverable controls and understandable feedback.

**CLI-first architecture:** editing behavior belongs to an independently usable
headless core. The GUI and a standalone CLI will invoke the same operations.
Scripts and compatible external AI coding agents should be able to control that
core without launching Electron. Neither interface gets a separate editing model.
A maintained official Agent Skill will teach agents the actual CLI as it grows.

The editing model (projects, intent, commands, validation) and the media engine
(probing, decoding, playback and encoding) are separate concerns. Their detailed
contracts and the media backend require later technical validation.

## Current scope: T01

Implemented: pnpm workspace, Electron/React placeholder, standalone help/version
CLI, importable core identity, reserved media/shared packages, strict TypeScript,
linting, formatting, tests, synthetic fixture tooling, and initial documentation.
No editing operation exists yet. The desktop placeholder is not an editing UI.

## Excluded

T01 does not implement a timeline, renderer, media decoder, preview player,
editing commands, project serialization or a media backend. No FFmpeg or MLT
runtime is bundled; fixture generation is an optional development utility.

The product is not an AI-native editor. An embedded assistant, LLM APIs and an
MCP server are outside the product direction. Cloud infrastructure, databases,
authentication, telemetry and backend services are also excluded from this setup.
User media must never be silently changed or overwritten.

macOS is the initial required platform. Package boundaries should stay portable;
Windows/Linux support requires explicit validation later. No distribution,
installer, updater, signing or notarization work is included in T01.
