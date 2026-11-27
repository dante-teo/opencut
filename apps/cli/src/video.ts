import { Console } from 'node:console';
import { withExportProgress } from '@opencut/media';
import type { RenderProgress } from '@opencut/media';
import {
  analyzeVideoMix,
  beautyReports,
  compileVideo,
  describeProjectContactTimeline,
  inspectProject,
  inspectVideoRecipes,
  inspectVideoLayout,
  isVideoDefinitionPath,
  planVideoRender,
  renderCompiledVideo,
} from '@opencut/core/video';
import type { VideoProcessingProgress } from '@opencut/core/video';
import { writeRenderProgress } from './render-progress.js';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage, type CommandOptions } from './commands.js';
import { parseProcessingControls } from './recipe-options.js';
import { UsageError } from './usage.js';
import { readParams } from './json-argument.js';
import { parseRenderControls, parseRenderQuality } from './render-options.js';

import { readMixControls } from './mix-options.js';

type VideoCommand =
  | 'validate'
  | 'inspect'
  | 'render'
  | 'render plan'
  | 'mix analyze'
  | 'recipes inspect'
  | 'recipes validate';

/** Route console output from trusted TypeScript to stderr during CLI compilation. */
export function loadVideo(
  file: string,
  options: Parameters<typeof compileVideo>[1],
) {
  return withDefinitionConsole(() => compileVideo(file, options));
}

export async function withDefinitionConsole<T>(run: () => Promise<T>) {
  const console = globalThis.console;
  globalThis.console = new Console(process.stderr);
  try {
    return await run();
  } finally {
    globalThis.console = console;
  }
}

export function runVideoCommand(
  command: VideoCommand,
  file: string,
  values: CommandOptions,
) {
  if (!isVideoDefinitionPath(file))
    throw new UsageError('Choose a .video.ts definition.');
  const { output } = values;
  if (
    (command === 'render' || command === 'render plan') &&
    !output?.toLowerCase().endsWith('.mp4')
  )
    throw new UsageError(`Usage: ${commandUsage(command)}`);

  if (values['revision-evidence'] && !values.json)
    throw new UsageError(
      '--revision-evidence requires --json so the report can be retained.',
    );
  const pictureCacheDirectory = values['picture-cache'];
  const pictureVersion = values['picture-version'];
  if (pictureCacheDirectory !== undefined && !pictureCacheDirectory.trim())
    throw new UsageError('--picture-cache requires a directory.');
  if (pictureVersion !== undefined && !pictureCacheDirectory)
    throw new UsageError('--picture-version requires --picture-cache.');
  const controls =
    command === 'render' ||
    command === 'render plan' ||
    command === 'mix analyze'
      ? parseRenderControls(values)
      : {};
  const progress =
    command === 'render'
      ? (event: RenderProgress) => {
          // Keep immediate preflight errors as a single JSON record.
          if (values.json && event.stage === 'preparation' && !event.heartbeat)
            return;
          writeRenderProgress(event, values.json);
        }
      : undefined;
  return withExportProgress(progress, (onProgress) =>
    executeVideoCommand(command, file, values, controls, onProgress),
  );
}

