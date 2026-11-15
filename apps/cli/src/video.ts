import { Console } from 'node:console';
import {
  compileVideo,
  inspectProject,
  isVideoDefinitionPath,
  renderCompiledVideo,
} from '@opencut/core/video';
import type { RenderProgress } from '@opencut/media';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage, type CommandOptions } from './commands.js';
import { UsageError } from './usage.js';
import { parseRenderControls } from './render-options.js';

type VideoCommand = 'validate' | 'inspect' | 'render';

/** Route console output from trusted TypeScript to stderr during CLI compilation. */
export async function loadVideo(
  file: string,
  options: Parameters<typeof compileVideo>[1],
) {
  const console = globalThis.console;
  globalThis.console = new Console(process.stderr);
  try {
    return await compileVideo(file, options);
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
    const video = await loadVideo(file, {
      signal,
      preview: controls.burnSubtitles === false,
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
        JSON.stringify(inspectProject(video.project, video.path), null, 2),
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
          JSON.stringify({ definitionPath: video.path, ...result }, null, 2),
        );
      else {
        for (const warning of result.warnings ?? [])
          process.stderr.write(`Warning: ${warning}\n`);
        console.log(`Saved ${result.frameCount} frames to ${result.path}`);
      }
    }
  });
}
