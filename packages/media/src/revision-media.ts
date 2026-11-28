import { countDecodedVideo } from './media-engine.js';
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MediaError, runMediaTool } from './process.js';
import { probeMedia, sameFrameRate } from './probe.js';
import type { MediaMetadata } from './probe.js';
import { rasterizeTextLayer } from './text.js';
import { renderProgress } from './render-progress.js';
import type { RenderProgress } from './render-progress.js';

type Rate = { numerator: number; denominator: number };

type EncodedPacket = {
  pts: number;
  dts: number;
  duration: number;
  size: string;
  data_hash: string;
  pos: string;
  flags: string;
};

const packetTimingFields = {
  pts: 'Video presentation timestamp (PTS)',
  dts: 'Video decode timestamp (DTS)',
  duration: 'Video packet duration',
};

export class PictureTimestampError extends MediaError {
  constructor(
    readonly timestamp: {
      field: string;
      expected: number | string;
      actual: number | string | null;
      unit?: string;
    },
    readonly frame = 0,
  ) {
    const { field, expected, actual, unit } = timestamp;
    const format = (value: number | string | null) =>
      value === null ? 'unavailable' : `${value}${unit ? ' ' + unit : ''}`;
    super(`${field}. Expected ${format(expected)}, got ${format(actual)}.`);
  }
}

function verifyStreamStartTime(
  stream: 'Video' | 'Audio',
  actual: number | null,
) {
  if (actual !== 0)
    throw new PictureTimestampError({
      field: `${stream} stream start time`,
      expected: 0,
      actual,
      unit: 'seconds',
    });
}

export function verifyDeliveryStreamTiming(
  { video, audio }: MediaMetadata,
  durationSeconds: number,
  frameCount: number,
) {
  if (video) verifyStreamStartTime('Video', video.startTimeSeconds);
  if (audio) verifyStreamStartTime('Audio', audio.startTimeSeconds);
  for (const [stream, actual, tolerance] of [
    ['Audio', audio?.durationSeconds, 0.0011],
    ['Video', video?.durationSeconds, 0.000002],
  ] as const) {
    if (actual == null || Math.abs(actual - durationSeconds) > tolerance)
      throw new PictureTimestampError(
        {
          field: `${stream} stream end time`,
          expected: durationSeconds,
          actual: actual ?? null,
          unit: 'seconds',
        },
        frameCount - 1,
      );
  }
}

function verifyPacketTiming(
  field: keyof typeof packetTimingFields,
  expected: number,
  actual: number,
  unit: string,
  frame: number,
) {
  if (actual !== expected)
    throw new PictureTimestampError(
      { field: packetTimingFields[field], expected, actual, unit },
      frame,
    );
}

/** Inspect packet boundaries and codec initialization data on a constant frame grid. */
export async function inspectPicturePackets(
  file: string,
  signal?: AbortSignal,
) {
  const path = resolve(file);
  const { video } = await probeMedia(path, signal);
  if (
    !video?.timeBase ||
    !video.width ||
    !video.height ||
    !video.frameRateRatio
  )
    throw new MediaError(
      'Picture needs a video stream with a valid frame rate and time base.',
    );
  verifyStreamStartTime('Video', video.startTimeSeconds);
  const result = await runMediaTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_packets',
      '-show_streams',
      '-show_data_hash',
      'sha256',
      '-show_entries',
      'packet=pts,dts,duration,size,data_hash,pos,flags:stream=extradata_hash',
      '-of',
      'json',
      path,
    ],
    64 * 1024 * 1024,
    600_000,
    { signal, stage: 'verifying encoded picture packets' },
  );
  const { streams, packets } = JSON.parse(result.toString()) as {
    streams?: { extradata_hash?: string }[];
    packets?: EncodedPacket[];
  };
  const extra = streams?.[0]?.extradata_hash;
  if (
    !extra ||
    !packets?.length ||
    packets.some(
      ({ pts, dts, duration, data_hash }) =>
        ![pts, dts, duration].every(Number.isSafeInteger) ||
        duration <= 0 ||
        !data_hash,
    )
  )
    throw new MediaError(
      'Picture packets lack timestamps, durations, or codec initialization data.',
    );
  const step = packets[0]!.duration;
  const firstDts = packets[0]!.dts;
  const [n, d] = video.timeBase.split('/').map(Number) as [number, number];
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0)
    throw new MediaError(`Invalid video time base '${video.timeBase}'.`);
  const unit = `ticks (${video.timeBase} seconds per tick)`;
  const presentationTimes = packets.map(({ pts }) => pts).sort((a, b) => a - b);
  for (const [frame, pts] of presentationTimes.entries())
    verifyPacketTiming('pts', frame * step, pts, unit, frame);
  for (const [index, { pts, dts, duration }] of packets.entries()) {
    const frame = pts / step;
    verifyPacketTiming('dts', firstDts + index * step, dts, unit, frame);
    verifyPacketTiming('duration', step, duration, unit, frame);
  }
  if (!sameFrameRate(video.frameRateRatio, d, n * step))
    throw new PictureTimestampError({
      field: 'Video frame rate',
      expected: `${d}/${n * step}`,
      actual: video.frameRateRatio,
      unit: 'fps',
    });
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    extradataHash: extra,
    packets,
    step,
    packetHash: digest([
      extra,
      packets.map(({ size, data_hash }) => [size, data_hash]),
    ]),
    timingHash: digest([
      video.timeBase,
      packets.map(({ pts, dts, duration }) => [pts, dts, duration]),
    ]),
    frameCount: packets.length,
    metadata: {
      ...video,
      width: video.width,
      height: video.height,
      frameRateRatio: video.frameRateRatio,
    },
  };
}