async function executeVideoCommand(
  command: VideoCommand,
  file: string,
  values: CommandOptions,
  controls: ReturnType<typeof parseRenderControls>,
  onProgress?: (event: RenderProgress) => void,
) {
  const {
    output,
    'picture-cache': pictureCacheDirectory,
    'picture-version': pictureVersion,
  } = values;
  await withCommandCancellation(async (signal) => {
    const params = await readParams(values.params, signal);
    if (command === 'recipes inspect' || command === 'recipes validate') {
      const result = await withDefinitionConsole(() =>
        inspectVideoRecipes(file, {
          signal,
          params,
          quality: parseRenderQuality(values.quality, 'quality'),
        }),
      );
      if (command === 'recipes inspect')
        console.log(JSON.stringify(result, null, 2));
      else if (values.json)
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else
        console.log(
          `Valid media recipes (${result.recipes.length} assets): ${result.path}`,
        );
      return;
    }
    const processing = parseProcessingControls(values);
    const recipeProcessing: VideoProcessingProgress[] = [];
    processing.onProgress = (event) => {
      if (values.json) {
        if (event.status === 'completed' || event.status === 'cache-hit')
          recipeProcessing.push(event);
        if (command === 'render')
          process.stderr.write(
            JSON.stringify({ event: 'progress', stage: 'recipe', ...event }) +
              '\n',
          );
      } else {
        const time =
          event.seconds === undefined ? '' : ` (${event.seconds.toFixed(2)}s)`;
        process.stderr.write(
          `recipe ${event.assetId} step ${event.step + 1}: ${event.status}${time}\n`,
        );
      }
    };
    const { audioMixEdit, musicSelection, ...mixControls } =
      await readMixControls(values, signal);
    if (command === 'render plan') {
      const plan = await withDefinitionConsole(() =>
        planVideoRender(file, output!, {
          ...controls,
          ...mixControls,
          processing,
          audioMixEdit,
          musicSelection,
          params,
          signal,
          pictureCacheDirectory,
          pictureVersion,
        }),
      );
      console.log(JSON.stringify(plan, null, 2));
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    const video = await loadVideo(file, {
      signal,
      params,
      preview: controls.burnSubtitles === false,
      quality: controls.quality,
      processing,
      audioMixEdit,
      musicSelection,
    });
    const beauty = beautyReports(video.recipes);
    if (command === 'mix analyze') {
      const report = await analyzeVideoMix(video, {
        ...controls,
        ...mixControls,
        signal,
      });
      console.log(JSON.stringify(report, null, 2));
    } else if (command === 'validate') {
      const layout = video.layoutAssertions?.length
        ? await inspectVideoLayout(video, { signal })
        : undefined;
      const executableGraphics = video.project.assets.flatMap(
        ({ id, file, metadata }) =>
          metadata?.kind === 'graphic' && metadata.formatName === 'react'
            ? [{ id, path: file.path }]
            : [],
      );
      const graphicKinds = video.project.assets.flatMap(({ metadata }) =>
        metadata?.kind === 'graphic' ? [metadata.formatName] : [],
      );
      const graphics = graphicKinds.some((kind) => kind !== 'svg')
        ? await (await import('./doctor.js')).inspectReactGraphics()
        : undefined;
      const result = {
        ok: layout?.ok ?? true,
        path: video.path,
        frameCount: video.frameCount,
        ...(beauty.length && { beauty }),
        ...(graphics && { graphics }),
        ...(executableGraphics.length && { executableGraphics }),
        ...(layout && { layout }),
      };
      console.log(
        values.json
          ? JSON.stringify(result, null, 2)
          : `${result.ok ? 'Valid' : 'Layout assertions failed for'} video definition (${result.frameCount} frames): ${result.path}` +
              (layout?.checks
                .filter(({ passed }) => !passed)
                .map(
                  ({ assertionId, objectId, frame, deviationPixels, reason }) =>
                    `\n  ${assertionId} / ${objectId ?? '(no object)'} at frame ${frame ?? 'n/a'}: ${reason ?? `${deviationPixels?.toFixed(2)} px deviation`}`,
                )
                .join('') ?? '') +
              (graphics?.hint ? `\nReact graphics: ${graphics.hint}` : ''),
      );
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'inspect') {
      console.log(
        JSON.stringify(
          {
            ...inspectProject(video.project, video.path),
            ...(video.recipes.length > 0 && { recipes: video.recipes }),
          },
          null,
          2,
        ),
      );
    } else {
      const result = await renderCompiledVideo(video, output!, {
        ...controls,
        revisionEvidence: values['revision-evidence'],
        pictureCacheDirectory,
        pictureVersion,
        ...mixControls,
        signal,
        ...(onProgress && { onProgress }),
      });
      if (values.json)
        console.log(
          JSON.stringify(
            {
              definitionPath: video.path,
              contactTimeline: describeProjectContactTimeline(video.project),
              ...result,
              ...(recipeProcessing.length > 0 && { recipeProcessing }),
            },
            null,
            2,
          ),
        );
      else {
        for (const effect of beauty)
          if (effect.status === 'completed-with-limitations')
            process.stderr.write(
              "Beauty limitations for '" +
                effect.assetId +
                "'. View interval details in the JSON render report.\n",
            );
        console.log(`Encoder ${result.encoder.name}`);
        if (result.encoder.fallbackReason)
          process.stderr.write(
            `Encoder fallback: ${result.encoder.fallbackReason}\n`,
          );
        for (const warning of result.warnings ?? [])
          process.stderr.write(`Warning: ${warning}\n`);
        for (const { startFrame, endFrame, status } of result.pictureRanges ??
          [])
          console.log(`Picture [${startFrame}, ${endFrame}): ${status}`);
        if (result.pictureVersion)
          console.log(
            `Picture version ${result.pictureVersion.id} (${result.pictureVersion.status})`,
          );
        const music = result.musicComparison;
        if (music) {
          const candidate = music.candidates.find(
            ({ trackId }) => trackId === music.selected,
          )!;
          console.log(`Music: ${candidate.name}`);
          for (const source of candidate.sources)
            console.log(
              `  ${source.path}${source.reusedInProject ? ' (also used in this project)' : ''}`,
            );
          if (candidate.previouslyUsedIn.length)
            console.log(
              `  Previous deliveries: ${candidate.previouslyUsedIn.join(', ')}`,
            );
        }
        if (result.audioMix) {
          const { integratedLufs, truePeakDbtp } = result.audioMix.output;
          console.log(
            `Audio ${integratedLufs ?? 'unmeasurable'} LUFS / ${truePeakDbtp ?? 'unmeasurable'} dBTP`,
          );
        }
        console.log(`Saved ${result.frameCount} frames to ${result.path}`);
      }
    }
  }).catch((error: unknown) => {
    if (command === 'render' && [130, 143].includes(Number(process.exitCode)))
      process.stderr.write(
        values.json
          ? JSON.stringify({ event: 'render-status', status: 'cancelled' }) +
              '\n'
          : 'Render cancelled.\n',
      );
    throw error;
  });
}
