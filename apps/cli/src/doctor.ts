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
  localEnhancer,
} from '@opencut/media';
import { inspectSpeechRuntime } from './transcript.js';
import { inspectSystem } from './system.js';
import type { CommandOptions } from './commands.js';
import { UsageError } from './usage.js';

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
    'Install the matching Chromium Headless Shell using https://github.com/dante-teo/opencut/blob/main/docs/GRAPHICS.md#install-the-optional-react-browser.';
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

async function probeDoctor() {
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
  const result = {
    doctorVersion: 1,
    application: getApplicationInfo(),
    node: process.version,
    system,
    graphics,
    videoDefinitions: videoDefinitionFormats,
    graphicsCapabilities: videoGraphicsCapabilities,
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
  return { result, encoders };
}

type DoctorResult = Awaited<ReturnType<typeof probeDoctor>>['result'];

function capability(
  status: 'ready' | 'unavailable' | 'unsupported' | 'unverified',
  reason: string,
  nextStep: string | null = null,
) {
  return { status, reason, nextStep };
}

function processorCapability(
  system: DoctorResult['system']['videoToolbox'],
  worker: { status: string },
  name: string,
) {
  if (worker.status === 'unsupported' || system.status === 'not-applicable')
    return capability(
      'unsupported',
      'Requires Apple Silicon with macOS.',
      'Use an Apple Silicon Mac or omit this recipe.',
    );
  if (worker.status !== 'available')
    return capability(
      'unavailable',
      `Native worker: ${worker.status}.`,
      'Reinstall OpenCut or rebuild its native media workers.',
    );
  const inspect = 'Run opencut system inspect --json for processor details.';
  if (system.status !== 'probed')
    return capability('unverified', system.reason, inspect);
  const processor = system.frameProcessors[name];
  if (!processor)
    return capability('unverified', 'No configuration was reported.', inspect);
  if (processor.status === 'os-unavailable')
    return capability(
      'unavailable',
      `Requires macOS ${processor.minimumMacOS} or later.`,
      'Update macOS or choose another recipe.',
    );
  if (processor.status === 'hardware-unsupported')
    return capability(
      'unsupported',
      'VideoToolbox reports unsupported hardware.',
      'Use supported hardware or omit this recipe.',
    );
  const accepted =
    processor.testedSizes
      ?.flatMap(({ configurations }) => configurations)
      .filter(({ status }) => status === 'configuration-accepted') ?? [];
  if (!accepted.length)
    return capability(
      'unverified',
      'No sample configuration was accepted.',
      inspect,
    );
  if (
    accepted.every(
      ({ modelStatus }) =>
        modelStatus === 'downloading' || modelStatus === 'download-required',
    )
  )
    return capability(
      'unavailable',
      'Accepted configurations require a macOS-managed model download.',
      inspect,
    );
  return capability(
    'ready',
    'Native worker and sample configurations are available.',
    'Check the intended input and profile with opencut recipes validate.',
  );
}

async function compactDoctor() {
  const [{ result, encoders }, deepFilter] = await Promise.all([
    probeDoctor(),
    localEnhancer().then(
      () =>
        capability(
          'ready',
          'The local DeepFilterNet executable responds to its version check.',
        ),
      (error: unknown) =>
        capability(
          'unavailable',
          error instanceof Error ? error.message : String(error),
          'Check the deep-filter executable and any configured model path.',
        ),
    ),
  ]);
  const { media, ai, graphics, system } = result;
  const missingAudioTools = (['ffmpeg', 'ffprobe'] as const).filter(
    (tool) => media[tool].status !== 'available',
  );
  const audioUnavailable = missingAudioTools.length
    ? capability(
        'unavailable',
        `Required audio tools unavailable: ${missingAudioTools.join(', ')}.`,
        `Install or repair ${missingAudioTools.join(' and ')} on PATH.`,
      )
    : undefined;
  const encoder = (name: string) =>
    encoders.has(name)
      ? capability('ready', `FFmpeg lists the ${name} encoder.`)
      : capability(
          'unavailable',
          `FFmpeg did not report the ${name} encoder.`,
          `Use an FFmpeg build with ${name} on PATH.`,
        );
  const { workers } = ai.videoToolbox;
  const processor = (worker: keyof typeof workers, name: string) =>
    processorCapability(system.videoToolbox, workers[worker], name);
  const speech = ai.transcription;
  const speechModel = (ready: boolean, name: string) =>
    speech.runtime && ready
      ? capability('ready', `The local ${name} model and backend were found.`)
      : capability(
          'unavailable',
          `${name} model or runtime is missing.`,
          speech.hint ?? null,
        );
  const { dialogue } = ai;
  const readTool = (tool: typeof media.ffmpeg) =>
    tool.status === 'available'
      ? capability('ready', tool.version)
      : capability(
          'unavailable',
          `Executable status: ${tool.status}.`,
          tool.hint,
        );
  return {
    doctorVersion: result.doctorVersion,
    format: 'compact' as const,
    application: result.application,
    capabilities: {
      ffmpeg: readTool(media.ffmpeg),
      ffprobe: readTool(media.ffprobe),
      defaultMp4: media.ready
        ? capability(
            'ready',
            'FFmpeg, ffprobe, the default encoders and required memory sampling are available.',
          )
        : capability(
            'unavailable',
            media.missingEncoders.length
              ? `Missing encoders: ${media.missingEncoders.join(', ')}.`
              : 'A required export tool is unavailable.',
            media.hint,
          ),
      h264Encoding: encoder('libx264'),
      hevcEncoding: encoder('libx265'),
      aacEncoding: encoder('aac'),
      losslessPictureEncoding: encoder('ffv1'),
      offlineInterpolation: processor(
        'interpolation',
        'frame-rate-conversion-quality',
      ),
      lowLatencyInterpolation: processor(
        'interpolation',
        'low-latency-interpolation',
      ),
      superResolution: processor('enhancement', 'video-super-resolution'),
      lowLatencySuperResolution: processor(
        'enhancement',
        'low-latency-super-resolution',
      ),
      temporalDenoise: processor('enhancement', 'temporal-noise-filter'),
      dialogueSeparation:
        audioUnavailable ??
        (dialogue.ready
          ? capability(
              'ready',
              'ELUATE and the verified Bandit v2 checkpoint are available.',
            )
          : capability(
              'unavailable',
              `ELUATE: ${dialogue.backend.status}. Bandit v2 checkpoint: ${dialogue.model.status}.`,
              'Run opencut models inspect --json for setup details.',
            )),
      dialogueEnhancement: audioUnavailable ?? deepFilter,
      transcription:
        audioUnavailable ?? speechModel(speech.asrModel, 'transcription'),
      transcriptAlignment:
        audioUnavailable ?? speechModel(speech.alignerModel, 'alignment'),
      reactGraphics:
        graphics.status === 'available'
          ? capability(
              'ready',
              'The React graphics runtime and browser are installed.',
            )
          : capability(
              'unavailable',
              `React graphics: ${graphics.status}.`,
              graphics.hint,
            ),
    },
  };
}

function formatDoctor(result: DoctorResult) {
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

export async function runDoctor({ json, compact }: CommandOptions) {
  if (compact) {
    if (!json) throw new UsageError('--compact requires --json.');
    return console.log(JSON.stringify(await compactDoctor()));
  }
  const { result } = await probeDoctor();
  console.log(
    json
      ? JSON.stringify({ ...result, graphicsSchemas: videoGraphicsSchemas() })
      : formatDoctor(result),
  );
}