/** Bind encoded packet payloads and timestamps to an export without exposing packet data. */
export async function inspectEncodedPicture(
  file: string,
  signal?: AbortSignal,
) {
  return describeEncodedPicture(await inspectPicturePackets(file, signal));
}

export function describeEncodedPicture({
  packetHash,
  timingHash,
  frameCount,
  metadata,
}: PicturePackets) {
  return { packetHash, timingHash, frameCount, metadata };
}

export type PicturePackets = Awaited<ReturnType<typeof inspectPicturePackets>>;

export function verifyMuxedPictureTiming(
  expected: PicturePackets,
  actual: PicturePackets,
) {
  if (actual.timingHash === expected.timingHash) return;
  if (actual.frameCount !== expected.frameCount)
    throw new MediaError(
      `The final delivery has ${actual.frameCount} video packets. Expected ${expected.frameCount}.`,
    );
  if (actual.metadata.timeBase !== expected.metadata.timeBase)
    throw new PictureTimestampError({
      field: 'Video packet time base',
      expected: expected.metadata.timeBase!,
      actual: actual.metadata.timeBase,
    });
  const unit = `ticks (${expected.metadata.timeBase} seconds per tick)`;
  for (const [i, packet] of expected.packets.entries()) {
    const muxed = actual.packets[i]!;
    const frame = packet.pts / expected.step;
    verifyPacketTiming('pts', packet.pts, muxed.pts, unit, frame);
    verifyPacketTiming('dts', packet.dts, muxed.dts, unit, frame);
    verifyPacketTiming(
      'duration',
      packet.duration,
      muxed.duration,
      unit,
      frame,
    );
  }
}

/** Only allow independently decodable accesses that also partition presentation order. */
export async function randomAccessFrames(
  path: string,
  picture: PicturePackets,
  signal?: AbortSignal,
) {
  const { packets, step, metadata } = picture;
  const suffixMin = Array<number>(packets.length + 1);
  suffixMin[packets.length] = Infinity;
  for (let i = packets.length - 1; i >= 0; i--)
    suffixMin[i] = Math.min(packets[i]!.pts, suffixMin[i + 1]!);
  let prefixMax = -Infinity;
  const starts: number[] = [];
  const file = await open(path, 'r');
  try {
    for (const [index, packet] of packets.entries()) {
      signal?.throwIfAborted();
      const boundary =
        packet.pts > prefixMax && packet.pts === suffixMin[index];
      prefixMax = Math.max(prefixMax, packet.pts);
      if (!boundary || !packet.flags.includes('K')) continue;
      const offset = Number(packet.pos);
      const size = Number(packet.size);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(size) ||
        size < 6
      )
        continue;
      const header = Buffer.alloc(6);
      for (let nal = 0; nal + header.length <= size;) {
        const { bytesRead } = await file.read(
          header,
          0,
          header.length,
          offset + nal,
        );
        if (bytesRead !== header.length) break;
        // OpenCut MP4 outputs use four-byte NAL lengths. A packet with a
        // different layout must fail this probe and fall back to a full render.
        const length = header.readUInt32BE();
        if (length < 2 || nal + 4 + length > size) break;
        const type =
          metadata.codec === 'h264' ? header[4]! & 31 : (header[4]! >> 1) & 63;
        const slices =
          metadata.codec === 'h264' ? type >= 1 && type <= 5 : type < 32;
        if (slices) {
          const independent =
            metadata.codec === 'h264' ? type === 5 : type >= 16 && type <= 21;
          if (independent) starts.push(packet.pts / step);
          break;
        }
        nal += 4 + length;
      }
    }
  } finally {
    await file.close();
  }
  return starts;
}
export interface ReviewClipOptions {
  source: string;
  output: string;
  startSeconds: number;
  duration: number;
  sourceFrame: number;
  frameCount: number;
  frameRate: Rate;
  width: number;
  height: number;
  label: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: RenderProgress) => void) | undefined;
}

