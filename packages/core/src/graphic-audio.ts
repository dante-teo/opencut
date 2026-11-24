import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeGraphicAudio, sampleGraphicAudio } from '@opencut/media';
import type { GraphicLayer, VideoTimelineOptions } from '@opencut/media';
import type { GraphicAudioAnalysis } from '@opencut/shared';
import { frameTime } from './time.js';
import { hashJson } from './video-integrity.js';
import { VideoDefinitionError } from './video-definition.js';
import type { ParsedVideoDefinition } from './video-definition.js';
import type { CompiledVideo } from './video-compiler.js';

export function checkGraphicAudio({ assets, tracks }: ParsedVideoDefinition) {
  const trackIds = new Set(
    tracks
      .filter(({ type }) => type === 'video' || type === 'audio')
      .flatMap(({ id }) => (id ? [id] : [])),
  );
  for (const [id, asset] of Object.entries(assets ?? {})) {
    if (
      asset.kind !== 'graphic' ||
      !('audioAnalysis' in asset) ||
      !asset.audioAnalysis
    )
      continue;
    const { source } = asset.audioAnalysis;
    if (source === 'mix' || trackIds.has(source.track)) continue;
    const referenced = assets?.[source.track];
    const issue =
      referenced?.kind === 'graphic'
        ? `Invalid visual-to-audio dependency '${id}' -> '${source.track}': graphic assets cannot supply audio.`
        : `Expected an explicit audio or video track ID, received '${source.track}'.`;
    throw new VideoDefinitionError(
      `assets.${id}.audioAnalysis.source: ${issue}`,
    );
  }
}

type Plan = Awaited<ReturnType<CompiledVideo['resolveRender']>>;
type Analysis = Awaited<ReturnType<typeof decodeGraphicAudio>>;
export type GraphicAudioControls = Pick<
  VideoTimelineOptions,
  | 'audioComparison'
  | 'audioChannels'
  | 'audioSampleRate'
  | 'audioBitrateKbps'
  | 'onProgress'
>;

/** The dependency edges run from graphic -> analysis -> resolved audio inputs. */
export function bindGraphicAudio(
  video: CompiledVideo,
  plan: Plan & Pick<VideoTimelineOptions, 'boundSourceIdentity'>,
  scratch: () => Promise<string>,
  snapshotSource: VideoTimelineOptions['snapshotSource'],
  controls: GraphicAudioControls,
  signal?: AbortSignal,
) {
  const recipes = new Map<
    string,
    {
      settings: GraphicAudioAnalysis;
      options: VideoTimelineOptions;
      key: string;
    }
  >();
  const tracks = new Map(
    video.project.clips.map(({ id, trackId }) => [id, trackId]),
  );
  const withAnalysis = [
    ...plan.visualClips,
    ...(plan.visualTransitions ?? []).flatMap(({ layers }) => layers),
  ];
  for (const clip of withAnalysis) {
    const graphic = clip.graphic;
    const settings = graphic?.audioAnalysis;
    if (!settings) continue;
    const { source } = settings;
    const mixed = source === 'mix';
    const audioClips = plan.audioClips.filter(
      ({ clipId }) => source === 'mix' || tracks.get(clipId) === source.track,
    );
    const options: VideoTimelineOptions = {
      ...plan,
      output: video.path,
      audioClips,
      ...(snapshotSource && {
        snapshotSource: (path: string) =>
          snapshotSource(path, 'graphic audio analysis'),
      }),
      signal,
      ...controls,
    };
    if (!mixed) {
      delete options.professionalMix;
      delete options.musicComparison;
    }
    const analysisSettings = {
      version: settings.version,
      source: settings.source,
      window: settings.window,
      hop: settings.hop,
      waveform: settings.waveform,
      bins: settings.bins,
    };
    const key = hashJson([
      'opencut-audio-fft4.0.4-v1/48000',
      analysisSettings,
      plan.frameRate,
      plan.frameCount,
      options.audioComparison ?? 'after',
      options.professionalMix,
      ...(options.professionalMix && options.professionalMix.enabled !== false
        ? [
            options.audioChannels ?? 2,
            options.audioSampleRate ?? 48000,
            options.audioBitrateKbps ?? 192,
          ]
        : []),
      options.musicComparison,
      mixed ? video.audioMixEdit : undefined,
      audioClips.map((clip) => [clip, video.sourceIdentity(clip.path)]),
    ]);
    // Beat markers affect pixels and leave the slower FFT reusable.
    const pictureKey = hashJson([graphic.key, key, settings.beats]);
    clip.graphic = { ...graphic, key: pictureKey };
    recipes.set(pictureKey, { settings, options, key });
  }
  const pending = new Map<string, Promise<Analysis>>();
  return async (graphic: GraphicLayer, frame: number, clipId: string) => {
    if (!graphic.audioAnalysis) return;
    const recipe = recipes.get(graphic.key);
    if (!recipe)
      throw new VideoDefinitionError(
        'Missing compiled audio analysis dependency.',
      );
    const { settings, options, key } = recipe;
    let analysis = pending.get(key);
    if (!analysis) {
      const { onProgress } = options;
      analysis = decodeGraphicAudio(
        key,
        settings,
        onProgress
          ? {
              ...options,
              onProgress: (event) => onProgress({ ...event, clipId }),
            }
          : options,
        async () => mkdtemp(join(await scratch(), 'analysis-')),
        video.build?.processing.directory,
      );
      pending.set(key, analysis);
    }
    const result = await analysis;
    const from = frameTime(frame, plan.frameRate);
    const to = frameTime(frame + 1, plan.frameRate);
    return {
      key: frame,
      sample: sampleGraphicAudio(
        result,
        settings,
        from.numerator / from.denominator,
        to.numerator / to.denominator,
      ),
    };
  };
}
