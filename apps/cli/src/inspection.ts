import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  frameTime,
  inspectProject,
  inspectTimeline,
  previewFrameSchema,
  previewClipSchema,
  previewSheetSchema,
  projectRevision,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  isVideoDefinitionPath,
  readProjectFile,
  readVideoJsonForPreview,
  resolveProjectRender,
} from '@opencut/core/node';
import {
  renderContactSheet,
  renderTimelineFrame,
  renderVideoTimeline,
} from '@opencut/media';
import type { RenderQuality } from '@opencut/media';
import { UsageError } from './timeline.js';
import { withCommandCancellation } from './cancellation.js';
import { discovery } from './discovery.js';
import { loadVideo } from './video.js';

export const inspectionHelp = `Usage: opencut project inspect <project-file> [--json]
       opencut timeline inspect <project-file> --frame <n> [--json]
       opencut preview frame <project-file|definition.video.ts|definition.video.json> --frame <n> --output <new.png> [--size <64..1920>] [--json]
       opencut preview contact-sheet <project-file> --output <new.png> [--from <n>] [--to <n>] [--count <1..16>] [--columns <1..16>] [--size <64..640>] [--json]
       opencut preview clip <project-file> --from <n> --to <n> --output <new.mp4> [--size <64..1920>] [--quality <draft|balanced|high>] [--json]

All times are nonnegative integer project-frame indices; --to is exclusive.
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
} as const;

export async function runInspectionCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      ...inspectionOptions,
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
  const command = `${group} ${action}`;
  const allowed: Record<string, string[]> = {
    'project inspect': [],
    'timeline inspect': ['frame'],
    'preview frame': ['frame', 'output', 'size'],
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
    args.some(
      (arg) =>
        !arg.trim() ||
        Array.from(arg).some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new UsageError(
      'Expected project inspect, timeline inspect or preview frame|contact-sheet|clip <project-file>. Run preview --help for usage.',
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
  const selectedFrame =
    command === 'timeline inspect' || command === 'preview frame'
      ? integer('frame')
      : undefined;
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
  let size: number | undefined;
  if (values.size !== undefined) size = integer('size');
  else if (sheet) size = 320;
  else if (action === 'clip') size = 640;
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
  if (!preview) {
    const path = await canonicalProjectFilePath(resolve(file!));
    const project = await readProjectFile(path);
    const result =
      command === 'project inspect'
        ? inspectProject(project, path)
        : inspectTimeline(project, path, selectedFrame!);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await withCommandCancellation(async (signal) => {
    const definitionInput =
      action === 'frame' && isVideoDefinitionPath(file!)
        ? file!.endsWith('.video.json')
          ? await readVideoJsonForPreview(file!, signal)
          : await loadVideo(file!, signal)
        : undefined;
    const path =
      definitionInput?.path ?? (await canonicalProjectFilePath(resolve(file!)));
    const project = definitionInput?.project ?? (await readProjectFile(path));
    const plan =
      definitionInput && 'resolveRender' in definitionInput
        ? await definitionInput.resolveRender()
        : await resolveProjectRender(project, path);
    const startFrame = selectedFrame ?? requestedFrom!;
    const endFrame =
      selectedFrame !== undefined
        ? selectedFrame + 1
        : (requestedTo ?? integer('to', plan.frameCount));
    if (startFrame < 0 || endFrame <= startFrame || endFrame > plan.frameCount)
      throw new UsageError(
        `Range must satisfy 0 <= from < to <= ${plan.frameCount}; a selected frame must be below ${plan.frameCount}.`,
      );
    if (
      action === 'clip' &&
      BigInt(endFrame - startFrame) * BigInt(plan.frameRate.denominator) >
        30n * BigInt(plan.frameRate.numerator)
    )
      throw new UsageError(
        'Preview clips are limited to 30 seconds; select a shorter --from/--to range.',
      );
    const count = sheet
      ? integer('count', Math.min(8, endFrame - startFrame))
      : 1;
    const columns = sheet ? integer('columns', Math.min(4, count)) : 1;
    if (
      count < 1 ||
      count > 16 ||
      count > endFrame - startFrame ||
      columns < 1 ||
      columns > count
    )
      throw new UsageError(
        '--count must be 1–16 and no greater than the frame range; --columns must be 1–count.',
      );
    const options = {
      ...plan,
      output: values.output!,
      signal,
      ...(size === undefined ? {} : { maxDimension: size }),
      range: { startFrame, endFrame },
    };
    const base = {
      inspectionVersion: 1,
      projectPath: path,
      projectId: project.metadata.id,
      revision: projectRevision(project),
      frameRate: plan.frameRate,
    };
    let result: unknown;
    if (action === 'frame') {
      result = previewFrameSchema.parse({
        ...base,
        ...(await renderTimelineFrame(options)),
        kind: 'frame',
        frame: startFrame,
        time: frameTime(startFrame, plan.frameRate),
      });
    } else if (sheet) {
      const frames = Array.from(
        { length: count },
        (_, i) =>
          startFrame +
          (count === 1
            ? 0
            : Number(
                (BigInt(endFrame - startFrame - 1) * BigInt(i)) /
                  BigInt(count - 1),
              )),
      );
      const rendered = await renderContactSheet(options, frames, columns);
      result = previewSheetSchema.parse({
        ...base,
        ...rendered,
        kind: 'contact-sheet',
        startFrame,
        endFrame,
        samples: frames.map((frame, i) => ({
          frame,
          time: frameTime(frame, plan.frameRate),
          x: (i % columns) * rendered.cellWidth,
          y:
            Math.floor(i / columns) *
            (rendered.tileHeight + rendered.labelHeight),
        })),
      });
    } else {
      const rendered = await renderVideoTimeline({
        ...options,
        quality: (values.quality as RenderQuality | undefined) ?? 'draft',
        onProgress: (progress) =>
          process.stderr.write(
            values.json
              ? `${JSON.stringify(progress)}\n`
              : `${progress.phase}: ${progress.percent.toFixed(1)}%\n`,
          ),
      });
      result = previewClipSchema.parse({
        ...base,
        path: rendered.path,
        width: rendered.width,
        height: rendered.height,
        kind: 'clip',
        startFrame,
        endFrame,
        startTime: frameTime(startFrame, plan.frameRate),
        endTime: frameTime(endFrame, plan.frameRate),
        frameCount: rendered.frameCount,
        durationSeconds: rendered.durationSeconds,
        quality: rendered.quality,
      });
    }
    console.log(JSON.stringify(result, null, 2));
  });
}