/** Bake labels with the bundled fonts so no optional FFmpeg text filter is needed. */
export async function renderReviewClip(options: ReviewClipOptions) {
  const {
    source,
    output,
    startSeconds,
    duration,
    sourceFrame,
    frameCount,
    frameRate,
    width,
    height,
    label,
    signal,
  } = options;
  const stage = renderProgress(frameCount, options.onProgress, {
    stage: 'review-labels',
  });
  stage.start();
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const rate = frameRate.numerator / frameRate.denominator;
  const overlay = createCanvas(
    width,
    Math.max(52, Math.min(90, Math.ceil(width / 6))),
  );
  const context = overlay.getContext('2d');
  const directory = dirname(output);
  const list = output + '.ffconcat';
  const entries: string[] = [];
  const step = Math.max(1, Math.round(rate));
  for (let at = 0; at < frameCount; at += step) {
    const offset = sourceFrame + at;
    const seconds = (offset / rate).toFixed(3);
    const { png } = await rasterizeTextLayer(
      width,
      height,
      {
        content: label + '\n' + seconds + 's  |  frame ' + offset,
        fontSize: Math.max(9, Math.min(30, Math.floor(width / 19))),
        fontFamily: 'Noto Sans SC',
        color: '#ffffff',
        background: { color: '#000000cc', padding: 4 },
      },
      { x: 0, y: 0 },
      signal,
    );
    if (!png) throw new MediaError('Could not rasterize the review label.');
    const basename = 'label-' + at + '.png';
    context.clearRect(0, 0, overlay.width, overlay.height);
    const image = await loadImage(png);
    const labelScale = Math.min(1, (width - 8) / image.width);
    context.drawImage(
      image,
      4,
      4,
      image.width * labelScale,
      image.height * labelScale,
    );
    await writeFile(join(directory, basename), overlay.toBuffer('image/png'), {
      signal,
    });
    entries.push(
      "file '" + basename + "'",
      'option framerate ' + frameRate.numerator + '/' + frameRate.denominator,
      'duration ' + (Math.min(step, frameCount - at) / rate).toFixed(9),
    );
  }
  entries.push(entries.at(-3)!);
  await writeFile(list, entries.join('\n') + '\n', { signal });
  await runMediaTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-xerror',
      '-ss',
      (Math.floor(startSeconds * 1e6 + 1e-7) / 1e6).toFixed(6),
      '-i',
      source,
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      '[0:v]scale=' +
        width +
        ':' +
        height +
        ':force_original_aspect_ratio=decrease:force_divisible_by=2,' +
        'pad=' +
        width +
        ':' +
        height +
        ':(ow-iw)/2:(oh-ih)/2,setsar=1[base];' +
        '[base][1:v]overlay=0:0[v]',
      '-map',
      '[v]',
      '-map',
      '0:a:0?',
      '-frames:v',
      String(frameCount),
      '-t',
      duration.toFixed(9),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'passthrough',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      output,
    ],
    undefined,
    600_000,
    { signal, writesFile: true, stage: 'encoding labeled review clip' },
  );
  const { video } = await probeMedia(output, signal);
  const count = await countDecodedVideo(output, signal);
  if (video?.width !== width || video.height !== height || count !== frameCount)
    throw new MediaError(
      'Review clip failed its dimensions or decoded frame-count check.',
    );
  stage.update(frameCount);
}
