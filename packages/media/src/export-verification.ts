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
              timeBase: stream.time_base,
              hashes: [] as string[],
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
      const timing = options.includeTiming
        ? [track.timeBase, packet.pts, packet.dts, packet.duration]
        : [];
      if (
        options.includeTiming &&
        (!track.timeBase || !timing.slice(1).every(Number.isSafeInteger))
      )
        throw new MediaError(
          `Audio packet timing is unavailable in '${path}'.`,
        );
      track.hashes.push([packet.size, packet.data_hash, ...timing].join(':'));
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
      let firstMismatch: number | null = null;
      for (let i = 0; i < Math.max(expectedPackets, actualPackets); i++) {
        if (reference?.hashes[i] !== candidate?.hashes[i]) {
          firstMismatch = i;
          break;
        }
      }
      const digest = (hashes: string[] | undefined) =>
        hashes
          ? createHash('sha256').update(hashes.join('\n')).digest('hex')
          : null;
      return {
        track,
        expectedPackets,
        actualPackets,
        firstMismatch,
        expectedCodec: reference?.codec ?? null,
        actualCodec: candidate?.codec ?? null,
        expectedSha256: digest(reference?.hashes),
        actualSha256: digest(candidate?.hashes),
        passed:
          expectedPackets > 0 &&
          firstMismatch === null &&
          reference?.codec === candidate?.codec,
      };
    },
  );
  return {
    approvedMaster: approved,
    trackCount: actual.length,
    expectedTrackCount: expected.length,
    tracks,
    passed: tracks.length > 0 && tracks.every(({ passed }) => passed),
  };
}

export interface ExportFrameSample {
  frame: number;
  image: string;
  meanAbsoluteLumaError: number;
  previewMeanLuma: number;
  exportMeanLuma: number;
  passed: boolean;
}

export interface ExportBoundaryCheck {
  frame: number;
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
  }: {
    size?: number;
    lumaTolerance?: number;
    boundaryTolerance?: number;
    signal?: AbortSignal | undefined;
  },
) {
  if (
    !frames.length ||
    frames.length > 2048 ||
    frames.some(
      (frame, index) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        frame >= preview.ticks.length ||
        frame >= delivered.ticks.length ||
        (index > 0 && frame <= frames[index - 1]!),
    )
  )
    throw new MediaError(
      'Choose 1–2048 unique increasing frame indices shared by both videos.',
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
    const expected = await decodeMp4Tiles(
      preview,
      frames,
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
    for (const [index, frame] of frames.entries()) {
      checkRenderSignal(signal);
      const files = [expected.paths[index]!, actual.paths[index]!];
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
