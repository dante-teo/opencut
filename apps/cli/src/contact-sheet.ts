import {
  link,
  lstat,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import {
  addTimes,
  compareTimes,
  frameAtOrAfter,
  frameTime,
  rationalTime,
  subtractTimes,
} from '@opencut/core';
import type { RationalTime } from '@opencut/core';
import {
  contactTimelineSchema,
  describeProjectContactTimeline,
  evenlySpacedFrames,
  fileFingerprintSchema,
  fingerprintFile,
  isVideoDefinitionPath,
  matchesFingerprint,
  parseSubtitleTime,
  previewVideo,
  readDefinitionContactTimeline,
} from '@opencut/core/video';
import type { ContactTimeline } from '@opencut/core/video';
import { readMp4FrameIndex, renderMp4ContactSheet } from '@opencut/media';
import { withCommandCancellation } from './cancellation.js';
import { readJsonArgument, readParams } from './json-argument.js';
import { parseProcessingControls } from './recipe-options.js';
import { parseRenderQuality } from './render-options.js';
import { UsageError } from './usage.js';
import { loadVideo, withDefinitionConsole } from './video.js';
import type { CommandOptions } from './commands.js';

const isIndex = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function integer(flag: string, input: string) {
  if (!/^\d+$/.test(input) || !isIndex(Number(input)))
    throw new UsageError(`--${flag} requires nonnegative safe integers.`);
  return Number(input);
}
function timestamp(value: string) {
  try {
    return parseSubtitleTime(value);
  } catch {
    throw new UsageError(
      `Invalid contact-sheet timestamp '${value}'. Use seconds, a fraction or clock time.`,
    );
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UsageError('Expected an OpenCut render report object.');
  return value as Record<string, unknown>;
}
function fileExists(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  });
}
type Boundary = {
  kind: 'cut' | 'caption-start' | 'caption-end' | 'picture-boundary';
  time: RationalTime;
  id?: string;
};
type Request =
  | { reason: 'even' | 'frame'; requestedFrame: number }
  | { reason: 'timestamp'; requestedTime: RationalTime }
  | {
      reason: Boundary['kind'];
      side: 'before' | 'at-or-after';
      requestedTime: RationalTime;
      id?: string;
      adjacentClipIds?: { before: string[]; at: string[] };
    };

function clipIds(
  timeline: ContactTimeline,
  time: RationalTime,
  before = false,
) {
  return timeline.clips
    .filter(({ start, end }) =>
      before
        ? compareTimes(start, time) < 0 && compareTimes(end, time) >= 0
        : compareTimes(start, time) <= 0 && compareTimes(end, time) > 0,
    )
    .map(({ id }) => id);
}

