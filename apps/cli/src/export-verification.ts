import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { compareTimes, frameAtOrAfter, frameTime } from '@opencut/core';
import type { FrameRate, RationalTime } from '@opencut/core';
import {
  contactTimelineSchema,
  evenlySpacedFrames,
  parseSubtitleTime,
} from '@opencut/core/video';
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
import { parseFrameRateOption } from './render-options.js';

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
  length: number,
  at: (frame: number) => RationalTime,
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
    const boundary = findFrameBoundary(time, length, at);
    if (boundary > 0 && boundary < length) add(boundary, reason);
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

function specifiedFrameRate(
  report: Record<string, unknown> | undefined,
  requested: string | undefined,
) {
  if (requested !== undefined)
    return parseFrameRateOption('expect-fps', requested);
  const authored = report?.frameRate;
  if (
    authored &&
    typeof authored === 'object' &&
    'numerator' in authored &&
    'denominator' in authored
  )
    return parseFrameRateOption(
      'expect-fps',
      `${authored.numerator}/${authored.denominator}`,
    );
}

function seconds(time: RationalTime) {
  return time.numerator / time.denominator;
}

function tickSeconds(media: Mp4FrameIndex) {
  return seconds(media.timeBase);
}

function checkFrameClock(media: Mp4FrameIndex, rate: FrameRate) {
  const { numerator, denominator } = media.timeBase;
  const ticksPerFrameNumerator = BigInt(rate.denominator) * BigInt(denominator);
  const ticksPerFrameDenominator = BigInt(rate.numerator) * BigInt(numerator);
  const offGrid = (ticks: number, frame: number) => {
    const error =
      BigInt(ticks) * ticksPerFrameDenominator -
      BigInt(frame) * ticksPerFrameNumerator;
    return (
      error * 2n < -ticksPerFrameDenominator ||
      error * 2n > ticksPerFrameDenominator
    );
  };
  const toSeconds = (ticks: number) => (ticks * numerator) / denominator;
  function findMismatch() {
    for (const [frame, { pts, duration }] of media.frameClock.entries()) {
      if (
        pts === undefined ||
        !Number.isSafeInteger(pts) ||
        offGrid(pts - media.firstPts, frame)
      )
        return {
          frame,
          field: 'pts',
          expectedTimeSeconds:
            seconds(frameTime(frame, rate)) + toSeconds(media.firstPts),
          actualTimeSeconds: pts === undefined ? null : toSeconds(pts),
        };
      if (
        duration !== undefined &&
        (!Number.isSafeInteger(duration) ||
          duration <= 0 ||
          offGrid(pts - media.firstPts + duration, frame + 1))
      )
        return {
          frame,
          field: 'frame-end',
          expectedTimeSeconds:
            seconds(frameTime(frame + 1, rate)) + toSeconds(media.firstPts),
          actualTimeSeconds: toSeconds(pts + duration),
        };
    }
    return null;
  }
  const firstMismatch = findMismatch();
  const count = media.ticks.length;
  return {
    rate,
    firstMismatch,
    matches: firstMismatch === null && !offGrid(media.end, count),
  };
}

function inferredFrameClock(media: Mp4FrameIndex) {
  let fallback: ReturnType<typeof checkFrameClock> | undefined;
  for (const candidate of new Set([
    media.frameRateRatio,
    media.nominalFrameRateRatio,
  ])) {
    if (!candidate || candidate === '0/0') continue;
    const clock = checkFrameClock(
      media,
      parseFrameRateOption('expect-fps', candidate),
    );
    if (clock.matches) return clock;
    fallback ??= clock;
  }
  return fallback;
}

function pictureClock(
  media: Mp4FrameIndex,
  clock: ReturnType<typeof checkFrameClock> | undefined,
) {
  // Use the exact grid only after checking the decoded timestamps against it.
  // This removes muxer rounding when two files have different time bases.
  const rate = clock?.matches ? clock.rate : undefined;
  return {
    end: rate
      ? frameTime(media.ticks.length, rate)
      : mp4PresentationTime(media, media.end),
    at: (frame: number) =>
      rate
        ? frameTime(frame, rate)
        : mp4PresentationTime(media, media.ticks[frame]!),
  };
}

