#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { withCommandCancellation } from './cancellation.js';
import { isVideoCommand, runVideoCommand, videoUsage } from './video.js';
import { formatSystem, inspectSystem, systemHelp } from './system.js';
import { jobsHelp, runJobsCommand } from './jobs.js';
import { discovery } from './discovery.js';
import {
  inspectionHelp,
  inspectionOptions,
  runInspectionCommand,
} from './inspection.js';
import { cacheHelp, runCacheCommand } from './cache.js';
import { onlineHelp, runOnlineCommand } from './online.js';
import { editHelp, runEditCommand } from './edit.js';
import { subtitleHelp, runSubtitleCommand } from './subtitle.js';
import { runScriptCommand, scriptHelp } from './script.js';
import {
  editOptions,
  runTimelineCommand,
  timelineHelp,
  UsageError,
} from './timeline.js';
import { resolve } from 'node:path';
import {
  createProject,
  getApplicationInfo,
  getProjectInfo,
} from '@opencut/core';
import {
  getMediaAsset,
  copyProjectFile,
  freezeProjectFrame,
  prepareEmbeddedFont,
  updateProjectFile,
  importMediaAsset,
  relinkMediaAsset,
  listMediaAssets,
  readProjectFile,
  renderProjectFile,
  removeMediaAsset,
  validateProjectFile,
  writeProjectFile,
  controlDesktopProject,
  desktopControlSchema,
  renderPreviewCache,
} from '@opencut/core/node';
import type { AssetInfo } from '@opencut/core/node';
import {
  composeMedia,
  extractFrame,
  probeMedia,
  renderQualities,
  renderResolutions,
  renderCodecs,
  separateDialogue,
  MediaError,
} from '@opencut/media';
import type {
  MediaMetadata,
  RenderQuality,
  RenderResolution,
  RenderCodec,
} from '@opencut/media';

const help = `Usage: opencut [command] [options]

OpenCut — Video-as-Code, timeline editing, visual inspection and headless rendering.

Commands:
  validate <definition.video.ts|definition.video.json>
                                       Validate a whole-video definition and its media
  inspect <definition> --json          Inspect the compiled timeline
  render <definition> --output <new.mp4>
                                       Render directly from a whole-video definition
  migrate <project-file> --output <new.video.json|new.video.ts>
                                       Convert a saved project into a standalone definition
  system inspect [--json]              Inspect hardware and local VideoToolbox capabilities
  help --json                         Discover commands, arguments, capabilities and schemas
  run <script.ts> --project <project-file>
                                       Execute a trusted TypeScript script (run --help)
  project inspect <project-file>      Read revision-tagged content (offline)
  timeline inspect <project-file> --frame <n>
                                       Evaluate layers, audio and exact source times
  preview <definition> --watch         Watch and render playable revisions
  preview frame|contact-sheet|clip <project-or-definition> --output <new.png|mp4>
                                       Inspect the composited timeline (preview --help)
  project create <project-file> --name <name> [--width <px>] [--height <px>] [--fps <n|n/d>]
                                       Create a new project without overwriting
  project info <project-file>           Show metadata, settings and statistics
  project validate <project-file>       Check project data and media references
  project render <project-file> --output <new.mp4>
                                       Composite video, images, text and subtitles and mix audio
  jobs submit|status|list|cancel|retry  Manage persistent background exports (jobs --help)
  project cache-preview <project-file> Render or reuse a full timeline preview
  desktop control <project-file> <request.json>
                                       Control an open desktop project
  online search|import                 Search and import licensed online media (online --help)
  media import <project-file> <file>    Import a source reference and probe metadata
  media list <project-file>             List assets, metadata and source availability
  media info <project-file> <asset-id>   Inspect an asset by stable ID
  media remove <project-file> <asset-id> Remove an unreferenced asset, keeping its file
  media relink <project-file> <asset-id> <file>
                                       Relink an asset and retain its clip references
  subtitle <import|list|export>         Work with timed subtitle cues and sidecar files
  timeline list <project-file>          Inspect tracks, clips and exact timing
  track add|remove|audio <project-file>       Manage video/audio tracks (track --help)
  clip add|move|trim|split|remove|audio|visual <project-file>
                                       Edit clips (clip --help; time arguments are frames)
  canvas set <project-file>            Configure dimensions and background (canvas --help)
  transition <add|set|remove>         Edit video transitions (transition --help)
  edit apply <project-file> <batch.json> Apply an atomic transaction
  edit undo|redo|history <project-file>  Restore or inspect persistent editing history
  cache status|proxy|frame|configure|cleanup|clear  Manage preview derivatives (cache --help)
  probe <file>                         Inspect local media metadata
  extract-frame <file> --timestamp <s> --output <file.png>
                                       Extract one PNG frame, without overwriting
  compose <clip1> <clip2> [more clips] --music <audio> --output <new.mp4>
                                       Concatenate video and mix background music

Options:
  -h, --help     Show this help
  -v, --version  Show the application version
  --json        Print JSON (project render streams JSONL events)
  --dry-run     Validate editing/media mutations without saving
  --expected-revision <n> Reject a stale editing/media mutation
  --name        Nonblank project or track name (project create / track add)
  --timestamp   Frame timestamp in nonnegative decimal seconds
  --output      PNG/MP4 output path (parent directory must exist)
  --quality     draft|balanced|high (project render; default balanced)
  --resolution  project|720p|1080p (project render; default project)
  --no-subtitles  Leave subtitles out of the video (project render only)
  --overwrite   Atomically replace a regular output file (project render only)
  --music       Background audio path (compose only; looped to fit)
  --width       Even output width, 2–3840 (compose default: 1280)
  --height      Even output height, 2–2160 (compose default: 720)
  --fps         Integer output frame rate, 1–60 (compose default: 30)
  --clip-volume Original audio gain, 0–1 (compose default: 1; 0 mutes)
  --music-volume Music gain, 0–1 (compose default: 0.25)

Project create defaults: 1920x1080, 30/1 fps; positive safe integer dimensions
and frame-rate components. Relative project paths resolve from the working directory.
Project create/info/validate, timeline edits and media list/info/remove need no media tools.
Import/probe need ffprobe; extraction/composition/project render also need ffmpeg.
Compose supports 2–16 clips, up to 600 seconds; exports H.264/AAC MP4.
Exit codes: 0 success, 1 validation/runtime/file/media failure, 2 invalid arguments; render cancellation 130 (SIGINT), 143 (SIGTERM).
`;

