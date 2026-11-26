import {
  isVideoDefinitionPath,
  beautyReports,
  inspectGraphicFrames,
  inspectDeclaredTimeline,
  parseSubtitleTime,
  inspectVideoRecipes,
  VideoDefinitionError,
  videoRecipeCacheDirectory,
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
import { writeRenderProgress } from './render-progress.js';
import { loadVideo, withDefinitionConsole } from './video.js';

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
  'preview' | 'timeline inspect' | 'preview frame' | 'preview clip';

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
        params: await readParams(values.params, signal),
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
  const integer = (key: 'frame' | 'from' | 'to' | 'size'): number => {
    const value = values[key];
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
  if (
    preview &&
    (!values.output ||
      !values.output
        .toLowerCase()
        .endsWith(command === 'preview clip' ? '.mp4' : '.png'))
  )
    throw new UsageError(`Usage: ${commandUsage(command)}`);
  const size = values.size === undefined ? undefined : integer('size');
  if (size !== undefined && (size < 64 || size > 1920))
    throw new UsageError('--size must be between 64 and 1920.');
  // Validate required ranges before file access, like other CLI argument errors.
  const range =
    command === 'preview clip'
      ? { startFrame: integer('from'), endFrame: integer('to') }
      : undefined;
  await withCommandCancellation(async (signal) => {
    const params = await readParams(values.params, signal);
    if (command === 'timeline inspect' && values['metadata-only']) {
      const report = await withDefinitionConsole(() =>
        inspectDeclaredTimeline(file, selectedFrame!, { params, signal }),
      );
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const { audioMixEdit, musicSelection, ...mixControls } =
      await readMixControls(values, signal);
    const video = await loadVideo(file, {
      audioMixEdit,
      musicSelection,
      signal,
      preview: true,
      quality,
      processing,
      params,
    }).catch(async (error: unknown) => {
      const cache = videoRecipeCacheDirectory(processing.cacheDirectory);
      if (
        command !== 'timeline inspect' ||
        !(error instanceof Error) ||
        (!/SQLITE_READONLY|unable to open database file/i.test(error.message) &&
          !(
            /EACCES|EPERM|EROFS/.test(error.message) &&
            error.message.includes(cache)
          ))
      )
        throw error;
      const recipes = await withDefinitionConsole(() =>
        inspectVideoRecipes(file, { params, signal, quality }),
      ).catch(() => undefined);
      const ids = recipes?.recipes.map(({ assetId }) => assetId).join(', ');
      throw new VideoDefinitionError(
        `Resolved inspection needs a writable cache at ${cache}${ids ? ` for recipes ${ids}` : ''}. Choose --recipe-cache <writable-directory> or use --metadata-only. ${error.message}`,
        { cause: error },
      );
    });
    const tools = previewVideo(video);
    if (command === 'timeline inspect') {
      const report = await tools.inspectFraming(
        tools.inspectFrame(selectedFrame!),
        signal,
      );
      const graphics = await inspectGraphicFrames(video, report.frame);
      console.log(
        JSON.stringify(
          {
            ...report,
            mode: 'resolved',
            evidence: {
              timeline: 'resolved',
              media: 'resolved',
              graphics: graphics.length ? 'resolved' : 'unavailable',
            },
            ...(graphics.length && { graphics }),
          },
          null,
          2,
        ),
      );
      return;
    }
    const options = { signal, maxDimension: size, quality };
    const result =
      command === 'preview frame'
        ? await tools.frame(selectedFrame!, values.output!, options)
        : await tools.clip(range!, values.output!, {
            ...options,
            ...mixControls,
            onProgress: (progress) =>
              writeRenderProgress(progress, values.json),
          });
    const beauty = beautyReports(video.recipes);
    console.log(
      JSON.stringify({ ...result, ...(beauty.length && { beauty }) }, null, 2),
    );
  }).catch((error: unknown) => {
    if (error instanceof VideoPreviewRangeError)
      throw new UsageError(error.message);
    throw error;
  });
}
