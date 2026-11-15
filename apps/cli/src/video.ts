import { Console } from 'node:console';
import {
  compileVideo,
  inspectProject,
  inspectVideoRecipes,
  isVideoDefinitionPath,
  renderCompiledVideo,
} from '@opencut/core/video';
import type { VideoProcessingProgress } from '@opencut/core/video';
import type { RenderProgress } from '@opencut/media';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage, type CommandOptions } from './commands.js';
import { parseProcessingControls } from './recipe-options.js';
import { UsageError } from './usage.js';
import { readParams } from './json-argument.js';
import { parseRenderControls } from './render-options.js';

type VideoCommand =
  'validate' | 'inspect' | 'render' | 'recipes inspect' | 'recipes validate';

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

export async function runVideoCommand(
  command: VideoCommand,
  file: string,
  values: CommandOptions,
) {
  if (!isVideoDefinitionPath(file))
    throw new UsageError('Choose a .video.ts or .video.json definition.');
  const { output } = values;
  if (command === 'render' && !output?.toLowerCase().endsWith('.mp4'))
    throw new UsageError(`Usage: ${commandUsage(command)}`);

  const controls = command === 'render' ? parseRenderControls(values) : {};
  await withCommandCancellation(async (signal) => {
    const params = await readParams(values.params, signal);
    if (command === 'recipes inspect' || command === 'recipes validate') {
      const result = await withDefinitionConsole(() =>
        inspectVideoRecipes(file, { signal, params }),
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
      } else {
        const time =
          event.seconds === undefined ? '' : ` (${event.seconds.toFixed(2)}s)`;
        process.stderr.write(
          `recipe ${event.assetId} step ${event.step + 1}: ${event.status}${time}\n`,
        );
      }
    };
    const video = await loadVideo(file, {
      signal,
      params,
      preview: controls.burnSubtitles === false,
      processing,
    });
    if (command === 'validate') {
      const result = {
        ok: true,
        path: video.path,
        frameCount: video.frameCount,
      };
      console.log(
        values.json
          ? JSON.stringify(result, null, 2)
          : `Valid video definition (${result.frameCount} frames): ${result.path}`,
      );
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
        signal,
        ...(!values.json && {
          onProgress: (event: RenderProgress) => {
            process.stderr.write(
              `${event.phase}: ${event.percent.toFixed(1)}%\n`,
            );
          },
        }),
      });
      if (values.json)
        console.log(
          JSON.stringify(
            {
              definitionPath: video.path,
              ...result,
              ...(recipeProcessing.length > 0 && { recipeProcessing }),
            },
            null,
            2,
          ),
        );
      else {
        for (const warning of result.warnings ?? [])
          process.stderr.write(`Warning: ${warning}\n`);
        console.log(`Saved ${result.frameCount} frames to ${result.path}`);
      }
    }
  });
}
