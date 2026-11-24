import { delimiter, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getApplicationInfo } from '@opencut/core';
import {
  videoDefinitionFormats,
  videoGraphicsCapabilities,
  videoGraphicsSchemas,
} from '@opencut/core/video';
import {
  inspectDialogueModel,
  inspectGraphicsRuntime,
  inspectRenderMemory,
  inspectVideoToolboxWorkers,
} from '@opencut/media';
import { inspectSpeechRuntime } from './transcript.js';
import { inspectSystem } from './system.js';

const exec = promisify(execFile);
const options = { timeout: 5000, maxBuffer: 1024 * 1024 };
const installHint =
  'Install FFmpeg and ffprobe on PATH. Use an FFmpeg build with libx264 and AAC for default MP4 exports.';

async function inspectExecutable(tool: 'ffmpeg' | 'ffprobe') {
  // An empty or relative PATH component is relative to the caller's directory.
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(
    delimiter,
  )) {
    const path = isAbsolute(directory)
      ? join(directory, tool)
      : join(process.cwd(), directory, tool);
    try {
      const { stdout } = await exec(path, ['-version'], options);
      return {
        status: 'available' as const,
        path,
        version: stdout.split('\n')[0] ?? '',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES')
        return { status: 'unavailable' as const, path, hint: installHint };
    }
  }
  return { status: 'missing' as const, hint: installHint };
}

export async function inspectReactGraphics() {
  const hint =
    'Install the matching headless Chromium with pnpm dlx playwright-core@1.64.1 install --only-shell chromium.';
  try {
    const { installed, backend, path, adapters } =
      await inspectGraphicsRuntime();
    return {
      status: installed ? ('available' as const) : ('missing-browser' as const),
      backend,
      path,
      adapters,
      ...(!installed && { hint }),
    };
  } catch {
    return {
      status: 'missing-runtime' as const,
      hint: 'Install an OpenCut build with React graphics support.',
    };
  }
}

export async function doctor() {
  const [
    ffmpeg,
    ffprobe,
    rssHelper,
    system,
    workers,
    dialogue,
    graphics,
    transcription,
  ] = await Promise.all([
    inspectExecutable('ffmpeg'),
    inspectExecutable('ffprobe'),
    inspectRenderMemory(),
    inspectSystem(),
    inspectVideoToolboxWorkers(),
    inspectDialogueModel(),
    inspectReactGraphics(),
    inspectSpeechRuntime(),
  ]);
  const { stdout } =
    ffmpeg.status === 'available'
      ? await exec(ffmpeg.path, ['-hide_banner', '-encoders'], options).catch(
          () => ({ stdout: '' }),
        )
      : { stdout: '' };
  const encoders = new Set(
    [...stdout.matchAll(/^ [VAS][A-Z.]{5}\s+(\S+)/gm)].map((entry) => entry[1]),
  );
  const missingEncoders = ['libx264', 'aac'].filter(
    (name) => !encoders.has(name),
  );
  const toolsReady =
    ffmpeg.status === 'available' &&
    ffprobe.status === 'available' &&
    !missingEncoders.length;
  const hint = [
    ...(!toolsReady ? [installHint] : []),
    ...('hint' in rssHelper ? [rssHelper.hint] : []),
  ].join(' ');
  return {
    doctorVersion: 1,
    application: getApplicationInfo(),
    node: process.version,
    system,
    graphics,
    videoDefinitions: videoDefinitionFormats,
    graphicsCapabilities: videoGraphicsCapabilities,
    graphicsSchemas: videoGraphicsSchemas(),
    media: {
      ready: !hint,
      ffmpeg,
      ffprobe,
      rssHelper,
      missingEncoders,
      hevc: encoders.has('libx265'),
      ...(hint && { hint }),
    },
    ai: {
      videoToolbox: {
        workers,
        models: 'managed-by-macos',
        configurations:
          system.videoToolbox.status === 'probed'
            ? system.videoToolbox.frameProcessors
            : null,
      },
      dialogue,
      transcription,
    },
  };
}

export function formatDoctor(result: Awaited<ReturnType<typeof doctor>>) {
  return [
    'OpenCut ' +
      result.application.version +
      ' (' +
      result.system.os.platform +
      '/' +
      result.system.architecture.process +
      ')',
    'FFmpeg: ' + result.media.ffmpeg.status,
    'ffprobe: ' + result.media.ffprobe.status,
    ...(result.media.rssHelper.status === 'not-applicable'
      ? []
      : ['RSS helper: ' + result.media.rssHelper.status]),
    'Default MP4 export: ' + (result.media.ready ? 'ready' : result.media.hint),
    'VideoToolbox: ' + result.system.videoToolbox.status,
    'Bandit v2 dialogue model: ' + result.ai.dialogue.model.status,
    'Local speech backend: ' + result.ai.transcription.status,
    'React graphics: ' +
      result.graphics.status +
      ('hint' in result.graphics && result.graphics.hint
        ? ' · ' + result.graphics.hint
        : ''),
    'Run opencut doctor --json for hardware, AI configurations and runtime details.',
  ].join('\n');
}
