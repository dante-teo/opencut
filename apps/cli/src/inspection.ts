import {
  isVideoDefinitionPath,
  parseSubtitleTime,
  previewVideo,
  watchVideo,
  VideoPreviewRangeError,
  type VideoWatchStatus,
} from '@opencut/core/video';
import { parseRenderQuality } from './render-options.js';
import { parseProcessingControls } from './recipe-options.js';
import { commandUsage, type CommandOptions } from './commands.js';
import { UsageError } from './usage.js';
import { withCommandCancellation } from './cancellation.js';
import { readParams } from './json-argument.js';
import { readMixControls } from './mix-options.js';
import { loadVideo } from './video.js';

function printWatchStatus(
  { current, ...event }: VideoWatchStatus,
  json: boolean | undefined,
) {
  if (json) {
    console.log(
      JSON.stringify({
        ...event,
        current: current && {
          generation: current.generation,
          sourceRevision: current.sourceRevision,
          path: current.playback.path,
          frameCount: current.playback.frameCount,
          quality: current.playback.quality,
        },
      }),
    );
  } else if (event.status === 'error') {
    console.error(`Revision ${event.generation}: ${event.error}`);
    if (current)
      console.error(
        `Still showing revision ${current.generation}: ${current.playback.path}`,
      );
  } else if (event.status === 'ready' && current) {
    console.log(
      `Revision ${current.generation} (${current.sourceRevision.slice(0, 12)}): ${current.playback.path}`,
    );
  } else {
    console.log(`Revision ${event.generation}: ${event.status}`);
  }
}

type InspectionCommand =
  | 'preview'
  | 'timeline inspect'
  | 'preview frame'
  | 'preview contact-sheet'
  | 'preview clip';

export async function runInspectionCommand(
  command: InspectionCommand,
  file: string,
  values: CommandOptions,
) {
  if (!isVideoDefinitionPath(file))
    throw new UsageError('Choose a .video.ts definition.');
  const quality = parseRenderQuality(
    values.quality,
    command === 'timeline inspect' ? 'quality' : 'fast',
  );
  const processing = parseProcessingControls(values);
  if (command === 'preview') {
    if (!values.watch) throw new UsageError(`Usage: ${commandUsage(command)}`);
    const maxDimension = Number(values.size ?? 640);
    if (
      !/^\d+$/.test(values.size ?? '640') ||
      maxDimension < 64 ||
      maxDimension > 1920
    )
      throw new UsageError('--size must be between 64 and 1920.');
    return withCommandCancellation(async (signal) => {
      const watcher = await watchVideo(file, {
        ...(await readMixControls(values, signal)),
        maxDimension,
        quality,
        processing,
        signal,
        onStatus: (event) => printWatchStatus(event, values.json),
      });
      try {
        if (!signal.aborted)
          await new Promise<void>((done) =>
            signal.addEventListener('abort', () => done(), { once: true }),
          );
      } finally {
        await watcher.close();
      }
    });
  }
  if (
    [file, values.output ?? ''].some((arg) =>
      Array.from(arg).some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new UsageError(`Usage: ${commandUsage(command)}`);
  const integer = (
    key: 'frame' | 'from' | 'to' | 'size' | 'count' | 'columns',
    fallback?: number,
  ): number => {
    const value = values[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (
      value === undefined ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new UsageError(
        `--${key} requires a nonnegative safe integer project-frame index or count.`,
      );
    return Number(value);
  };
  if (values.timestamp !== undefined && values.frame !== undefined)
    throw new UsageError('Choose either --timestamp or --frame.');
  let selectedFrame: ReturnType<typeof parseSubtitleTime> | number | undefined;
  if (values.timestamp !== undefined) {
    try {
      selectedFrame = parseSubtitleTime(values.timestamp);
    } catch {
      throw new UsageError(
        '--timestamp requires nonnegative timeline seconds (decimal, clock time or fraction).',
      );
    }
  } else if (command === 'timeline inspect' || command === 'preview frame') {
    selectedFrame = integer('frame');
  }
  const preview = command !== 'timeline inspect';
  const sheet = command === 'preview contact-sheet';
  if (
    preview &&
    (!values.output ||
      !values.output
        .toLowerCase()
        .endsWith(command === 'preview clip' ? '.mp4' : '.png'))
  )
    throw new UsageError(`Usage: ${commandUsage(command)}`);
  const size = values.size === undefined ? undefined : integer('size');
  if (size !== undefined && (size < 64 || size > (sheet ? 640 : 1920)))
    throw new UsageError(
      `--size must be between 64 and ${sheet ? 640 : 1920}.`,
    );
  // Validate required ranges before file access, like other CLI argument errors.
  const requestedFrom =
    sheet || command === 'preview clip'
      ? integer('from', sheet ? 0 : undefined)
      : undefined;
  const requestedTo = command === 'preview clip' ? integer('to') : undefined;
  await withCommandCancellation(async (signal) => {
    const { audioMixEdit, ...mixControls } = await readMixControls(
      values,
      signal,
    );
    const video = await loadVideo(file, {
      audioMixEdit,
      signal,
      preview: true,
      quality,
      processing,
      params: await readParams(values.params, signal),
    });
    const tools = previewVideo(video);
    if (command === 'timeline inspect') {
      console.log(JSON.stringify(tools.inspectFrame(selectedFrame!), null, 2));
      return;
    }
    const options = { signal, maxDimension: size, quality };
    const startFrame = requestedFrom ?? 0;
    const endFrame = requestedTo ?? integer('to', tools.frameCount);
    const result =
      command === 'preview frame'
        ? await tools.frame(selectedFrame!, values.output!, options)
        : sheet
          ? await tools.contactSheet({ startFrame, endFrame }, values.output!, {
              ...options,
              ...(values.count !== undefined && { count: integer('count') }),
              ...(values.columns !== undefined && {
                columns: integer('columns'),
              }),
            })
          : await tools.clip({ startFrame, endFrame }, values.output!, {
              ...options,
              ...mixControls,
              onProgress: (progress) =>
                process.stderr.write(
                  values.json
                    ? `${JSON.stringify(progress)}\n`
                    : `${progress.phase}: ${progress.percent.toFixed(1)}%\n`,
                ),
            });
    console.log(JSON.stringify(result, null, 2));
  }).catch((error: unknown) => {
    if (error instanceof VideoPreviewRangeError)
      throw new UsageError(error.message);
    throw error;
  });
}
