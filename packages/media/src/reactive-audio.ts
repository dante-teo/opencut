import { createReadStream } from 'node:fs';
import { openAudioAnalysisRecord } from './audio-analysis-cache.js';
import type { AudioSeries } from './audio-analysis-cache.js';
import { join } from 'node:path';
import FFT from 'fft.js';
import { LRUCache } from 'lru-cache';
import { lerp } from '@opencut/shared';
import type { GraphicAudioAnalysis, GraphicAudioSample } from '@opencut/shared';
import { audioSampleAtFrame } from './audio-graph.js';
import { renderAudioFile } from './audio-mastering.js';
import { prepareMusicComparison } from './music-comparison.js';
import {
  prepareProfessionalMix,
  renderAudioGraph,
} from './professional-mix.js';
import { MediaError } from './process.js';
import type { VideoTimelineOptions } from './render.js';

const sampleRate = 48_000;

const saved = new LRUCache<string, AudioSeries>({
  maxSize: 96 * 1024 * 1024,
  sizeCalculation: (series) => series.features.byteLength,
});

export async function decodeGraphicAudio(
  key: string,
  settings: GraphicAudioAnalysis,
  plan: VideoTimelineOptions,
  scratch: () => Promise<string>,
  cacheDirectory?: string,
): Promise<AudioSeries> {
  plan.signal?.throwIfAborted();
  const cached = saved.get(key);
  if (cached) return cached;
  const stride = 1 + settings.waveform + settings.bins;
  const record = await openAudioAnalysisRecord(
    cacheDirectory,
    key,
    plan.signal,
  );
  const existing = await record?.read(stride);
  if (existing) {
    saved.set(key, existing);
    return existing;
  }
  const directory = await scratch();
  const readSource = async ({ path }: { path: string }) => {
    const result = plan.sourceMetadata?.get(path);
    if (!result)
      throw new MediaError(`No pinned audio metadata for '${path}'.`);
    return result;
  };
  const samples = audioSampleAtFrame(plan.frameCount, plan.frameRate);
  const mix = plan.professionalMix;
  const waveformPath = join(directory, 'analysis.wav');
  let sourcePath = waveformPath;
  if (mix && mix.enabled !== false) {
    const music = await prepareMusicComparison(plan, readSource, directory);
    const result = await prepareProfessionalMix(
      music.options,
      mix,
      directory,
      readSource,
      { base: samples, from: 0, to: samples },
    );
    sourcePath = result.path;
  } else {
    const music = await prepareMusicComparison(plan, readSource, directory);
    await renderAudioGraph(
      waveformPath,
      join(directory, 'analysis.ffscript'),
      music.options,
      readSource,
      samples,
      { bypassChannelMode: plan.audioComparison === 'before' },
      sampleRate,
      1,
    );
  }
  const mono = join(directory, 'mono.f32');
  await renderAudioFile(
    [
      '-threads',
      '1',
      '-i',
      sourcePath,
      '-map',
      '0:a:0',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-f',
      'f32le',
    ],
    mono,
    plan.signal,
  );
  const series = await analyzePcm(mono, samples, settings, plan.signal);
  await record?.publish(series, stride);
  saved.set(key, series);
  return series;
}

export async function analyzePcm(
  path: string,
  samples: number,
  { window, hop, waveform, bins }: GraphicAudioAnalysis,
  signal?: AbortSignal,
): Promise<AudioSeries> {
  const count = Math.ceil(samples / hop) + 1;
  const stride = 1 + waveform + bins;
  if (count * stride * 4 > 64 * 1024 * 1024)
    throw new MediaError(
      'Audio analysis exceeds 64 MiB. Increase hop or reduce output features.',
    );
  const features = new Float32Array(count * stride);
  const ring = new Float32Array(window);
  const fft = new FFT(window);
  const inWindow = new Float64Array(window);
  const out = fft.createComplexArray() as number[];
  const hann = Float32Array.from(
    { length: window },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / window),
  );
  let write = 0;
  let center = 0;
  let row = 0;

  function readWindow() {
    const offset = row * stride;
    let square = 0;
    // The center tick is emitted after reading the right half-window.
    for (let i = 0; i < window; i++) {
      const input = ring[(write + i) % window]!;
      inWindow[i] = input * hann[i]!;
      square += input * input;
      const bucket = offset + 1 + Math.floor((i * waveform) / window);
      if (Math.abs(input) > Math.abs(features[bucket]!))
        features[bucket] = input;
    }
    features[offset] = Math.sqrt(square / window);
    fft.realTransform(out, inWindow);
    for (let i = 0; i < bins; i++)
      features[offset + 1 + waveform + i] =
        (4 * Math.hypot(out[2 * i]!, out[2 * i + 1]!)) / window;
    row++;
    center += hop;
  }

  let read = 0;
  function push(value: number) {
    ring[write] = value;
    write = (write + 1) % window;
    read++;
    if (row < count && read >= center + window / 2) readWindow();
  }

  let tail: Buffer = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, {
    signal,
    highWaterMark: 64 * 1024,
  })) {
    const input = tail.length
      ? Buffer.concat([tail, chunk as Buffer])
      : (chunk as Buffer);
    const end = input.length - (input.length % 4);
    for (let i = 0; i < end; i += 4) {
      if (read >= samples) break;
      push(input.readFloatLE(i));
    }
    tail = input.subarray(end);
  }
  if (tail.length)
    throw new MediaError('Incomplete PCM sample during audio analysis.');
  while (row < count) {
    signal?.throwIfAborted();
    push(0);
  }
  return { features, count };
}

export function sampleGraphicAudio(
  { features, count }: AudioSeries,
  { hop, waveform, bins, beats }: GraphicAudioAnalysis,
  seconds: number,
  endSeconds: number,
): GraphicAudioSample {
  const tick = Math.max(0, Math.min(count - 1, (seconds * sampleRate) / hop));
  const start = Math.floor(tick);
  const end = Math.min(start + 1, count - 1);
  const stride = 1 + waveform + bins;
  const value = (index: number) =>
    lerp(
      features[start * stride + index]!,
      features[end * stride + index]!,
      tick - start,
    );
  return {
    rms: value(0),
    waveform: Array.from({ length: waveform }, (_, i) => value(i + 1)),
    spectrum: Array.from({ length: bins }, (_, i) => value(i + waveform + 1)),
    beat:
      beats?.some(
        ({ numerator, denominator }) =>
          numerator / denominator >= seconds &&
          numerator / denominator < endSeconds,
      ) ?? false,
  };
}
