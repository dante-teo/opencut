import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { frameAtOrAfter, frameTime } from '@opencut/core';
import type { RationalTime } from '@opencut/core';
import { contactTimelineSchema, evenlySpacedFrames } from '@opencut/core/video';
import {
  compareAudioPackets,
  compareExportFrames,
  readMp4FrameIndex,
} from '@opencut/media';
import type { Mp4FrameIndex } from '@opencut/media';
import type { CommandOptions } from './commands.js';
import {
  findFrameBoundary,
  mp4PresentationTime,
  parseFrameIndex,
  readContactRenderReport,
  statIfPresent,
} from './contact-sheet.js';
import { withCommandCancellation } from './cancellation.js';
import { UsageError } from './usage.js';

const mp4 = (path: string) => extname(path).toLowerCase() === '.mp4';

function lumaTolerance(flag: string, input: string | undefined) {
  if (input === undefined) return 4;
  const value = Number(input);
  if (!input.trim() || !Number.isFinite(value) || value < 0 || value > 255)
    throw new UsageError(`--${flag} requires a number from 0 to 255.`);
  return value;
}

function exportedBoundaries(
  report: Record<string, unknown>,
  index: Mp4FrameIndex,
  add: (frame: number, reason: string) => void,
) {
  const timeline =
    report.contactTimeline === undefined
      ? undefined
      : contactTimelineSchema.parse(report.contactTimeline);
  const rate =
    report.pictureFrameRate ?? timeline?.frameRate ?? report.frameRate;
  if (
    !rate ||
    typeof rate !== 'object' ||
    !('numerator' in rate) ||
    !('denominator' in rate) ||
    typeof rate.numerator !== 'number' ||
    typeof rate.denominator !== 'number' ||
    !Number.isSafeInteger(rate.numerator) ||
    !Number.isSafeInteger(rate.denominator) ||
    rate.numerator <= 0 ||
    rate.denominator <= 0
  )
    throw new UsageError('Render report has no valid picture frame rate.');
  const pictureRate = {
    numerator: rate.numerator,
    denominator: rate.denominator,
  };
  const start = report.pictureStartFrame ?? report.startFrame ?? 0;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0)
    throw new UsageError('Render report has no valid picture start frame.');
  const startFrame = start;
  function addProjectFrame(frame: number, reason: string) {
    if (frame <= startFrame) return;
    const time = frameTime(frame - startFrame, pictureRate);
    const boundary = findFrameBoundary(time, index.ticks.length, (frame) =>
      mp4PresentationTime(index, index.ticks[frame]!),
    );
    if (boundary > 0 && boundary < index.ticks.length) add(boundary, reason);
  }
  const addTime = (time: RationalTime, reason: string) =>
    addProjectFrame(frameAtOrAfter(time, pictureRate), reason);
  for (const { start, end } of timeline?.clips ?? []) {
    addTime(start, 'clip-start');
    addTime(end, 'clip-end');
  }
  for (const { start, end } of timeline?.captions ?? []) {
    addTime(start, 'caption-start');
    addTime(end, 'caption-end');
  }
  const ranges = report.pictureRanges ?? [];
  if (!Array.isArray(ranges))
    throw new UsageError('Invalid render-report picture ranges.');
  for (const range of ranges.slice(1)) {
    if (
      !range ||
      !Number.isSafeInteger(range.startFrame) ||
      range.startFrame < 0
    )
      throw new UsageError('Invalid render-report picture boundary.');
    addProjectFrame(range.startFrame, 'picture-range');
  }
}