const projectHelp = {
  'cache-preview':
    'Usage: opencut project cache-preview <project-file> [--size <64..1920>] [--json]',
  freeze: `Usage: opencut project freeze <project-file> <clip-id> --at <frame> --frames <count> --output <new.png> [--expected-revision <n>] [--json]\nInsert a held source frame and shift later clips on its track.`,
  snapshot: `Usage: opencut project snapshot <project-file> --output <new-project-file> [--json]\nSave a named copy of the current revision, rebasing its media references.`,
  package: `Usage: opencut project package <project-file> --output <new-directory> [--json]\nCopy the project and the media referenced by its history into a portable directory.`,
  render: `Usage: opencut project render <project-file> --output <file.mp4> [--quality <draft|balanced|high>] [--resolution <project|720p|1080p>] [--overwrite] [--no-subtitles] [--json] [--help]

Composite ordered video, image, text and subtitle layers and mix audio to MP4.
--codec <h264|hevc>, --fps <n|n/d>, --width <px> --height <px>, --resolution <project|720p|1080p>
--quality <draft|balanced|high>, --video-bitrate <kb/s>, --audio-bitrate <kb/s>
--audio-rate <44100|48000>, --audio-channels <1|2>, --overwrite, --no-subtitles, --json
Visual gaps use the canvas background; audio gaps are silent. Original audio is preserved by default.
Use clip speed --speed <decimal|ratio> to set a playback multiplier from 0.25 to 4.
Use clip audio and track audio to set linear gains and mute. Clip fades use --fade-in/--fade-out <frames>.
Use clip visual for position/scale/rotation/opacity/contain/cover/stretch and canvas set for dimensions/background.
Later video tracks draw above earlier tracks. Images and text use their explicit clip duration.
Media clips and subtitles accept exact times. Title clip boundaries use project frames. Subtitles burn in by default.
Supports even sides up to 3840 (at most 3840x2160 pixels), 1–120 fps, 64 non-subtitle clips, up to 256 burned-in cues and 600 seconds.
Requires FFmpeg 8+ and ffprobe. Output must be in an existing directory; replacement requires --overwrite.
Balanced quality and project resolution are defaults; resolution presets fit the finished canvas, preserving orientation/aspect.
Progress goes to stderr, or JSONL progress and completed/failed/cancelled events on stdout with --json.
SIGINT/SIGTERM cancel encoding or verification and clean temporary output before exit (130/143).
`,
  create: `Usage: opencut project create <project-file> --name <name> [options]

Create a new version 1 project in an existing directory; never overwrite files or symlinks.
  --name <name>     Required nonblank project name
  --width <px>      Positive safe integer (default 1920)
  --height <px>     Positive safe integer (default 1080)
  --fps <n|n/d>     Positive safe integer or rational components (default 30/1)
  --json           Print path, metadata, settings and statistics as JSON
  -h, --help       Show this help
`,
  info: `Usage: opencut project info <project-file> [--json] [--help]

Show validated metadata, settings and asset/track/clip counts, including offline projects.
Does not check media availability or modify files.
`,
  validate: `Usage: opencut project validate <project-file> [--json] [--help]

Check schema, IDs, ranges, internal references and media-file readability.
Print a report even for invalid project data; exit 1 when data or media checks fail.
No decoding or file modification occurs. File-read failures have no report.
`,
};

