import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LRUCache } from 'lru-cache';
import { audioSampleAtFrame } from './audio-graph.js';
import type { AudioRenderClip } from './audio-graph.js';
import { measureAudioLoudness } from './audio-mastering.js';
import type { LoudnessMeasurement } from './audio-mastering.js';
import { renderAudioGraph } from './professional-mix.js';
import type { MediaMetadata } from './probe.js';
import { checkRenderSignal, MediaError, sourceFileStamp } from './process.js';
import type { VideoTimelineOptions } from './render.js';

const measurements = new LRUCache<string, LoudnessMeasurement>({ max: 128 });

export interface MusicLoudnessReport {
  targetLufs: number | null;
  gainDb: number;
  candidates: Record<string, LoudnessMeasurement>;
}

export async function prepareMusicComparison(
  options: VideoTimelineOptions,
  readSource: (clip: AudioRenderClip) => Promise<MediaMetadata>,
  scratch?: string,
): Promise<{
  options: VideoTimelineOptions;
  musicLoudness?: MusicLoudnessReport;
  warnings?: string[];
}> {
  const { signal, musicComparison } = options;
  if (!musicComparison) return { options };
  const { candidates, selected, matchLoudness } = musicComparison;
  const candidateIds = new Set(candidates);
  if (
    candidates.length < 2 ||
    candidates.length > 8 ||
    candidateIds.size !== candidates.length ||
    !candidateIds.has(selected)
  )
    throw new MediaError(
      'Choose one of two to eight distinct music candidate tracks.',
    );
  const allClips = options.audioClips ?? [];
  const audioClips = allClips.filter(
    (clip) =>
      !candidateIds.has(clip.trackId ?? '') || clip.trackId === selected,
  );
  if (!matchLoudness || !scratch)
    return { options: { ...options, audioClips } };

  const directory = join(scratch, 'music-comparison');
  await mkdir(directory);
  const samples = audioSampleAtFrame(options.frameCount, options.frameRate);
  const measured = new Map<string, LoudnessMeasurement>();
  let targetLufs: number | null = null;
  let allMeasurable = true;
  // Choose a common target after trim and fades and before ducking, keeping
  // peak headroom for every candidate and bounding gain on quiet beds.
  for (const [index, candidate] of candidates.entries()) {
    checkRenderSignal(signal);
    const clips = allClips.filter((clip) => clip.trackId === candidate);
    if (!clips.length || clips.some((clip) => clip.role !== 'music'))
      throw new MediaError(
        `Candidate '${candidate}' must be a music track with clips.`,
      );
    const stamps = await Promise.all(
      clips.map((clip) => sourceFileStamp(clip.path)),
    );
    const key = createHash('sha256')
      .update(JSON.stringify([samples, options.frameRate, stamps, clips]))
      .digest('hex');
    let level = measurements.get(key);
    if (!level) {
      const path = join(directory, `track-${index}.wav`);
      try {
        await renderAudioGraph(
          path,
          path + '.ffscript',
          { ...options, audioClips: clips },
          readSource,
          samples,
          {},
          48000,
          2,
        );
        level = await measureAudioLoudness(path, signal);
        measurements.set(key, level);
      } finally {
        await rm(path, { force: true });
      }
    }
    measured.set(candidate, level);
    const { integratedLufs, truePeakDbtp } = level;
    if (integratedLufs === null || truePeakDbtp === null) allMeasurable = false;
    else
      targetLufs = Math.min(
        targetLufs ?? -23,
        integratedLufs + Math.min(18, -3 - truePeakDbtp),
      );
  }
  const level = measured.get(selected)?.integratedLufs;
  const gainDb =
    targetLufs === null || level == null
      ? 0
      : Number((targetLufs - level).toFixed(4));
  return {
    options: {
      ...options,
      audioClips: audioClips.map((clip) =>
        clip.trackId === selected ? { ...clip, musicGainDb: gainDb } : clip,
      ),
    },
    musicLoudness: {
      targetLufs,
      gainDb,
      candidates: Object.fromEntries(measured),
    },
    warnings: allMeasurable
      ? []
      : [
          'At least one music candidate was too quiet or short to measure for loudness matching.',
        ],
  };
}
