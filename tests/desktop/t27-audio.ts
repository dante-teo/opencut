import type { Page } from '@playwright/test';
import { ffmpeg, probeFrameTimestamps } from './t27-comparison.js';

const sampleRate = 48000;
const frequencies = [440, 880] as const;

export function decodeAudio(path: string, channel: 0 | 1 = 0) {
  const timestamps = probeFrameTimestamps(path, 'a:0');
  if (timestamps.sampleRate !== sampleRate)
    throw new Error(
      `Expected ${sampleRate} Hz export audio, found ${timestamps.sampleRate}`,
    );
  const { frames, numerator, denominator } = timestamps;
  // Raw PCM has no PTS. Its indices represent the project clock only after
  // verifying that the decoded audio starts at zero and has no gaps or overlaps.
  let sampleCount = 0;
  for (const [i, { pts, nb_samples }] of frames.entries()) {
    if (
      pts === undefined ||
      !Number.isSafeInteger(pts) ||
      BigInt(pts) * BigInt(numerator) * BigInt(sampleRate) !==
        BigInt(sampleCount) * BigInt(denominator)
    )
      throw new Error(
        `Audio frame ${i} PTS ${pts} at ${numerator}/${denominator} does not match sample ${sampleCount}`,
      );
    if (
      nb_samples === undefined ||
      !Number.isSafeInteger(nb_samples) ||
      nb_samples <= 0
    )
      throw new Error(`Missing sample count for decoded audio frame ${i}`);
    sampleCount += nb_samples;
  }
  const pcm = ffmpeg([
    '-i',
    path,
    '-map',
    '0:a:0',
    '-c:a',
    'pcm_f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    '2',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  if (pcm.length !== sampleCount * 8)
    throw new Error(
      `Expected ${sampleCount} stereo PCM samples, decoded ${pcm.length} bytes`,
    );
  return {
    samples: Float32Array.from({ length: sampleCount }, (_, i) =>
      pcm.readFloatLE(i * 8 + channel * 4),
    ),
    startSeconds: (frames[0]!.pts! * numerator) / denominator,
    decodedFrames: frames.length,
  };
}

export function sampleOnsets(samples: Float32Array) {
  const result: number[] = [];
  let audible = false;
  for (let i = 0; i + 240 <= samples.length; i += 240) {
    const rms = Math.sqrt(
      samples.subarray(i, i + 240).reduce((sum, x) => sum + x * x, 0) / 240,
    );
    const active = rms > 0.04;
    if (active && !audible) result.push(i / sampleRate);
    audible = active;
  }
  return result;
}

export function exportAmplitudes(samples: Float32Array, time: number) {
  const start = Math.round(time * sampleRate) - 1024;
  const window = samples.subarray(start, start + 2048);
  if (window.length !== 2048)
    throw new Error(`Incomplete PCM analysis window at ${time}s`);
  return frequencies.map((hz) => {
    let sine = 0,
      cosine = 0;
    for (let i = 0; i < window.length; i++) {
      const phase = (2 * Math.PI * hz * i) / sampleRate;
      const weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / window.length);
      sine += window[i]! * weight * Math.sin(phase);
      cosine += window[i]! * weight * Math.cos(phase);
    }
    return (4 * Math.hypot(sine, cosine)) / window.length;
  });
}

// Attach a parallel analyser to the production limiter's output. Leave the
// graph, media elements, master gains and real-time clock connected as usual.
export async function observeAudioOutput(page: Page) {
  await page.evaluate(() => {
    const Native = window.AudioContext;
    const probe = { analyser: null as AnalyserNode | null };
    Object.assign(window, { t27Audio: probe });
    window.AudioContext = class extends Native {
      override createDynamicsCompressor() {
        const compressor = super.createDynamicsCompressor();
        const analyser = this.createAnalyser();
        analyser.channelCount = 2;
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        compressor.connect(analyser);
        probe.analyser = analyser;
        return compressor;
      }
    };
  });
}

export async function recordPreviewAudio(page: Page) {
  return page
    .locator('#project-viewer canvas')
    .evaluate(async (canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')!;
      const trace: {
        time: number;
        white: boolean;
        hz440: number;
        hz880: number;
      }[] = [];
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        function observe() {
          const analyser = (
            window as unknown as { t27Audio: { analyser: AnalyserNode | null } }
          ).t27Audio.analyser;
          const [n, d] = (canvas.dataset.position ?? '0/1')
            .split('/')
            .map(Number);
          const time = n! / d!;
          if (analyser && time > 0) {
            const bins = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(bins);
            const amplitude = (hz: number) => {
              const bin = Math.round(
                (hz * analyser.fftSize) / analyser.context.sampleRate,
              );
              // Blackman window coherent gain = 0.42; adjacent bins cover drift
              // correction (±2%) and finite frequency bin resolution.
              return (
                (2 / 0.42) *
                10 ** (Math.max(...bins.slice(bin - 2, bin + 3)) / 20)
              );
            };
            trace.push({
              time,
              white: ctx.getImageData(10, 10, 1, 1).data[0]! > 200,
              hz440: amplitude(440),
              hz880: amplitude(880),
            });
          }
          if (time >= 3.37) resolve();
          else if (performance.now() - start > 10000)
            reject(new Error('Timed out recording the real-time preview mix'));
          else requestAnimationFrame(observe);
        }
        requestAnimationFrame(observe);
      });
      return trace;
    });
}
