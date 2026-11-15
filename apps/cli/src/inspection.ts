import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  inspectProject,
  inspectTimeline,
  parseSubtitleTime,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  isVideoDefinitionPath,
  readProjectFile,
  readVideoJsonForPreview,
  previewProject,
  previewFrameIndex,
  previewVideo,
  watchVideo,
  VideoPreviewRangeError,
} from '@opencut/core/node';
import type { RenderQuality } from '@opencut/media';
import type { VideoWatchStatus } from '@opencut/core/node';
import { UsageError } from './timeline.js';
import { withCommandCancellation } from './cancellation.js';
import { discovery } from './discovery.js';
import { loadVideo } from './video.js';

export const inspectionHelp = `Usage: opencut project inspect <project-file> [--json]
       opencut timeline inspect <project-or-definition> (--frame <n> | --timestamp <time>) [--json]
       opencut preview <definition.video.ts|definition.video.json> --watch [--size <64..1920>] [--json]
       opencut preview frame <project-file|definition.video.ts|definition.video.json> (--frame <n> | --timestamp <time>) --output <new.png> [--size <64..1920>] [--json]
       opencut preview contact-sheet <project-or-definition> --output <new.png> [--from <n>] [--to <n>] [--count <1..16>] [--columns <1..16>] [--size <64..640>] [--json]
       opencut preview clip <project-or-definition> --from <n> --to <n> --output <new.mp4> [--size <64..1920>] [--quality <draft|balanced|high>] [--json]

Ranges use nonnegative integer project-frame indices; --to is exclusive.
--timestamp accepts exact seconds (decimal or fraction) or a clock timestamp.
Watch emits status and temporary playback paths (JSON Lines with --json).
Frame extraction composites the edited timeline. Contact sheets sample uniformly,
including the first and last included frames (default 8 samples, 4 columns, size 320).
Size caps the finished canvas's longest side, without upscaling; frames default to
project size, clips to 640. Clip ranges must be at most 30 seconds.
PNG outputs flatten canvas transparency over black, matching H.264 export.
Saved-project inspection works offline, without media tools. Visual previews use original media,
FFmpeg and ffprobe, without launching Electron. Existing render limits apply.
Outputs are new files in existing directories; no overwrite. Projects/media are read only.
JSON success is one versioned document on stdout; errors/progress go to stderr.
SIGINT/SIGTERM clean temporary files and exit 130/143. SIGKILL cannot clean up.
Use help --json for commands, argument constraints and output JSON Schemas.
`;

export const inspectionOptions = {
  frame: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  size: { type: 'string' },
  count: { type: 'string' },
  columns: { type: 'string' },
  watch: { type: 'boolean' },
} as const;

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

async function loadInspectionInput(
  file: string,
  allowDefinitions: boolean,
  signal: AbortSignal,
) {
  if (allowDefinitions && isVideoDefinitionPath(file)) {
    return file.endsWith('.video.json')
      ? readVideoJsonForPreview(file, signal)
      : loadVideo(file, { signal, preview: true });
  }
  const path = await canonicalProjectFilePath(resolve(file));
  return { path, project: await readProjectFile(path) };
}

export async function runInspectionCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      ...inspectionOptions,
      timestamp: { type: 'string' },
      output: { type: 'string' },
      quality: { type: 'string' },
    },
  });
  const [group, action, file] = positionals;
  if (values.help) {
    console.log(
      values.json
        ? JSON.stringify(
            discovery(positionals.slice(0, 2), inspectionHelp),
            null,
            2,
          )
        : inspectionHelp,
    );
    return;
  }
  if (group === 'preview' && values.watch) {
    if (
      positionals.length !== 2 ||
      !action ||
      !isVideoDefinitionPath(action) ||
      Object.keys(values).some(
        (key) => !['watch', 'size', 'json'].includes(key),
      )
    )
      throw new UsageError(inspectionHelp);
    const maxDimension = Number(values.size ?? 640);
    if (
      !/^\d+$/.test(values.size ?? '640') ||
      maxDimension < 64 ||
      maxDimension > 1920
    )
      throw new UsageError('--size must be between 64 and 1920.');
    return withCommandCancellation(async (signal) => {
      const watcher = await watchVideo(action, {
        maxDimension,
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
  const command = `${group} ${action}`;
  const allowed: Record<string, string[]> = {
    'project inspect': [],
    'timeline inspect': ['frame', 'timestamp'],
    'preview frame': ['frame', 'timestamp', 'output', 'size'],
    'preview contact-sheet': [
      'from',
      'to',
      'output',
      'size',
      'count',
      'columns',
    ],
    'preview clip': ['from', 'to', 'output', 'size', 'quality'],
  };
  if (
    !allowed[command] ||
    positionals.length !== 3 ||
    !file ||
    args.some(
      (arg) =>
        !arg.trim() ||
        Array.from(arg).some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new UsageError(
      'Expected project inspect, timeline inspect or preview frame|contact-sheet|clip <project-or-definition>. Run preview --help for usage.',
    );
  for (const key of Object.keys(values))
    if (key !== 'json' && !allowed[command]!.includes(key))
      throw new UsageError(`--${key} does not apply to ${command}.`);
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
  const preview = group === 'preview';
  const sheet = action === 'contact-sheet';
  if (
    preview &&
    (!values.output ||
      !values.output
        .toLowerCase()
        .endsWith(action === 'clip' ? '.mp4' : '.png'))
  )
    throw new UsageError(
      `preview ${action} requires --output <new.${action === 'clip' ? 'mp4' : 'png'}>.`,
    );
  const size = values.size === undefined ? undefined : integer('size');
  if (size !== undefined && (size < 64 || size > (sheet ? 640 : 1920)))
    throw new UsageError(
      `--size must be between 64 and ${sheet ? 640 : 1920}.`,
    );
  if (
    values.quality !== undefined &&
    !['draft', 'balanced', 'high'].includes(values.quality)
  )
    throw new UsageError('--quality must be draft, balanced or high.');
  // Validate required ranges before file access, like other CLI argument errors.
  const requestedFrom =
    preview && action !== 'frame'
      ? integer('from', sheet ? 0 : undefined)
      : undefined;
  const requestedTo = preview && action === 'clip' ? integer('to') : undefined;
  await withCommandCancellation(async (signal) => {
    const input = await loadInspectionInput(
      file,
      command !== 'project inspect',
      signal,
    );
    const { path, project } = input;
    if (command === 'project inspect') {
      console.log(JSON.stringify(inspectProject(project, path), null, 2));
      return;
    }
    if (command === 'timeline inspect') {
      console.log(
        JSON.stringify(
          inspectTimeline(
            project,
            path,
            previewFrameIndex(selectedFrame!, project.settings.frameRate),
          ),
          null,
          2,
        ),
      );
      return;
    }
    const tools =
      'resolveRender' in input
        ? previewVideo(input)
        : await previewProject(project, path);
    const options = { signal, maxDimension: size };
    const startFrame = requestedFrom ?? 0;
    const endFrame = requestedTo ?? integer('to', tools.frameCount);
    const result =
      action === 'frame'
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
              quality: values.quality as RenderQuality | undefined,
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