const mediaHelp = {
  'import-font': `Usage: opencut media import-font <project-file> <title-or-cue-id> <font.ttf|font.otf> [--dry-run] [--expected-revision <n>] [--json]\nEmbed a font in a title or subtitle cue.`,
  'separate-dialogue': `Usage: opencut media separate-dialogue <project-file> <asset-id> --output <new-directory> [--json]

Create sample-aligned dialogue and background WAV files with a locally installed Bandit v2 model.
`,
  relink: `Usage: opencut media relink <project-file> <asset-id> <file> [--dry-run] [--expected-revision <n>] [--json] [--help]

Replace an asset's source in place. Reprobe the file and validate all referencing clips.
`,
  import: `Usage: opencut media import <project-file> <file> [--dry-run] [--expected-revision <n>] [--json] [--help]

Import one video, audio or image file by reference without copying or modifying it.
Source arguments resolve from the working directory; stored references prefer project-relative paths.
Requires ffprobe. Duplicate paths, symlinks and hard links return the existing stable ID.
Project updates are atomic; project symlinks and hard links are refused.
`,
  list: `Usage: opencut media list <project-file> [--json] [--help]

List stored asset metadata, source availability and referencing clip IDs. No probing or writes.
Offline sources are reported in the result; they do not prevent inspection.
`,
  info: `Usage: opencut media info <project-file> <asset-id> [--json] [--help]

Inspect stored metadata, source availability and referencing clip IDs by stable asset ID.
No probing or writes; offline sources remain inspectable.
`,
  remove: `Usage: opencut media remove <project-file> <asset-id> [--dry-run] [--expected-revision <n>] [--json] [--help]

Atomically remove an unreferenced asset entry. Referenced assets are refused.
Original media files are never deleted. No media tools are required.
Import/remove create undo/redo history; dry-run validates without saving.
`,
};

function formatAsset(info: AssetInfo): string {
  const { asset, source, referencedBy } = info;
  const metadata = asset.metadata;
  return [
    `Asset: ${asset.id} (${asset.name})`,
    `Source: ${source.path} [${source.status}]`,
    source.message,
    `Media: ${metadata?.kind ?? asset.mediaTypes.join(', ')}`,
    `Format: ${metadata?.formatName ?? 'unknown'}`,
    `Duration: ${metadata?.durationSeconds ?? 'unknown'} s`,
    `Dimensions: ${metadata?.width ?? '?'}x${metadata?.height ?? '?'}`,
    `Codecs: video ${metadata?.videoCodec ?? 'none/unknown'}, audio ${metadata?.audioCodec ?? 'none/unknown'}`,
    `Frame rate: ${metadata?.frameRateRatio ?? metadata?.frameRate ?? 'unknown'}`,
    `Audio present: ${metadata?.hasAudio ?? asset.mediaTypes.includes('audio')}`,
    `Referenced by: ${referencedBy.join(', ') || 'none'}`,
    '',
  ].join('\n');
}

function output(
  value: unknown,
  readable: string,
  json: boolean | undefined,
): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : readable);
}

function positiveInteger(name: string, value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new UsageError(
      `--${name} requires a positive safe integer (1–9007199254740991).`,
    );
  }
  return number;
}

function numericArgument(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
    !Number.isFinite(number) ||
    number < minimum ||
    number > maximum ||
    (integer && !Number.isInteger(number))
  ) {
    throw new UsageError(
      `--${name} requires ${integer ? 'an integer' : 'a decimal number'} between ${minimum} and ${maximum}.`,
    );
  }
  return number;
}

function formatProbe(media: MediaMetadata): string {
  const { video, audio } = media;
  return [
    `File: ${media.path}`,
    `Format: ${media.formatName ?? 'unknown'}`,
    `Duration: ${media.durationSeconds === null ? 'unknown' : `${media.durationSeconds} s`}`,
    `Video: ${video ? `${video.codec ?? 'unknown'}, ${video.width ?? '?'}x${video.height ?? '?'}, ${video.frameRate ?? '?'} fps` : 'none'}`,
    `Audio: ${audio ? `${audio.codec ?? 'unknown'}, ${audio.sampleRate ?? '?'} Hz, ${audio.channels ?? '?'} channels` : 'none'}`,
    `Streams: ${media.streams.length}`,
    '',
  ].join('\n');
}

