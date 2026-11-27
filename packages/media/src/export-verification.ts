import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeMp4Tiles } from './contact-sheet.js';
import type { Mp4FrameIndex } from './media-frame-index.js';
import {
  checkRenderSignal,
  localFile,
  MediaError,
  runMediaTool,
  sourceFileStamp,
} from './process.js';

const packetTimingFields = ['pts', 'dts', 'duration'] as const;

interface PacketTiming {
  pts: number;
  dts: number;
  duration: number;
}

function packetTimeBase(value: string | undefined) {
  const [numerator, denominator] = value?.split('/').map(Number) ?? [];
  if (
    numerator !== undefined &&
    denominator !== undefined &&
    [numerator, denominator].every(
      (tick) => Number.isSafeInteger(tick) && tick > 0,
    )
  )
    return { numerator, denominator };
}

/** Compare encoded payloads per audio track in demux order, independent of container tags. */
export async function compareAudioPackets(
  approved: string,
  delivered: string,
  signal?: AbortSignal,
  options: { includeTiming?: boolean } = {},
) {
  async function packets(file: string) {
    const path = await localFile(file);
    const stamp = await sourceFileStamp(path);
    const response = await runMediaTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_packets',
        '-show_streams',
        '-show_data_hash',
        'sha256',
        '-show_entries',
        options.includeTiming
          ? 'packet=stream_index,size,data_hash,pts,dts,duration:stream=index,codec_name,time_base'
          : 'packet=stream_index,size,data_hash:stream=index,codec_name',
        '-of',
        'json',
        path,
      ],
      32 * 1024 * 1024,
      600_000,
      { signal, stage: 'hashing audio packets' },
    );
    if ((await sourceFileStamp(path)) !== stamp)
      throw new MediaError(
        `Audio source '${path}' changed while verifying packets.`,
      );
    const result = JSON.parse(response.toString()) as {
      streams?: { index: number; codec_name?: string; time_base?: string }[];
      packets?: {
        stream_index: number;
        size?: string;
        data_hash?: string;
        pts?: number;
        dts?: number;
        duration?: number;
      }[];
    };
    const tracks = new Map(
      (result.streams ?? []).map(
        (stream) =>
          [
            stream.index,
            {
              codec: stream.codec_name ?? null,
              timeBase: packetTimeBase(stream.time_base),
              hashes: [] as string[],
              timing: [] as PacketTiming[],
            },
          ] as const,
      ),
    );
    for (const packet of result.packets ?? []) {
      const track = tracks.get(packet.stream_index);
      if (
        !track ||
        !packet.data_hash ||
        !/^SHA256:[\da-f]{64}$/i.test(packet.data_hash)
      )
        throw new MediaError(`Unable to hash an audio packet in '${path}'.`);
      track.hashes.push(`${packet.size}:${packet.data_hash}`);
      if (options.includeTiming) {
        const { pts, dts, duration } = packet;
        if (
          !track.timeBase ||
          pts === undefined ||
          dts === undefined ||
          duration === undefined ||
          ![pts, dts, duration].every(Number.isSafeInteger)
        )
          throw new MediaError(
            `Audio packet timing is unavailable in '${path}'.`,
          );
        track.timing.push({ pts, dts, duration });
      }
    }
    return [...tracks.values()];
  }
  const [expected, actual] = await Promise.all([
    packets(approved),
    packets(delivered),
  ]);
  const tracks = Array.from(
    { length: Math.max(expected.length, actual.length) },
    (_, track) => {
      const reference = expected[track];
      const candidate = actual[track];
      const expectedPackets = reference?.hashes.length ?? 0;
      const actualPackets = candidate?.hashes.length ?? 0;
      const packetCount = Math.max(expectedPackets, actualPackets);
      const firstDifferent = (mismatch: (index: number) => boolean) => {
        for (let i = 0; i < packetCount; i++) if (mismatch(i)) return i;
      };
      const contentIndex = firstDifferent(
        (i) => reference?.hashes[i] !== candidate?.hashes[i],
      );
      const referenceBase = reference?.timeBase;
      const candidateBase = candidate?.timeBase;
      const scales =
        referenceBase &&
        candidateBase &&
        (referenceBase.numerator !== candidateBase.numerator ||
          referenceBase.denominator !== candidateBase.denominator)
          ? {
              reference:
                BigInt(referenceBase.numerator) *
                BigInt(candidateBase.denominator),
              candidate:
                BigInt(candidateBase.numerator) *
                BigInt(referenceBase.denominator),
            }
          : undefined;
      const timingIndex = options.includeTiming
        ? firstDifferent((i) => {
            const a = reference?.timing[i];
            const b = candidate?.timing[i];
            if (!a || !b) return true;
            return packetTimingFields.some((key) =>
              scales
                ? BigInt(a[key]) * scales.reference !==
                  BigInt(b[key]) * scales.candidate
                : a[key] !== b[key],
            );
          })
        : undefined;
      const firstMismatchAt = (index: number | undefined) => {
        if (index === undefined) return null;
        const timecode = (value: typeof reference) => {
          const pts = value?.timing[index]?.pts;
          const timeBase = value?.timeBase;
          return pts === undefined || !timeBase
            ? null
            : (pts * timeBase.numerator) / timeBase.denominator;
        };
        return {
          packet: index,
          expectedTimeSeconds: timecode(reference),
          actualTimeSeconds: timecode(candidate),
        };
      };
      const content = {
        passed:
          expectedPackets > 0 &&
          contentIndex === undefined &&
          reference?.codec === candidate?.codec,
        firstMismatch: firstMismatchAt(contentIndex),
      };
      const timing = {
        passed: expectedPackets > 0 && timingIndex === undefined,
        firstMismatch: firstMismatchAt(timingIndex),
      };
      const digest = (hashes: string[] | undefined) =>
        hashes
          ? createHash('sha256').update(hashes.join('\n')).digest('hex')
          : null;
      const mismatch = Math.min(
        contentIndex ?? Infinity,
        timingIndex ?? Infinity,
      );
      return {
        track,
        expectedPackets,
        actualPackets,
        firstMismatch: Number.isFinite(mismatch) ? mismatch : null,
        expectedCodec: reference?.codec ?? null,
        actualCodec: candidate?.codec ?? null,
        expectedSha256: digest(reference?.hashes),
        actualSha256: digest(candidate?.hashes),
        content,
        ...(options.includeTiming && { timing }),
        passed: content.passed && (!options.includeTiming || timing.passed),
      };
    },
  );
  return {
    approvedMaster: approved,
    trackCount: actual.length,
    expectedTrackCount: expected.length,
    tracks,
    content: {
      passed:
        tracks.length > 0 && tracks.every(({ content }) => content.passed),
    },
    ...(options.includeTiming && {
      timing: {
        passed:
          tracks.length > 0 && tracks.every(({ timing }) => timing?.passed),
      },
    }),
    passed: tracks.length > 0 && tracks.every(({ passed }) => passed),
  };
}

