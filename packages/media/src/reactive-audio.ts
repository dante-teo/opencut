import { openAudioAnalysisRecord } from './audio-analysis-cache.js';
import type { AudioSeries } from './audio-analysis-cache.js';
import { join } from 'node:path';
import { LRUCache } from 'lru-cache';
import { lerp } from '@opencut/shared';
import type { GraphicAudioAnalysis, GraphicAudioSample } from '@opencut/shared';
import { audioSampleAtFrame } from './audio-graph.js';
import { analyzeGraphicAudio } from './media-engine.js';
import { prepareMusicComparison } from './music-comparison.js';
import {
  prepareProfessionalMix,
  renderAudioGraph,
} from './professional-mix.js';
import { MediaError } from './process.js';
import { renderProgress } from './render-progress.js';
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
  const analysis = renderProgress(plan.frameCount, plan.onProgress, {
    stage: 'audio-analysis',
  });
  analysis.start();
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
    const mastering = renderProgress(plan.frameCount, plan.onProgress, {
      stage: 'audio-mastering',
    });
    const music = await prepareMusicComparison(plan, readSource, directory);
    const result = await prepareProfessionalMix(
      music.options,
      mix,
      directory,
      readSource,
      { base: samples, from: 0, to: samples },
      mastering.start,
    );
    mastering.update(plan.frameCount);
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
  const series = await analyzeGraphicAudio(
    sourcePath,
    samples,
    settings,
    plan.signal,
  );
  await record?.publish(series, stride);
  analysis.update(plan.frameCount);
  saved.set(key, series);
  return series;
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