async function runCli(args: string[]): Promise<void> {
  const commandPosition = args.findIndex(
    (arg) => !['--json', '--help', '-h'].includes(arg),
  );
  const leadingCommand = args[commandPosition];
  if (isVideoCommand(leadingCommand))
    return runVideoCommand(leadingCommand, [
      ...args.slice(0, commandPosition),
      ...args.slice(commandPosition + 1),
    ]);
  if (
    leadingCommand === 'run' ||
    leadingCommand === 'cache' ||
    leadingCommand === 'jobs'
  ) {
    const commandArgs = [
      ...args.slice(0, commandPosition),
      ...args.slice(commandPosition + 1),
    ];
    if (leadingCommand === 'jobs') return runJobsCommand(commandArgs);
    return leadingCommand === 'run'
      ? runScriptCommand(commandArgs)
      : runCacheCommand(commandArgs);
  }
  if (
    leadingCommand === 'online' &&
    !args.includes('--help') &&
    !args.includes('-h')
  )
    return runOnlineCommand(args);
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      ...inspectionOptions,
      'dry-run': { type: 'boolean' },
      'expected-revision': { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
      track: { type: 'string' },
      at: { type: 'string' },
      in: { type: 'string' },
      out: { type: 'string' },
      timestamp: { type: 'string' },
      output: { type: 'string' },
      quality: { type: 'string' },
      resolution: { type: 'string' },
      codec: { type: 'string' },
      'video-bitrate': { type: 'string' },
      'audio-bitrate': { type: 'string' },
      'audio-rate': { type: 'string' },
      'audio-channels': { type: 'string' },
      frames: { type: 'string' },
      size: { type: 'string' },
      overwrite: { type: 'boolean' },
      'no-subtitles': { type: 'boolean' },
      music: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      fps: { type: 'string' },
      'clip-volume': { type: 'string' },
      'music-volume': { type: 'string' },
      volume: { type: 'string' },
      muted: { type: 'string' },
      speed: { type: 'string' },
      kind: { type: 'string' },
      'from-clip': { type: 'string' },
      'in-time': { type: 'string' },
      'out-time': { type: 'string' },
      'fade-in': { type: 'string' },
      'fade-out': { type: 'string' },
      x: { type: 'string' },
      y: { type: 'string' },
      scale: { type: 'string' },
      rotation: { type: 'string' },
      opacity: { type: 'string' },
      fit: { type: 'string' },
      'background-color': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: false,
  });
  const [command, file, projectFile] = positionals;
  if (
    command === 'preview' ||
    (['project', 'timeline'].includes(command ?? '') && file === 'inspect')
  )
    return runInspectionCommand(args);
  if (command === 'system' && !values.help) {
    if (Object.keys(values).some((key) => key !== 'json'))
      throw new UsageError('system inspect accepts only --json and --help.');
    if (file !== 'inspect' || positionals.length !== 2)
      throw new UsageError(systemHelp);
    const result = await inspectSystem();
    output(result, formatSystem(result), values.json);
    return;
  }
  for (const option of Object.keys(
    inspectionOptions,
  ) as (keyof typeof inspectionOptions)[]) {
    if (option === 'size' && command === 'project' && file === 'cache-preview')
      continue;
    if (values[option] !== undefined)
      throw new UsageError(
        `--${option} applies only to inspection or preview commands.`,
      );
  }
  const explicitHelp = command === 'help';
  const commandPositionals = explicitHelp ? positionals.slice(1) : positionals;
  const [group, action] = commandPositionals;
  const timelineCommand = [
    'timeline',
    'track',
    'clip',
    'canvas',
    'transition',
  ].includes(group ?? '');
  const projectCommand =
    group === 'project' && action && Object.hasOwn(projectHelp, action)
      ? (action as keyof typeof projectHelp)
      : undefined;
  const mediaCommand =
    group === 'media' && action && Object.hasOwn(mediaHelp, action)
      ? (action as keyof typeof mediaHelp)
      : undefined;
  if (explicitHelp || values.help || args.length === 0) {
    if (
      explicitHelp &&
      Object.keys(values).some((key) => !['help', 'json'].includes(key))
    )
      throw new UsageError('help accepts only --json and --help.');
    let usage = help;
    if (isVideoCommand(group)) usage = videoUsage[group];
    else if (group === 'system') usage = systemHelp;
    else if (group === 'run') usage = scriptHelp;
    else if (group === 'online') usage = onlineHelp;
    else if (group === 'cache') usage = cacheHelp;
    else if (group === 'jobs') usage = jobsHelp;
    else if (
      group === 'preview' ||
      (action === 'inspect' && (group === 'project' || group === 'timeline'))
    )
      usage = inspectionHelp;
    else if (group === 'edit') usage = editHelp;
    else if (group === 'subtitle') usage = subtitleHelp;
    else if (group === 'desktop')
      usage =
        'Usage: opencut desktop control <project-file> <request.json> [--json]\nActions: status, play, pause, toggle, step, seek, source-seek, select, viewer, render-preview, live-preview.';
    else if (timelineCommand) usage = timelineHelp;
    else if (group === 'project')
      usage = projectCommand
        ? projectHelp[projectCommand]
        : `Usage: opencut project <create|info|inspect|validate|render> <project-file> [options]\n\n${Object.values(projectHelp).join('\n')}`;
    else if (group === 'media')
      usage = mediaCommand
        ? mediaHelp[mediaCommand]
        : `Usage: opencut media <import|list|info|remove> <project-file> [file|asset-id] [--json]\n\n${Object.values(mediaHelp).join('\n')}`;
    const scope = explicitHelp
      ? commandPositionals
      : commandPositionals.slice(0, 2);
    const result = discovery(scope, usage);
    if (explicitHelp && result.commands.length === 0)
      throw new UsageError(
        'Unknown help command. Run help --json for discovery.',
      );
    output(result, usage, values.json);
    return;
  }
  if (command !== 'project' || file !== 'render') {
    for (const option of [
      'quality',
      'resolution',
      'overwrite',
      'no-subtitles',
      'codec',
      'video-bitrate',
      'audio-bitrate',
      'audio-rate',
      'audio-channels',
    ] as const) {
      if (values[option] !== undefined)
        throw new UsageError(`--${option} applies only to project render.`);
    }
  }
  if (command === 'subtitle') return runSubtitleCommand(positionals, values);
  if (command === 'desktop' && file === 'control') {
    if (
      positionals.length !== 4 ||
      !projectFile ||
      Object.keys(values).some((key) => key !== 'json')
    )
      throw new UsageError(
        'Expected desktop control <project-file> <request.json>.',
      );
    const { readFile } = await import('node:fs/promises');
    const request = desktopControlSchema.parse(
      JSON.parse(await readFile(positionals[3]!, 'utf8')),
    );
    const result = await controlDesktopProject(resolve(projectFile), request);
    output(result, JSON.stringify(result, null, 2), values.json);
    return;
  }
  if (command === 'project' && projectCommand === 'freeze') {
    const id = positionals[3];
    const at = Number(values.at);
    const frames = Number(values.frames);
    if (
      positionals.length !== 4 ||
      !projectFile?.trim() ||
      !id ||
      !values.output?.trim() ||
      !values.at?.trim() ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !Number.isSafeInteger(frames) ||
      frames < 1 ||
      Object.keys(values).some(
        (key) =>
          !['json', 'at', 'frames', 'output', 'expected-revision'].includes(
            key,
          ),
      )
    )
      throw new UsageError(projectHelp.freeze);
    const result = await freezeProjectFrame(
      resolve(projectFile),
      id,
      at,
      frames,
      values.output,
      editOptions(values),
    );
    output(
      result,
      `Inserted freeze frame: ${result.clip.id}\n${result.path}`,
      values.json,
    );
    return;
  }
  if (command === 'edit') {
    await runEditCommand(positionals, values);
    return;
  }
  if (timelineCommand) {
    await runTimelineCommand(positionals, values);
    return;
  }
  for (const option of [
    'type',
    'kind',
    'from-clip',
    'track',
    'at',
    'in',
    'out',
    'volume',
    'muted',
    'speed',
    'in-time',
    'out-time',
    'fade-in',
    'fade-out',
    'x',
    'y',
    'scale',
    'rotation',
    'opacity',
    'fit',
    'background-color',
  ] as const) {
    if (values[option] !== undefined)
      throw new UsageError(
        `--${option} applies only to timeline editing commands.`,
      );
  }
  if (
    command !== 'media' &&
    (values['dry-run'] !== undefined ||
      values['expected-revision'] !== undefined)
  )
    throw new UsageError(
      '--dry-run and --expected-revision apply only to editing or media mutations.',
    );
  if (command === 'media') {
    const argument = positionals[3];
    if (
      !mediaCommand ||
      positionals.length !==
        (mediaCommand === 'list'
          ? 3
          : mediaCommand === 'relink' || mediaCommand === 'import-font'
            ? 5
            : 4) ||
      !projectFile?.trim() ||
      (mediaCommand !== 'list' && !argument?.trim()) ||
      ((mediaCommand === 'relink' || mediaCommand === 'import-font') &&
        !positionals[4]?.trim())
    )
      throw new UsageError(
        'Expected media import|list|info|remove|relink. Use media --help for usage.',
      );
    const allowed = [
      'json',
      ...(mediaCommand === 'separate-dialogue' ? ['output'] : []),
      ...(['import', 'remove', 'relink', 'import-font'].includes(mediaCommand)
        ? ['dry-run', 'expected-revision']
        : []),
    ];
    for (const option of Object.keys(values)) {
      if (!allowed.includes(option))
        throw new UsageError(
          `--${option} does not apply to media ${mediaCommand}.`,
        );
    }
    if (
      positionals
        .slice(2)
        .some((value) =>
          Array.from(value).some((character) => character.charCodeAt(0) < 32),
        )
    )
      throw new UsageError(
        'Media arguments must not contain control characters.',
      );
    const path = resolve(projectFile);
    if (mediaCommand === 'list') {
      const result = await listMediaAssets(path);
      output(
        result,
        `Project: ${result.path}\nAssets: ${result.assets.length}\n${result.assets.map(formatAsset).join('\n')}`,
        values.json,
      );
    } else if (mediaCommand === 'import') {
      const result = await importMediaAsset(
        path,
        argument!,
        editOptions(values),
      );
      output(
        result,
        `${values['dry-run'] ? 'Validated import' : result.imported ? 'Imported' : 'Already imported'}: ${result.asset.id}\n${formatAsset(result)}`,
        values.json,
      );
    } else if (mediaCommand === 'import-font') {
      const result = await updateProjectFile(
        path,
        (project) =>
          prepareEmbeddedFont(project, argument!, resolve(positionals[4]!)),
        { ...editOptions(values), label: 'Import font' },
      );
      output(
        result,
        `${values['dry-run'] ? 'Validated font' : 'Imported font'}: ${result.file}`,
        values.json,
      );
    } else if (mediaCommand === 'separate-dialogue') {
      if (!values.output?.trim())
        throw new UsageError('Specify --output <new-directory>.');
      const { source } = await getMediaAsset(path, argument!);
      if (source.status !== 'available') throw new UsageError(source.message);
      const result = await separateDialogue(source.path, values.output);
      output(
        result,
        `Dialogue: ${result.dialogue}\nBackground: ${result.background}`,
        values.json,
      );
    } else if (mediaCommand === 'relink') {
      const result = await relinkMediaAsset(
        path,
        argument!,
        positionals[4]!,
        editOptions(values),
      );
      output(
        result,
        `${values['dry-run'] ? 'Validated relink' : 'Relinked'}: ${result.asset.id}\n${formatAsset(result)}`,
        values.json,
      );
    } else if (mediaCommand === 'info') {
      const result = await getMediaAsset(path, argument!);
      output(result, formatAsset(result), values.json);
    } else {
      const result = await removeMediaAsset(
        path,
        argument!,
        editOptions(values),
      );
      output(
        result,
        `${values['dry-run'] ? 'Validated removal of' : 'Removed'} asset: ${result.removedAssetId}\n`,
        values.json,
      );
    }
    return;
  }
  if (command === 'project') {
    if (projectCommand === 'cache-preview') {
      if (
        positionals.length !== 3 ||
        !projectFile ||
        Object.keys(values).some((key) => key !== 'json' && key !== 'size')
      )
        throw new UsageError(projectHelp['cache-preview']);
      const size = Number(values.size ?? 960);
      if (!Number.isInteger(size) || size < 64 || size > 1920)
        throw new UsageError('Preview size must be between 64 and 1920.');
      const path = resolve(projectFile);
      const result = await renderPreviewCache(
        await readProjectFile(path),
        path,
        size,
      );
      output(result, result.path, values.json);
      return;
    }
    if (!projectCommand || positionals.length !== 3 || !projectFile?.trim()) {
      throw new UsageError(
        'Expected project create|info|validate|render <project-file>; create also requires --name <name>.',
      );
    }
    const allowed = [
      'json',
      ...(projectCommand === 'create'
        ? ['name', 'width', 'height', 'fps']
        : projectCommand === 'render'
          ? [
              'output',
              'quality',
              'resolution',
              'overwrite',
              'no-subtitles',
              'width',
              'height',
              'fps',
              'codec',
              'video-bitrate',
              'audio-bitrate',
              'audio-rate',
              'audio-channels',
            ]
          : projectCommand === 'snapshot' || projectCommand === 'package'
            ? ['output']
            : []),
    ];
    for (const option of Object.keys(values)) {
      if (!allowed.includes(option))
        throw new UsageError(
          `--${option} does not apply to project ${projectCommand}.`,
        );
    }
    if (
      Array.from(projectFile).some((character) => character.charCodeAt(0) < 32)
    )
      throw new UsageError(
        'Project file paths must not contain control characters.',
      );
    const path = resolve(projectFile);
    if (projectCommand === 'snapshot' || projectCommand === 'package') {
      if (!values.output?.trim())
        throw new UsageError('Specify --output for the new copy.');
      const result = await copyProjectFile(
        await readProjectFile(path),
        path,
        resolve(values.output),
        projectCommand === 'package',
      );
      output(
        result,
        `Saved revision ${result.revision} to ${result.path}`,
        values.json,
      );
      return;
    }
    if (projectCommand === 'render') {
      if (
        !values.output?.trim() ||
        !values.output.toLowerCase().endsWith('.mp4')
      )
        throw new UsageError('project render requires --output <new.mp4>.');
      if (
        values.quality !== undefined &&
        !(renderQualities as readonly string[]).includes(values.quality)
      )
        throw new UsageError('--quality must be draft, balanced or high.');
      if (
        values.resolution !== undefined &&
        !(renderResolutions as readonly string[]).includes(values.resolution)
      )
        throw new UsageError('--resolution must be project, 720p or 1080p.');
      if (
        values.codec !== undefined &&
        !(renderCodecs as readonly string[]).includes(values.codec)
      )
        throw new UsageError('--codec must be h264 or hevc.');
      const integer = (
        key:
          | 'width'
          | 'height'
          | 'video-bitrate'
          | 'audio-bitrate'
          | 'audio-rate'
          | 'audio-channels',
      ) => {
        const value = values[key];
        if (value === undefined) return undefined;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new UsageError(`--${key} must be a positive integer.`);
        return Number(value);
      };
      const width = integer('width');
      const height = integer('height');
      if ((width === undefined) !== (height === undefined))
        throw new UsageError('Specify both --width and --height.');
      const audioSampleRate = integer('audio-rate');
      if (
        audioSampleRate !== undefined &&
        audioSampleRate !== 44100 &&
        audioSampleRate !== 48000
      )
        throw new UsageError('--audio-rate must be 44100 or 48000.');
      const audioChannels = integer('audio-channels');
      if (
        audioChannels !== undefined &&
        audioChannels !== 1 &&
        audioChannels !== 2
      )
        throw new UsageError('--audio-channels must be 1 or 2.');
      const fps = values.fps;
      if (fps !== undefined && !/^\d+(?:\/\d+)?$/.test(fps))
        throw new UsageError(
          '--fps must be an integer or a fraction such as 30000/1001.',
        );
      const [numerator, denominator = 1] = fps?.split('/').map(Number) ?? [];
      const destination = values.output;
      const jsonLine = (event: unknown) =>
        process.stdout.write(`${JSON.stringify(event)}\n`);
      await withCommandCancellation(async (signal) => {
        try {
          const result = await renderProjectFile(path, destination, {
            quality: values.quality as RenderQuality | undefined,
            resolution: values.resolution as RenderResolution | undefined,
            codec: values.codec as RenderCodec | undefined,
            outputSize:
              width !== undefined && height !== undefined
                ? { width, height }
                : undefined,
            outputFrameRate:
              numerator === undefined ? undefined : { numerator, denominator },
            videoBitrateKbps: integer('video-bitrate'),
            audioBitrateKbps: integer('audio-bitrate'),
            audioSampleRate,
            audioChannels,
            overwrite: values.overwrite,
            burnSubtitles: !values['no-subtitles'],
            signal,
            onProgress: (event) => {
              if (values.json) jsonLine(event);
              else
                process.stderr.write(
                  `${event.phase}: ${event.percent.toFixed(1)}% (${event.processedFrames}/${event.totalFrames} frames), elapsed ${event.elapsedSeconds.toFixed(1)}s, remaining ${event.remainingSeconds === null ? 'unknown' : `${event.remainingSeconds.toFixed(1)}s`}\n`,
                );
            },
          });
          if (values.json) jsonLine({ event: 'completed', ...result });
          else {
            for (const warning of result.warnings ?? [])
              process.stderr.write(`Warning: ${warning}\n`);
            process.stdout.write(
              `Saved ${result.frameCount} frames (${result.width}x${result.height}, ${result.frameRate.numerator}/${result.frameRate.denominator} fps, ${result.metadata.video?.codec}/AAC) to ${result.path}\n`,
            );
          }
        } catch (error) {
          if (values.json)
            jsonLine({
              event: signal.aborted ? 'cancelled' : 'failed',
              message: error instanceof Error ? error.message : String(error),
            });
          throw error;
        }
      });
      return;
    }
    if (projectCommand === 'validate') {
      const result = await validateProjectFile(path);
      output(
        result,
        `${result.valid ? 'Valid' : 'Invalid'} project: ${result.path}\n`,
        values.json,
      );
      if (!result.valid) {
        for (const issue of result.issues)
          process.stderr.write(
            `opencut: ${issue.path || '/'}: ${issue.message}\n`,
          );
        for (const media of result.media) {
          if (media.status !== 'available')
            process.stderr.write(
              `opencut: asset '${media.assetId}' (${media.path}): ${media.message}\n`,
            );
        }
        process.exitCode = 1;
      }
      return;
    }
    let project;
    if (projectCommand === 'create') {
      if (!values.name?.trim())
        throw new UsageError(
          'project create requires --name <nonblank project name>.',
        );
      const fps = values.fps ?? '30';
      if (!/^\d+(?:\/\d+)?$/.test(fps))
        throw new UsageError(
          '--fps requires a positive integer or rational such as 30 or 30000/1001.',
        );
      const [numerator, denominator = '1'] = fps.split('/');
      project = createProject({
        name: values.name,
        settings: {
          width: positiveInteger('width', values.width ?? '1920'),
          height: positiveInteger('height', values.height ?? '1080'),
          frameRate: {
            numerator: positiveInteger('fps', numerator!),
            denominator: positiveInteger('fps', denominator),
          },
        },
      });
      await writeProjectFile(project, path);
    } else {
      project = await readProjectFile(path);
    }
    const result = { path, ...getProjectInfo(project) };
    output(
      result,
      [
        `${projectCommand === 'create' ? 'Created project' : 'Project'}: ${result.path}`,
        `Name: ${result.metadata.name}`,
        `ID: ${result.metadata.id}`,
        `Schema version: ${result.schemaVersion}`,
        `Created: ${result.metadata.createdAt}`,
        `Updated: ${result.metadata.updatedAt}`,
        `Settings: ${result.settings.width}x${result.settings.height}, ${result.settings.frameRate.numerator}/${result.settings.frameRate.denominator} fps`,
        `Assets: ${result.statistics.assets}; tracks: ${result.statistics.tracks}; clips: ${result.statistics.clips}`,
        '',
      ].join('\n'),
      values.json,
    );
    return;
  }
  if (values.name !== undefined)
    throw new UsageError('--name applies only to project create.');
  const hasCompositionOptions = [
    values.music,
    values.width,
    values.height,
    values.fps,
    values['clip-volume'],
    values['music-volume'],
  ].some((value) => value !== undefined);
  if (
    values.version &&
    positionals.length === 0 &&
    values.timestamp === undefined &&
    values.output === undefined &&
    !hasCompositionOptions
  ) {
    output(
      getApplicationInfo(),
      `${getApplicationInfo().version}\n`,
      values.json,
    );
    return;
  }

  if (command === 'compose' && !values.version) {
    const clips = positionals.slice(1);
    if (
      clips.length < 2 ||
      clips.length > 16 ||
      !values.music ||
      !values.output ||
      values.timestamp !== undefined
    ) {
      throw new UsageError(
        'compose requires 2–16 video clips, --music <audio> and --output <new.mp4>; --timestamp is not supported.',
      );
    }
    if (!values.output.toLowerCase().endsWith('.mp4'))
      throw new UsageError('--output must have a .mp4 extension.');
    const width = numericArgument('width', values.width, 1280, 2, 3840, true);
    const height = numericArgument('height', values.height, 720, 2, 2160, true);
    if (width % 2 || height % 2)
      throw new UsageError('--width and --height must be even.');
    const result = await composeMedia({
      clips,
      music: values.music,
      output: values.output,
      width,
      height,
      fps: numericArgument('fps', values.fps, 30, 1, 60, true),
      clipVolume: numericArgument(
        'clip-volume',
        values['clip-volume'],
        1,
        0,
        1,
      ),
      musicVolume: numericArgument(
        'music-volume',
        values['music-volume'],
        0.25,
        0,
        1,
      ),
    });
    output(
      result,
      `Saved ${result.durationSeconds}s composition (${result.width}x${result.height}, ${result.fps} fps, H.264/AAC) to ${result.path}\n`,
      values.json,
    );
    return;
  }
  if (
    values.version ||
    positionals.length !== 2 ||
    !file ||
    !['probe', 'extract-frame'].includes(command ?? '')
  ) {
    throw new UsageError(
      'Expected project create|info|validate <project-file>, probe <file>, extract-frame <file> --timestamp <seconds> --output <file.png>, or compose <clip1> <clip2> --music <audio> --output <new.mp4>.',
    );
  }
  if (hasCompositionOptions)
    throw new UsageError(
      '--music, --width, --height, --fps, --clip-volume and --music-volume apply only to compose.',
    );
  if (command === 'probe') {
    if (values.timestamp !== undefined || values.output !== undefined) {
      throw new UsageError(
        '--timestamp and --output apply only to extract-frame.',
      );
    }
    const media = await probeMedia(file);
    output(media, formatProbe(media), values.json);
    return;
  }

  const timestamp = values.timestamp;
  if (
    timestamp === undefined ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(timestamp) ||
    !Number.isFinite(Number(timestamp)) ||
    !values.output
  ) {
    throw new UsageError(
      'extract-frame requires --timestamp <nonnegative decimal seconds> and --output <file.png>.',
    );
  }
  if (!values.output.toLowerCase().endsWith('.png')) {
    throw new UsageError('--output must have a .png extension.');
  }
  const frame = await extractFrame(file, Number(timestamp), values.output);
  output(
    frame,
    `Saved frame at ${frame.timestampSeconds}s to ${frame.path}\n`,
    values.json,
  );
}

