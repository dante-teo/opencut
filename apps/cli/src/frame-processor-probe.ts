import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FrameProcessorProbe } from './system.js';

const width = 640;
const height = 360;
const timing =
  'frame:0 pts:0\nlavfi.scd.score=0\nframe:1 pts:41667\nlavfi.scd.score=0\n';
const driverUnavailable =
  'IOServiceMatchingfailed for: AppleM2ScalerParavirtDriver';
const media = import.meta.resolve('@opencut/media');

const samples = [
  { effect: 'low-latency-interpolation', scales: [1], offline: false },
  { effect: 'frame-rate-conversion-quality', scales: [1], offline: true },
  { effect: 'low-latency-super-resolution', scales: [1.5, 2], mode: 'fast' },
  { effect: 'video-super-resolution', scales: [4], mode: 'video' },
  { effect: 'temporal-noise-filter', scales: [1], mode: 'noise' },
] as const;

type Probe = (typeof samples)[number];

async function processSample(sample: Probe, scale: number) {
  const dimensions = [String(width), String(height)];
  const interpolation = 'offline' in sample;
  const rgba = interpolation ? sample.offline : sample.mode === 'video';
  // Feed two SDR frames to the same worker that runs the recipe.
  const pixels = width * height;
  const frameBytes = rgba ? pixels * 4 : (pixels * 3) / 2;
  const frames = Buffer.alloc(2 * frameBytes, 128);
  if (!rgba) {
    frames.fill(48, 0, pixels);
    frames.fill(64, frameBytes, frameBytes + pixels);
  }
  const worker = fileURLToPath(
    new URL(interpolation ? './video-interpolate' : './video-enhance', media),
  );
  const args = interpolation
    ? [
        ...dimensions,
        sample.offline ? '1' : '0',
        '48',
        '1',
        '4',
        '1',
        '8',
        '[]',
      ]
    : [
        sample.mode,
        ...dimensions,
        String(scale),
        '2',
        '24',
        '1',
        '1',
        '0.5',
        '32',
      ];
  const expectedBytes = frameBytes * (interpolation ? 4 : 2 * scale ** 2);

  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(worker, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    let diagnostics = '';
    let bytes = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-8192);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && bytes === expectedBytes) resolve(true);
      else if (
        code === 1 &&
        diagnostics.split(/\r?\n/).includes(driverUnavailable) &&
        /Error Domain=VTFrameProcessorErrorDomain Code=-(19730|19740)\b/.test(
          diagnostics,
        )
      )
        resolve(false);
      else
        reject(
          new Error(
            `VideoToolbox sample for ${sample.effect} failed: ${diagnostics.trim() || `exit ${code}, ${bytes} bytes`}`,
          ),
        );
    });
    const input = child.stdin!;
    const metadata = child.stdio[3] as Writable;
    for (const stream of [input, metadata]) {
      stream.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
          child.kill('SIGKILL');
          reject(error);
        }
      });
    }
    metadata.end(timing);
    input.end(frames);
  });
}

export async function verifyGuestFrameProcessors(
  processors: Record<string, FrameProcessorProbe>,
) {
  // Some macOS guests accept a configuration before the driver fails on use.
  // Keep the advertised capability when the worker processes real frames.
  for (const sample of samples) {
    const processor = processors[sample.effect];
    if (!processor?.testedSizes) continue;
    const configs = processor.testedSizes
      .find((size) => size.width === width && size.height === height)
      ?.configurations.filter(
        (item) =>
          sample.scales.some((scale) => scale === item.scale) &&
          item.status === 'configuration-accepted' &&
          item.modelStatus !== 'downloading' &&
          item.modelStatus !== 'download-required',
      );
    if (!configs?.length) continue;

    let supported = false;
    for (const config of configs) {
      if (await processSample(sample, config.scale)) supported = true;
      else config.status = 'processing-unavailable';
    }
    if (supported) continue;
    processor.status = 'hardware-unsupported';
    processor.reason =
      'VideoToolbox could not process sample frames through the virtual machine driver.';
    delete processor.testedSizes;
  }
}
