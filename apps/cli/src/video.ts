import { Console } from 'node:console';
import { parseArgs } from 'node:util';
import { inspectProject } from '@opencut/core';
import { compileVideo, isVideoDefinitionPath } from '@opencut/core/node';
import { renderVideoTimeline } from '@opencut/media';
import type { RenderProgress } from '@opencut/media';
import { withCommandCancellation } from './cancellation.js';
import { discovery } from './discovery.js';
import { UsageError } from './timeline.js';

export const videoUsage = {
  validate:
    'Usage: opencut validate <definition.video.ts|definition.video.json> [--json]',
  inspect:
    'Usage: opencut inspect <definition.video.ts|definition.video.json> [--json]',
  render:
    'Usage: opencut render <definition.video.ts|definition.video.json> --output <new.mp4> [--json]',
};

export function isVideoCommand(
  command: string | undefined,
): command is keyof typeof videoUsage {
  return command !== undefined && Object.hasOwn(videoUsage, command);
}

/** Route console output from trusted TypeScript to stderr during CLI compilation. */
export async function loadVideo(file: string, signal?: AbortSignal) {
  const console = globalThis.console;
  globalThis.console = new Console(process.stderr);
  try {
    return await compileVideo(file, { signal });
  } finally {
    globalThis.console = console;
  }
}

export async function runVideoCommand(
  command: keyof typeof videoUsage,
  args: string[],
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      values.json
        ? JSON.stringify(discovery([command], videoUsage[command]), null, 2)
        : videoUsage[command],
    );
    return;
  }
  const [file] = positionals;
  if (positionals.length !== 1 || !file || !isVideoDefinitionPath(file))
    throw new UsageError(videoUsage[command]);
  if (command !== 'render' && values.output !== undefined)
    throw new UsageError(`--output does not apply to ${command}.`);
  if (command === 'render' && !values.output?.toLowerCase().endsWith('.mp4'))
    throw new UsageError(videoUsage.render);

  await withCommandCancellation(async (signal) => {
    const video = await loadVideo(file, signal);
    if (command === 'validate') {
      const result = {
        ok: true,
        path: video.path,
        frameCount: video.project.settings.durationFrames,
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
      const result = await renderVideoTimeline({
        ...(await video.resolveRender()),
        output: values.output!,
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