// SQLite is bundled with the pinned runtime. Its one-time experimental notice
// must not contaminate machine-readable stderr; preserve all other diagnostics.
const warningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (
    warning.name === 'ExperimentalWarning' &&
    warning.message ===
      'SQLite is an experimental feature and might change at any time'
  )
    return;
  for (const listener of warningListeners) listener.call(process, warning);
});

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const usageError =
    error instanceof UsageError || code.startsWith('ERR_PARSE_ARGS_');
  const dependencyError =
    error instanceof MediaError &&
    (/Required executable/.test(error.message) ||
      /Install ELUATE/.test(error.message));
  const errorCode =
    code ||
    (usageError
      ? 'INVALID_ARGUMENTS'
      : dependencyError
        ? 'MISSING_DEPENDENCY'
        : error instanceof MediaError
          ? 'PROCESSING_FAILED'
          : 'COMMAND_FAILED');
  const message = error instanceof Error ? error.message : String(error);
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const json = (separator === -1 ? args : args.slice(0, separator)).includes(
    '--json',
  );
  process.stderr.write(
    json
      ? JSON.stringify({
          ok: false,
          error: {
            code: errorCode,
            message,
            ...(usageError ? { hint: 'Run opencut --help for usage.' } : {}),
          },
        }) + '\n'
      : `opencut: ${message}\n`,
  );
  if (usageError && !json)
    process.stderr.write('Run opencut --help for usage.\n');
  process.exitCode ??= usageError ? 2 : 1;
}
