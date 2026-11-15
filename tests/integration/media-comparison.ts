import { spawnSync } from 'node:child_process';
import type { FrameRate } from '@opencut/core';

export function command(executable: string, args: string[], input?: Buffer) {
  const result = spawnSync(executable, args, {
    input,
    timeout: 120_000,
    maxBuffer: 128 * 1024 ** 2,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${executable}: ${result.error?.message ?? (result.stderr.toString().trim() || result.signal)}`,
    );
  return result.stdout;
}

export function ffmpeg(args: string[], input?: Buffer) {
  return command('ffmpeg', ['-v', 'error', '-nostdin', ...args], input);
}

export function probeFrameTimestamps(path: string, stream: 'v:0' | 'a:0') {
  const { streams, frames } = JSON.parse(
    command('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      stream,
      '-show_streams',
      '-show_frames',
      '-show_entries',
      'stream=time_base,sample_rate:frame=pts,nb_samples',
      '-of',
      'json',
      path,
    ]).toString(),
  ) as {
    streams: { time_base: string; sample_rate?: string }[];
    frames: { pts?: number; nb_samples?: number }[];
  };
  const info = streams[0];
  if (!info || !frames?.length)
    throw new Error(`No decoded timestamps for ${stream} in ${path}`);
  const [numerator, denominator] = info.time_base.split('/').map(Number);
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator! <= 0 ||
    denominator! <= 0
  )
    throw new Error(`Invalid ${stream} time base: ${info.time_base}`);
  return {
    numerator: numerator!,
    denominator: denominator!,
    frames,
    sampleRate: Number(info.sample_rate),
  };
}

export function verifyVideoTimestamps(
  path: string,
  frameRate: FrameRate,
  count: number,
) {
  const { numerator, denominator, frames } = probeFrameTimestamps(path, 'v:0');
  if (frames.length !== count)
    throw new Error(
      `Expected ${count} decoded video frames, found ${frames.length}`,
    );
  return frames.map(({ pts }, frame) => {
    // Compare ticks as exact rationals before using seconds in the report.
    if (
      pts === undefined ||
      !Number.isSafeInteger(pts) ||
      BigInt(pts) * BigInt(numerator) * BigInt(frameRate.numerator) !==
        BigInt(frame) * BigInt(frameRate.denominator) * BigInt(denominator)
    )
      throw new Error(
        `Video frame ${frame} PTS ${pts} at ${numerator}/${denominator} is off the project grid`,
      );
    return (pts * numerator) / denominator;
  });
}

export function decodeFrames(
  path: string,
  indices: number[],
  width: number,
  height: number,
) {
  const frames = [...new Set(indices)].sort((a, b) => a - b);
  const first = frames[0]!;
  const last = frames.at(-1)!;
  const selection =
    last - first + 1 === frames.length
      ? `trim=start_frame=${first}:end_frame=${last + 1}`
      : `select='${frames.map((frame) => `eq(n,${frame})`).join('+')}'`;
  const rgb = ffmpeg([
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    selection,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    String(frames.length),
    '-pix_fmt',
    'rgb24',
    '-threads',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  const stride = width * height * 3;
  if (rgb.length !== stride * frames.length)
    throw new Error(
      `Expected ${frames.length} RGB frames (${width}×${height}); decoded ${rgb.length} bytes`,
    );
  return new Map(
    frames.map((frame, i) => [
      frame,
      rgb.subarray(i * stride, (i + 1) * stride),
    ]),
  );
}

export interface Tolerance {
  mean: number;
  p95: number;
  largePixelFraction: number;
}

export function compareRgb(
  preview: Buffer,
  exported: Buffer,
  tolerance: Tolerance,
) {
  if (
    !preview.length ||
    preview.length !== exported.length ||
    preview.length % 3
  )
    throw new Error('Expected equal-sized RGB24 images');
  const histogram = new Uint32Array(256);
  let total = 0;
  let large = 0;
  for (let i = 0; i < preview.length; i += 3) {
    let max = 0;
    for (let c = i; c < i + 3; c++) {
      const error = Math.abs(preview[c]! - exported[c]!);
      histogram[error]!++;
      total += error;
      max = Math.max(error, max);
    }
    if (max > 48) large++;
  }
  let p95 = 0;
  let count = histogram[0]!;
  while (count < Math.ceil(preview.length * 0.95)) count += histogram[++p95]!;
  const metrics = {
    mean: total / preview.length,
    p95,
    largePixelFraction: large / (preview.length / 3),
  };
  return {
    metrics,
    passed:
      metrics.mean <= tolerance.mean &&
      metrics.p95 <= tolerance.p95 &&
      metrics.largePixelFraction <= tolerance.largePixelFraction,
  };
}