function compareFrameClock(
  preview: Mp4FrameIndex,
  delivered: Mp4FrameIndex,
  clock: ReturnType<typeof checkFrameClock>,
  previewEnd: RationalTime,
) {
  const { rate, matches, firstMismatch } = clock;
  const count = delivered.ticks.length;
  const previewStartSeconds = preview.firstPts * tickSeconds(preview);
  const exportStartSeconds = delivered.firstPts * tickSeconds(delivered);
  const startErrorSeconds = Math.abs(previewStartSeconds - exportStartSeconds);
  const toleranceSeconds =
    (tickSeconds(preview) + tickSeconds(delivered)) / 2 + 1e-9;
  const expectedFrames = frameAtOrAfter(previewEnd, rate);
  const expectedDurationSeconds = seconds(frameTime(expectedFrames, rate));
  const exportDurationSeconds = seconds(
    mp4PresentationTime(delivered, delivered.end),
  );
  const durationErrorSeconds = Math.abs(
    expectedDurationSeconds - exportDurationSeconds,
  );
  const firstClockMismatch =
    delivered.firstPts === 0
      ? firstMismatch
      : {
          frame: 0,
          field: 'pts',
          expectedTimeSeconds: 0,
          actualTimeSeconds: exportStartSeconds,
        };
  return {
    previewFrames: preview.ticks.length,
    exportFrames: count,
    expectedFrames,
    expectedFrameRate: rate,
    previewStartSeconds,
    exportStartSeconds,
    startErrorSeconds,
    firstTimingMismatch:
      firstClockMismatch?.frame ??
      (startErrorSeconds > toleranceSeconds ? 0 : null),
    firstClockMismatch,
    expectedDurationSeconds,
    previewDurationSeconds: seconds(previewEnd),
    exportDurationSeconds,
    durationErrorSeconds,
    toleranceSeconds,
    passed:
      firstClockMismatch === null &&
      startErrorSeconds <= toleranceSeconds &&
      matches &&
      count === expectedFrames,
  };
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
  const timestamps = (flag: 'timestamps' | 'boundary-timestamps') =>
    values[flag]?.split(',').map((value) => {
      try {
        return parseSubtitleTime(value.trim());
      } catch {
        throw new UsageError(
          `Invalid --${flag} time '${value}'. Use seconds, a fraction or clock time.`,
        );
      }
    });
  const requestedTimes = timestamps('timestamps');
  const manualTimes = timestamps('boundary-timestamps') ?? [];
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
    const rate = specifiedFrameRate(renderReport, values['expect-fps']);
    const deliveryClock = rate
      ? checkFrameClock(delivered, rate)
      : inferredFrameClock(delivered);
    if (!deliveryClock)
      throw new UsageError(
        'The delivery frame rate is unavailable. Supply --expect-fps.',
      );
    const { end: previewEnd, at: previewAt } = pictureClock(
      preview,
      inferredFrameClock(preview),
    );
    const { end: deliveredEnd, at: deliveredAt } = pictureClock(
      delivered,
      deliveryClock,
    );
    const length = findFrameBoundary(
      previewEnd,
      delivered.ticks.length,
      deliveredAt,
    );
    const sharedPreviewLength = findFrameBoundary(
      deliveredEnd,
      preview.ticks.length,
      previewAt,
    );
    function sample(time: RationalTime, boundary = false) {
      if (
        compareTimes(time, previewEnd) >= 0 ||
        compareTimes(time, deliveredEnd) >= 0
      )
        throw new UsageError(
          'Requested timestamp is outside the shared picture duration.',
        );
      const frame = findFrameBoundary(time, length, deliveredAt, !boundary);
      return boundary ? frame : frame - 1;
    }
    const defaults = () =>
      sharedPreviewLength < length
        ? evenlySpacedFrames(
            0,
            sharedPreviewLength,
            Math.min(8, sharedPreviewLength),
          ).map((frame) => sample(previewAt(frame)))
        : evenlySpacedFrames(0, length, Math.min(8, length));
    const sampleRequests = new Map<number, number[]>();
    for (const time of requestedTimes ?? []) {
      const frame = sample(time);
      const times = sampleRequests.get(frame) ?? [];
      times.push(seconds(time));
      sampleRequests.set(frame, times);
    }
    const frames = new Set(
      requested || requestedTimes
        ? [...(requested ?? []), ...sampleRequests.keys()]
        : defaults(),
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
    for (const time of manualTimes)
      addBoundary(sample(time, true), 'requested-timestamp');
    if (renderReport)
      exportedBoundaries(renderReport, length, deliveredAt, addBoundary);
    if ([...frames].some((frame) => frame >= length))
      throw new UsageError(`Choose shared frame indices below ${length}.`);
    const boundaries = [...boundaryReasons.keys()].sort((a, b) => a - b);
    const orderedFrames = [...frames].sort((a, b) => a - b);
    const previewFrames = orderedFrames.map(
      (frame) =>
        findFrameBoundary(
          deliveredAt(frame),
          preview.ticks.length,
          previewAt,
          true,
        ) - 1,
    );
    const timing = compareFrameClock(
      preview,
      delivered,
      deliveryClock,
      previewEnd,
    );
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
        orderedFrames,
        boundaries,
        scratch,
        {
          size,
          lumaTolerance: tolerance,
          boundaryTolerance,
          signal,
          previewFrames,
        },
      );
      const audio =
        audioMaster &&
        (await compareAudioPackets(
          resolve(audioMaster),
          delivered.path,
          signal,
          { includeTiming: true },
        ));
      await Promise.all([preview.checkSource(), delivered.checkSource()]);
      const ok =
        timing.passed &&
        geometry.passed &&
        (audio ? audio.passed : true) &&
        picture.samples.every(({ passed }) => passed) &&
        picture.boundaries.every(({ passed }) => passed);
      const report = {
        verificationVersion: 2,
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
        samples: picture.samples.map((sample) => {
          const requestedTimesSeconds = sampleRequests.get(sample.frame);
          return requestedTimesSeconds
            ? { ...sample, requestedTimesSeconds }
            : sample;
        }),
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
