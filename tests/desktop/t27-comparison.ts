import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
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

export function exportProject(
  directory: string,
  name: string,
  projectPath: string,
) {
  const output = join(directory, `${name}.mp4`);
  command(process.execPath, [
    resolve('apps/cli/dist/index.js'),
    'project',
    'render',
    projectPath,
    '--output',
    output,
    '--json',
  ]);
  return output;
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
  const rgb = ffmpeg([
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    `select='${frames.map((frame) => `eq(n,${frame})`).join('+')}'`,
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

// Observe production draw calls without replacing frames, the clock or the compositor.
export async function observeNativePaint(page: Page) {
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const clear = proto.clearRect;
    const draw = proto.drawImage;
    proto.clearRect = function (...args) {
      this.canvas.dataset.nativeVideoTimes = '[]';
      return clear.apply(this, args);
    };
    proto.drawImage = function (source: CanvasImageSource, ...args: number[]) {
      Reflect.apply(draw, this, [source, ...args]);
      const times = JSON.parse(
        this.canvas.dataset.nativeVideoTimes ?? '[]',
      ) as number[];
      if (source instanceof HTMLVideoElement) times.push(source.currentTime);
      if (source instanceof HTMLCanvasElement)
        times.push(
          ...(JSON.parse(source.dataset.nativeVideoTimes ?? '[]') as number[]),
        );
      this.canvas.dataset.nativeVideoTimes = JSON.stringify(times);
    };
  });
}

export async function readCanvas(
  page: Page,
  position: string,
  layers: string[],
  videoTimes: number[],
) {
  const data = await page.locator('#project-viewer canvas').evaluate(
    (element: HTMLCanvasElement, expected) => {
      const { dataset, width, height } = element;
      const nativeVideoTimes = JSON.parse(
        dataset.nativeVideoTimes ?? '[]',
      ) as number[];
      if (
        dataset.position !== expected.position ||
        dataset.presentedLayers !== JSON.stringify(expected.layers) ||
        nativeVideoTimes.length !== expected.videoTimes.length ||
        nativeVideoTimes.some(
          (time, i) => Math.abs(time - expected.videoTimes[i]!) > 0.00001,
        )
      )
        return null;
      const rgba = element
        .getContext('2d')!
        .getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4)
        for (let c = 0; c < 3; c++)
          rgb[j++] = Math.round((rgba[i + c]! * rgba[i + 3]!) / 255);
      let binary = '';
      for (let i = 0; i < rgb.length; i += 16384)
        binary += String.fromCharCode(...rgb.subarray(i, i + 16384));
      return { width, height, nativeVideoTimes, rgb: btoa(binary) };
    },
    { position, layers, videoTimes },
  );
  return data && { ...data, rgb: Buffer.from(data.rgb, 'base64') };
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

export function saveDiff(
  directory: string,
  label: string,
  preview: Buffer,
  exported: Buffer,
  width: number,
  height: number,
) {
  const diff = Buffer.alloc(preview.length);
  for (let i = 0; i < diff.length; i++)
    diff[i] = Math.min(255, 4 * Math.abs(preview[i]! - exported[i]!));
  return Object.entries({ preview, export: exported, diff }).map(
    ([kind, rgb]) => {
      const file = `${label}-${kind}.png`;
      ffmpeg(
        [
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-s',
          `${width}x${height}`,
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-update',
          '1',
          '-n',
          join(directory, file),
        ],
        rgb,
      );
      return file;
    },
  );
}
