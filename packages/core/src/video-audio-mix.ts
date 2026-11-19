import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeTimelineAudioMix, MediaError } from '@opencut/media';
import type { AudioMixCache, RenderControls } from '@opencut/media';
import { materializeMediaEntry } from './video-media-cache.js';
import { withRenderSources } from './render-sources.js';
import type { CompiledVideo } from './video-compiler.js';

export async function openAudioMixCache(
  directory: string | undefined,
  signal: AbortSignal = new AbortController().signal,
): Promise<AudioMixCache | undefined> {
  if (directory === undefined) return;
  if (!directory.trim())
    throw new MediaError('Choose an audio mix cache directory.');
  const root = resolve(directory, 'audio-mix-v1');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cache = await realpath(root);
  return {
    async materialize(key, encode) {
      const { entry } = await materializeMediaEntry(
        cache,
        key,
        'wav',
        signal,
        encode,
      );
      return entry.metadata.path;
    },
  };
}

export type AudioMixAnalysisOptions = Pick<
  RenderControls,
  | 'signal'
  | 'audioSampleRate'
  | 'audioChannels'
  | 'audioBitrateKbps'
  | 'audioComparison'
> & {
  audioMixCacheDirectory?: string | undefined;
};

/** Analyze the exact PCM mix and decoded AAC without composing the picture. */
export async function analyzeVideoMix(
  video: CompiledVideo,
  { audioMixCacheDirectory, ...settings }: AudioMixAnalysisOptions = {},
) {
  const { signal } = settings;
  return withRenderSources(video, signal, async (plan) => {
    const audioMixCache = await openAudioMixCache(
      audioMixCacheDirectory,
      signal,
    );
    return analyzeTimelineAudioMix({
      ...plan,
      ...settings,
      ...(audioMixCache && { audioMixCache }),
      output: join(tmpdir(), 'mix.mp4'),
      scratchDirectory: tmpdir(),
    });
  });
}