export interface ExportFrameSample {
  frame: number;
  previewFrame: number;
  timeSeconds: number;
  image: string;
  meanAbsoluteLumaError: number;
  previewMeanLuma: number;
  exportMeanLuma: number;
  passed: boolean;
}

export interface ExportBoundaryCheck {
  frame: number;
  timeSeconds: number;
  previewMeanLumaChange: number;
  exportMeanLumaChange: number;
  maxRegionLumaChangeError: number;
  passed: boolean;
}

/** Save paired contact-sheet tiles and measure Rec. 709 luma on the same pixel grid. */
export async function compareExportFrames(
  preview: Mp4FrameIndex,
  delivered: Mp4FrameIndex,
  frames: number[],
  boundaries: number[],
  directory: string,
  {
    size = 320,
    lumaTolerance = 4,
    boundaryTolerance = 4,
    signal,
    previewFrames = frames,
  }: {
    size?: number;
    lumaTolerance?: number;
    boundaryTolerance?: number;
    signal?: AbortSignal | undefined;
    previewFrames?: number[];
  },
) {
  if (
    !frames.length ||
    frames.length > 2048 ||
    previewFrames.length !== frames.length ||
    previewFrames.some(
      (frame) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        frame >= preview.ticks.length,
    ) ||
    frames.some(
      (frame, index) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        frame >= delivered.ticks.length ||
        (index > 0 && frame <= frames[index - 1]!),
    )
  )
    throw new MediaError(
      'Choose 1–2048 increasing export frame indices paired with approved preview frames.',
    );
  const displayWidth = preview.width * preview.sar;
  const scale = Math.min(1, size / Math.max(displayWidth, preview.height));
  const width = Math.max(1, Math.round(displayWidth * scale));
  const height = Math.max(1, Math.round(preview.height * scale));
  const expectedDirectory = join(directory, '.preview');
  const actualDirectory = join(directory, '.export');
  await mkdir(expectedDirectory);
  await mkdir(actualDirectory);
  const samples: ExportFrameSample[] = [];
  const checks: ExportBoundaryCheck[] = [];
  try {
    const referenceIndices = [...new Set(previewFrames)].sort((a, b) => a - b);
    const expected = await decodeMp4Tiles(
      preview,
      referenceIndices,
      expectedDirectory,
      width,
      height,
      signal,
    );
    const actual = await decodeMp4Tiles(
      delivered,
      frames,
      actualDirectory,
      width,
      height,
      signal,
    );
    const { default: sharp } = await import('sharp');
    const boundaryMetrics = new Map<number, ReturnType<typeof compareLuma>>();
    const needed = new Set(boundaries.flatMap((frame) => [frame - 1, frame]));
    const references = new Map(
      referenceIndices.map((frame, i) => [frame, expected.paths[i]!]),
    );
    const timeSeconds = (frame: number) =>
      (delivered.ticks[frame]! * delivered.timeBase.numerator) /
      delivered.timeBase.denominator;
    for (const [index, frame] of frames.entries()) {
      checkRenderSignal(signal);
      const previewFrame = previewFrames[index]!;
      const files = [references.get(previewFrame)!, actual.paths[index]!];
      const [before, after] = await Promise.all(
        files.map((file) =>
          sharp(file).toColourspace('srgb').removeAlpha().raw().toBuffer(),
        ),
      );
      const metrics = compareLuma(before!, after!, width, height);
      if (needed.has(frame)) boundaryMetrics.set(frame, metrics);
      const image = `frame-${String(frame).padStart(6, '0')}.png`;
      await sharp({
        create: {
          width: width * 2,
          height,
          channels: 3,
          background: '#000000',
        },
      })
        .composite(
          files.map((input, column) => ({
            input,
            left: column * width,
            top: 0,
          })),
        )
        .png()
        .toFile(join(directory, image));
      samples.push({
        frame,
        previewFrame,
        timeSeconds: timeSeconds(frame),
        image,
        meanAbsoluteLumaError: metrics.error,
        previewMeanLuma: metrics.expectedMean,
        exportMeanLuma: metrics.actualMean,
        passed: metrics.error <= lumaTolerance,
      });
    }
    for (const frame of boundaries) {
      const previous = boundaryMetrics.get(frame - 1);
      const current = boundaryMetrics.get(frame);
      if (!previous || !current)
        throw new MediaError(
          `Boundary frame ${frame} needs samples immediately before and at the boundary.`,
        );
      const first = previous.regions;
      const last = current.regions;
      const error = Math.max(
        ...last.expected.map((value, index) =>
          Math.abs(
            last.actual[index]! -
              first.actual[index]! -
              (value - first.expected[index]!),
          ),
        ),
      );
      checks.push({
        frame,
        timeSeconds: timeSeconds(frame),
        previewMeanLumaChange: current.expectedMean - previous.expectedMean,
        exportMeanLumaChange: current.actualMean - previous.actualMean,
        maxRegionLumaChangeError: error,
        passed: error <= boundaryTolerance,
      });
    }
    return {
      width,
      height,
      lumaTolerance,
      boundaryTolerance,
      samples,
      boundaries: checks,
    };
  } finally {
    await rm(expectedDirectory, { recursive: true, force: true });
    await rm(actualDirectory, { recursive: true, force: true });
  }
}

function compareLuma(
  expected: Buffer,
  actual: Buffer,
  width: number,
  height: number,
) {
  const columns = Math.min(8, width);
  const rows = Math.min(8, height);
  const left = new Array<number>(columns * rows).fill(0);
  const right = new Array<number>(columns * rows).fill(0);
  const counts = new Array<number>(columns * rows).fill(0);
  let error = 0;
  let expectedTotal = 0;
  let actualTotal = 0;
  const luma = (image: Buffer, i: number) =>
    image[i]! * 0.2126 + image[i + 1]! * 0.7152 + image[i + 2]! * 0.0722;
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * rows) / height) * columns;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const a = luma(expected, i);
      const b = luma(actual, i);
      const region = row + Math.floor((x * columns) / width);
      left[region]! += a;
      right[region]! += b;
      counts[region]!++;
      error += Math.abs(a - b);
      expectedTotal += a;
      actualTotal += b;
    }
  }
  const pixels = width * height;
  return {
    error: error / pixels,
    expectedMean: expectedTotal / pixels,
    actualMean: actualTotal / pixels,
    regions: {
      expected: left.map((value, i) => value / counts[i]!),
      actual: right.map((value, i) => value / counts[i]!),
    },
  };
}
