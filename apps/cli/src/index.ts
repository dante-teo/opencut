#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { editHelp, runEditCommand } from './edit.js';
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
  importMediaAsset,
  listMediaAssets,
  readProjectFile,
  renderProjectFile,
  removeMediaAsset,
  validateProjectFile,
  writeProjectFile,
} from '@opencut/core/node';
import type { AssetInfo } from '@opencut/core/node';
import { composeMedia, extractFrame, probeMedia } from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';

const help = `Usage: opencut [command] [options]

OpenCut — project, media asset and timeline editing, transactions and headless rendering (T10).

Commands:
  project create <project-file> --name <name> [--width <px>] [--height <px>] [--fps <n|n/d>]
                                       Create a new project without overwriting
  project info <project-file>           Show metadata, settings and statistics
  project validate <project-file>       Check project data and media references
  project render <project-file> --output <new.mp4>
                                       Render one video track with black gaps (no audio)
  media import <project-file> <file>    Import a source reference and probe metadata
  media list <project-file>             List assets, metadata and source availability
  media info <project-file> <asset-id>   Inspect an asset by stable ID
  media remove <project-file> <asset-id> Remove an unreferenced asset, keeping its file
  timeline list <project-file>          Inspect tracks, clips and exact timing
  track add|remove <project-file>       Manage video/audio tracks (track --help)
  clip add|move|trim|split|remove <project-file>
                                       Edit clips (clip --help; time arguments are frames)
  edit apply <project-file> <batch.json> Apply an atomic transaction
  edit undo|redo|history <project-file>  Restore or inspect persistent editing history
  probe <file>                         Inspect local media metadata
  extract-frame <file> --timestamp <s> --output <file.png>
                                       Extract one PNG frame, without overwriting
  compose <clip1> <clip2> [more clips] --music <audio> --output <new.mp4>
                                       Concatenate video and mix background music

Options:
  -h, --help     Show this help
  -v, --version  Show the application version
  --json        Print requested output as JSON
  --dry-run     Validate editing/media mutations without saving
  --expected-revision <n> Reject a stale editing/media mutation
  --name        Nonblank project or track name (project create / track add)
  --timestamp   Frame timestamp in nonnegative decimal seconds
  --output      New PNG/MP4 output path (parent directory must exist)
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
Exit codes: 0 success, 1 validation/runtime/file/media failure, 2 invalid arguments.
`;

const projectHelp = {
  render: `Usage: opencut project render <project-file> --output <new.mp4> [--json] [--help]

Render exactly one video track to H.264 MP4 at project resolution and rational frame rate.
Gaps are black. Source audio is omitted; audio/additional tracks and still images are rejected.
Times must align to project frames; source points use the first video frame as zero.
Supports even dimensions up to 3840x2160, 1–120 fps, 64 clips and 600 seconds.
Requires FFmpeg 8+ and ffprobe. Output must be new, in an existing directory.
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
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
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
      music: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      fps: { type: 'string' },
      'clip-volume': { type: 'string' },
      'music-volume': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: false,
  });
  const [command, file, projectFile] = positionals;
  const timelineCommand = ['timeline', 'track', 'clip'].includes(command ?? '');
  const projectCommand =
    command === 'project' &&
    file !== undefined &&
    Object.hasOwn(projectHelp, file)
      ? (file as keyof typeof projectHelp)
      : undefined;
  const mediaCommand =
    command === 'media' && file !== undefined && Object.hasOwn(mediaHelp, file)
      ? (file as keyof typeof mediaHelp)
      : undefined;
  if (values.help || args.length === 0) {
    const usage =
      command === 'edit'
        ? editHelp
        : timelineCommand
          ? timelineHelp
          : command === 'project'
            ? projectCommand
              ? projectHelp[projectCommand]
              : `Usage: opencut project <create|info|validate|render> <project-file> [options]\n\n${Object.values(projectHelp).join('\n')}`
            : command === 'media'
              ? mediaCommand
                ? mediaHelp[mediaCommand]
                : `Usage: opencut media <import|list|info|remove> <project-file> [file|asset-id] [--json]\n\n${Object.values(mediaHelp).join('\n')}`
              : help;
    output({ help: usage }, usage, values.json);
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
  for (const option of ['type', 'track', 'at', 'in', 'out'] as const) {
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
      positionals.length !== (mediaCommand === 'list' ? 3 : 4) ||
      !projectFile?.trim() ||
      (mediaCommand !== 'list' && !argument?.trim())
    )
      throw new UsageError(
        'Expected media import <project-file> <file>, media list <project-file>, or media info|remove <project-file> <asset-id>.',
      );
    const allowed = [
      'json',
      ...(['import', 'remove'].includes(mediaCommand)
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
      [projectFile, argument ?? ''].some((value) =>
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
    if (projectCommand === 'render') {
      if (
        !values.output?.trim() ||
        !values.output.toLowerCase().endsWith('.mp4')
      )
        throw new UsageError('project render requires --output <new.mp4>.');
      const result = await renderProjectFile(path, values.output);
      output(
        result,
        `Saved ${result.frameCount} frames (${result.width}x${result.height}, ${result.frameRate.numerator}/${result.frameRate.denominator} fps, H.264, video only) to ${result.path}\n`,
        values.json,
      );
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

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const usageError =
    error instanceof UsageError || code.startsWith('ERR_PARSE_ARGS_');
  process.stderr.write(
    `opencut: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (usageError) process.stderr.write('Run opencut --help for usage.\n');
  process.exitCode = usageError ? 2 : 1;
}