export async function runContactSheet(file: string, values: CommandOptions) {
  const mp4 = extname(file).toLowerCase() === '.mp4';
  if (!mp4 && !isVideoDefinitionPath(file))
    throw new UsageError('Choose a .video.ts definition or a finished .mp4.');
  if (extname(values.output ?? '').toLowerCase() !== '.png')
    throw new UsageError('Contact sheets require --output <new.png>.');
  if (
    values.definition !== undefined &&
    (!mp4 || !isVideoDefinitionPath(values.definition))
  )
    throw new UsageError(
      '--definition requires an MP4 input and a .video.ts definition.',
    );
  if (
    mp4 &&
    (values.quality !== undefined ||
      Object.values(parseProcessingControls(values)).some(
        (value) => value !== undefined,
      ))
  )
    throw new UsageError(
      'Recipe and quality controls apply to definition inputs.',
    );
  if (mp4 && values.params !== undefined && values.definition === undefined)
    throw new UsageError('--params with an MP4 requires --definition.');
  const frameRequests =
    values.frames?.split(',').map((item) => integer('frames', item.trim())) ??
    [];
  const timeRequests = values.timestamps?.split(',').map(timestamp) ?? [];
  const around = new Set(
    values.around?.split(',').map((item) => item.trim()) ?? [],
  );
  if (
    [...around].some((item) => !['cuts', 'captions', 'picture'].includes(item))
  )
    throw new UsageError('--around accepts cuts,captions,picture.');
  const targeted =
    frameRequests.length > 0 || timeRequests.length > 0 || around.size > 0;
  if (targeted && values.count !== undefined)
    throw new UsageError('--count applies only to evenly spaced samples.');
  const size = integer('size', values.size ?? '320');
  if (size < 64 || size > 640)
    throw new UsageError('--size must be between 64 and 640.');
  const quality = parseRenderQuality(values.quality, 'fast');
  const output = resolve(values.output!);
  const manifestPath = output + '.json';
  await withCommandCancellation(async (signal) => {
    if ((await fileExists(output)) || (await fileExists(manifestPath)))
      throw new UsageError(
        'Contact sheet and manifest require new output paths.',
      );
    const params = await readParams(values.params, signal);
    const video = mp4
      ? undefined
      : await loadVideo(file, {
          signal,
          params,
          quality,
          preview: true,
          processing: parseProcessingControls(values),
        });
    const media = mp4 ? await readMp4FrameIndex(file, signal) : undefined;
    const report =
      values['render-report'] === undefined
        ? undefined
        : object(
            await readJsonArgument(
              'render-report',
              values['render-report'],
              signal,
            ),
          );
    if (media && report) {
      const expected = fileFingerprintSchema.safeParse(
        report.outputFingerprint,
      );
      if (!expected.success)
        throw new UsageError(
          'Render report has no valid output fingerprint. Use the JSON from a new render or supply --definition for timeline context.',
        );
      const actual = await fingerprintFile(await realpath(media.path), signal);
      await media.checkSource();
      if (
        !matchesFingerprint(actual, expected.data) ||
        report.frameCount !== media.ticks.length
      )
        throw new UsageError(
          'Render report does not match this MP4. Supply the report for this export.',
        );
    }
    const timeline = video
      ? describeProjectContactTimeline(video.project)
      : values.definition
        ? await withDefinitionConsole(() =>
            readDefinitionContactTimeline(values.definition!, {
              signal,
              params,
            }),
          )
        : report?.contactTimeline === undefined
          ? undefined
          : contactTimelineSchema.parse(report.contactTimeline);
    const projectTime = (time: RationalTime) => {
      const rate = timeline!.frameRate;
      return frameTime(frameAtOrAfter(time, rate), rate);
    };
    const visibleTimeline =
      media && timeline
        ? {
            ...timeline,
            clips: timeline.clips.map(({ id, start, end }) => ({
              id,
              start: projectTime(start),
              end: projectTime(end),
            })),
          }
        : timeline;
    if ((around.has('cuts') || around.has('captions')) && !timeline)
      throw new UsageError(
        'MP4 clip and caption samples require --definition or a render report with contactTimeline.',
      );
    if (around.has('picture') && !report)
      throw new UsageError('--around picture requires --render-report.');
    const length = media?.ticks.length ?? video!.frameCount;
    const startFrame = integer('from', values.from ?? '0');
    const endFrame = integer('to', values.to ?? String(length));
    if (startFrame >= endFrame || endFrame > length)
      throw new UsageError(
        `Select a range with 0 <= from < to <= ${length} frames.`,
      );
    const mediaTime = (ticks: number) =>
      rationalTime(
        BigInt(ticks) * BigInt(media!.timeBase.numerator),
        BigInt(media!.timeBase.denominator),
      );
    const at = (frame: number) =>
      media
        ? mediaTime(media.ticks[frame]!)
        : frameTime(frame, timeline!.frameRate);
    const end = media
      ? mediaTime(media.end)
      : frameTime(length, timeline!.frameRate);
    const pictureRate =
      report?.pictureFrameRate ?? timeline?.frameRate ?? report?.frameRate;
    const start = report?.pictureStartFrame ?? report?.startFrame ?? 0;
    if (!isIndex(start))
      throw new UsageError('Invalid render report start frame.');
    const offset =
      media && start
        ? frameTime(start, pictureRate as ContactTimeline['frameRate'])
        : { numerator: 0, denominator: 1 };
    const localBoundary = (time: RationalTime) =>
      compareTimes(time, offset) < 0 ? undefined : subtractTimes(time, offset);
    function lowerBound(time: RationalTime, after = false) {
      let low = 0;
      let high = length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const relation = compareTimes(at(mid), time);
        if (relation < 0 || (after && relation === 0)) low = mid + 1;
        else high = mid;
      }
      return low;
    }
    const selected = new Map<number, Map<string, Request>>();
    function add(frame: number, request: Request, required = true) {
      if (frame < startFrame || frame >= endFrame) {
        if (required)
          throw new UsageError(
            `Requested sample is outside [${startFrame}, ${endFrame}).`,
          );
        return;
      }
      const reasons = selected.get(frame) ?? new Map<string, Request>();
      reasons.set(JSON.stringify(request), request);
      selected.set(frame, reasons);
    }
    for (const frame of frameRequests)
      add(frame, { reason: 'frame', requestedFrame: frame });
    for (const time of timeRequests) {
      if (compareTimes(time, end) >= 0)
        throw new UsageError(
          'Requested timestamp is outside the input duration.',
        );
      add(lowerBound(time, true) - 1, {
        reason: 'timestamp',
        requestedTime: time,
      });
    }
    const boundaries: Boundary[] = [];
    if (around.has('cuts')) {
      for (const { start, end } of timeline!.clips)
        boundaries.push(
          { kind: 'cut', time: start },
          { kind: 'cut', time: end },
        );
    }
    if (around.has('captions')) {
      for (const { id, start, end } of timeline!.captions)
        boundaries.push(
          { kind: 'caption-start', time: start, id },
          { kind: 'caption-end', time: end, id },
        );
    }
    if (around.has('picture')) {
      const ranges = report?.pictureRanges ?? [];
      if (!Array.isArray(ranges))
        throw new UsageError('Invalid render-report pictureRanges.');
      for (const range of ranges.slice(1)) {
        const { startFrame } = object(range);
        if (!isIndex(startFrame) || !pictureRate)
          throw new UsageError(
            'Invalid render-report picture boundary or frame rate.',
          );
        boundaries.push({
          kind: 'picture-boundary',
          time: frameTime(
            startFrame,
            pictureRate as ContactTimeline['frameRate'],
          ),
        });
      }
    }
    for (const { kind, time, id } of boundaries) {
      const boundary =
        media && kind !== 'picture-boundary' ? projectTime(time) : time;
      const local = localBoundary(boundary);
      if (!local || compareTimes(local, end) > 0) continue;
      const next = lowerBound(local);
      const adjacentClipIds = visibleTimeline && {
        before: clipIds(visibleTimeline, boundary, true),
        at: clipIds(visibleTimeline, boundary),
      };
      for (const [delta, side] of [
        [-1, 'before'],
        [0, 'at-or-after'],
      ] as const)
        add(
          next + delta,
          {
            reason: kind,
            side,
            requestedTime: time,
            ...(id && { id }),
            ...(adjacentClipIds && { adjacentClipIds }),
          },
          false,
        );
    }
    if (!targeted) {
      const count = integer(
        'count',
        values.count ?? String(Math.min(8, endFrame - startFrame)),
      );
      if (count < 1 || count > Math.min(16, endFrame - startFrame))
        throw new UsageError(
          'Choose 1–16 evenly spaced samples within the range.',
        );
      for (const frame of evenlySpacedFrames(startFrame, endFrame, count))
        add(frame, { reason: 'even', requestedFrame: frame });
    }
    const frames = [...selected.keys()].sort((a, b) => a - b);
    const columns = integer(
      'columns',
      values.columns ?? String(Math.min(4, frames.length)),
    );
    if (
      !frames.length ||
      frames.length > 16 ||
      columns < 1 ||
      columns > frames.length
    )
      throw new UsageError(
        'Choose 1–16 unique samples and 1–sample-count columns. Use --from and --to to narrow a boundary scan.',
      );
    const scratch = await mkdtemp(
      join(dirname(output), '.opencut-sheet-output-'),
    );
    try {
      const image = join(scratch, 'sheet.png');
      const result = media
        ? await renderMp4ContactSheet(
            media,
            frames,
            columns,
            image,
            size,
            signal,
          )
        : await previewVideo(video!).contactSheet(
            { startFrame, endFrame },
            image,
            {
              frames,
              columns,
              quality,
              signal,
              maxDimension: size,
            },
          );
      const manifest = {
        ...result,
        path: output,
        manifestPath,
        kind: 'contact-sheet',
        input: {
          kind: media ? 'mp4' : 'definition',
          path: media?.path ?? video!.path,
        },
        ...(media && { timeBase: media.timeBase, firstPts: media.firstPts }),
        startFrame,
        endFrame,
        samples: frames.map((frame, i) => {
          const time = at(frame);
          return {
            frame,
            time,
            ...(media && { pts: media.firstPts + media.ticks[frame]! }),
            x: (i % columns) * result.cellWidth,
            y:
              Math.floor(i / columns) *
              (result.tileHeight + result.labelHeight),
            requests: [...selected.get(frame)!.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([, request]) => request),
            ...(visibleTimeline && {
              clipIds: clipIds(visibleTimeline, addTimes(time, offset)),
            }),
          };
        }),
      };
      const json = JSON.stringify(manifest, null, 2) + '\n';
      const sidecar = join(scratch, 'sheet.json');
      await writeFile(sidecar, json, { flag: 'wx', signal });
      signal.throwIfAborted();
      await link(sidecar, manifestPath);
      try {
        await link(image, output);
      } catch (error) {
        const expected = await lstat(sidecar);
        const published = await fileExists(manifestPath);
        if (published?.dev === expected.dev && published.ino === expected.ino)
          await unlink(manifestPath);
        throw error;
      }
      process.stdout.write(json);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