export async function runExportVerification(
  file: string,
  values: CommandOptions,
) {
  const { against, output: destination } = values;
  if (!mp4(file) || !against || !mp4(against) || !destination?.trim())
    throw new UsageError(
      'Choose a delivered MP4, --against <approved-preview.mp4> and --output <new-directory>.',
    );
  const output = resolve(destination);
  const size = parseFrameIndex('size', values.size ?? '320');
  if (size < 64 || size > 640)
    throw new UsageError('--size must be between 64 and 640.');
  const tolerance = lumaTolerance('luma-tolerance', values['luma-tolerance']);
  const boundaryTolerance = lumaTolerance(
    'boundary-tolerance',
    values['boundary-tolerance'],
  );
  const indices = (flag: 'frames' | 'boundaries') =>
    values[flag]
      ?.split(',')
      .map((value) => parseFrameIndex(flag, value.trim()));
  const requested = indices('frames');
  const manual = indices('boundaries') ?? [];
  const audioMaster = values['audio-master'];
  await withCommandCancellation(async (signal) => {
    if (await statIfPresent(output))
      throw new UsageError('Verification requires a new report directory.');
    const [preview, delivered] = await Promise.all([
      readMp4FrameIndex(against, signal),
      readMp4FrameIndex(file, signal),
    ]);
    const renderReport = await readContactRenderReport(
      values['render-report'],
      delivered,
      signal,
    );
    const length = Math.min(preview.ticks.length, delivered.ticks.length);
    const frames = new Set(
      requested ?? evenlySpacedFrames(0, length, Math.min(8, length)),
    );
    const boundaryReasons = new Map<number, Set<string>>();
    function addBoundary(frame: number, reason: string) {
      if (frame <= 0 || frame >= length)
        throw new UsageError(
          `Boundary frame ${frame} needs both that frame and its predecessor in both MP4s.`,
        );
      const reasons = boundaryReasons.get(frame) ?? new Set<string>();
      reasons.add(reason);
      boundaryReasons.set(frame, reasons);
      frames.add(frame - 1);
      frames.add(frame);
    }
    for (const frame of manual) addBoundary(frame, 'requested');
    if (renderReport)
      exportedBoundaries(renderReport, delivered, (frame, reason) => {
        if (frame < length) addBoundary(frame, reason);
      });
    if ([...frames].some((frame) => frame >= length))
      throw new UsageError(`Choose shared frame indices below ${length}.`);
    const boundaries = [...boundaryReasons.keys()].sort((a, b) => a - b);
    const timePerTick = (media: Mp4FrameIndex) =>
      media.timeBase.numerator / media.timeBase.denominator;
    const a = timePerTick(preview);
    const b = timePerTick(delivered);
    const allowed = Math.max(a, b) / 2 + 1e-9;
    const previewStartSeconds = preview.firstPts * a;
    const exportStartSeconds = delivered.firstPts * b;
    let firstTimingMismatch: number | null = null;
    for (let i = 0; i < length; i++) {
      const previewTime = (preview.firstPts + preview.ticks[i]!) * a;
      const exportTime = (delivered.firstPts + delivered.ticks[i]!) * b;
      if (Math.abs(previewTime - exportTime) > allowed) {
        firstTimingMismatch = i;
        break;
      }
    }
    const durationErrorSeconds = Math.abs(preview.end * a - delivered.end * b);
    const timing = {
      previewFrames: preview.ticks.length,
      exportFrames: delivered.ticks.length,
      previewStartSeconds,
      exportStartSeconds,
      firstTimingMismatch,
      durationErrorSeconds,
      toleranceSeconds: allowed,
      passed:
        preview.ticks.length === delivered.ticks.length &&
        firstTimingMismatch === null &&
        durationErrorSeconds <= allowed,
    };
    const aspect = (media: Mp4FrameIndex) =>
      (media.width * media.sar) / media.height;
    const geometry = {
      previewAspectRatio: aspect(preview),
      exportAspectRatio: aspect(delivered),
      passed: Math.abs(aspect(preview) / aspect(delivered) - 1) <= 0.01,
    };
    const scratch = await mkdtemp(join(dirname(output), '.opencut-verify-'));
    try {
      const picture = await compareExportFrames(
        preview,
        delivered,
        [...frames].sort((a, b) => a - b),
        boundaries,
        scratch,
        { size, lumaTolerance: tolerance, boundaryTolerance, signal },
      );
      const audio =
        audioMaster &&
        (await compareAudioPackets(
          resolve(audioMaster),
          delivered.path,
          signal,
        ));
      await Promise.all([preview.checkSource(), delivered.checkSource()]);
      const ok =
        timing.passed &&
        geometry.passed &&
        (audio ? audio.passed : true) &&
        picture.samples.every(({ passed }) => passed) &&
        picture.boundaries.every(({ passed }) => passed);
      const report = {
        verificationVersion: 1,
        ok,
        path: join(output, 'report.json'),
        preview: preview.path,
        export: delivered.path,
        ...(values['render-report'] && {
          renderReport: resolve(values['render-report']),
        }),
        columns: ['approved-preview', 'decoded-export'],
        timing,
        geometry,
        ...picture,
        ...(audio && { audio }),
        boundaries: picture.boundaries.map((check) => ({
          ...check,
          reasons: [...boundaryReasons.get(check.frame)!].sort(),
        })),
      };
      const json = JSON.stringify(report, null, 2) + '\n';
      await writeFile(join(scratch, 'report.json'), json, {
        flag: 'wx',
        signal,
      });
      signal.throwIfAborted();
      await mkdir(output);
      try {
        await rename(scratch, output);
      } catch (error) {
        await rmdir(output);
        throw error;
      }
      process.stdout.write(json);
      if (!ok) process.exitCode = 1;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
