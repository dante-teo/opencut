import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  inspectEncodedPicture,
  MediaError,
  renderVideoTimeline,
} from '@opencut/media';
import type { RenderControls } from '@opencut/media';
import { authoredInputs, checkpointRender } from './video-build.js';
import { withRenderSources } from './render-sources.js';
import type { CompiledVideo } from './video-compiler.js';
import type { VideoProcessingOptions } from './video-processing.js';
import { compileVideo } from './video-files.js';
import type { VideoBuild, VideoCompileOptions } from './video-files.js';
import { isInterpolationStep } from './video-recipe-schema.js';
import type { VideoMixEdit } from '@opencut/shared';
import { openAudioMixCache } from './video-audio-mix.js';
import { openPictureCache } from './video-picture-cache.js';
import { describeMusicComparison } from './music-comparison.js';
import { inspectVideoLayout, VideoLayoutError } from './video-layout.js';
import {
  describeRevisionPlan,
  revisionRenderSettings,
} from './video-revision.js';
import type { RevisionEvidence } from './video-revision.js';
import { fingerprintFile } from './video-integrity.js';
import type { VideoTimelineOptions } from '@opencut/media';

export type VideoRenderOptions = Omit<
  RenderControls,
  'range' | 'maxDimension'
> & {
  burnSubtitles?: boolean;
  pictureCacheDirectory?: string | undefined;
  pictureVersion?: string | undefined;
  audioMixCacheDirectory?: string | undefined;
  audioMixEdit?: VideoCompileOptions['audioMixEdit'];
  processing?: VideoProcessingOptions | undefined;
  params?: VideoCompileOptions['params'];
  musicSelection?: VideoCompileOptions['musicSelection'];
  revisionEvidence?: boolean | undefined;
  pictureFrom?: VideoTimelineOptions['pictureFrom'] | undefined;
};

export type CompiledVideoRenderOptions = Omit<
  VideoRenderOptions,
  'processing' | 'params' | 'audioMixEdit' | 'musicSelection'
>;
export type VideoRenderConfiguration = Omit<
  RenderControls,
  'onProgress' | 'signal' | 'overwrite'
> &
  Pick<CompiledVideoRenderOptions, 'burnSubtitles' | 'pictureVersion'> & {
    audioMixEdit?: VideoMixEdit;
    musicSelection?: { candidate: string; matchLoudness: boolean };
  };
export interface VideoRenderBuild extends VideoBuild {
  readonly version: 1;
  readonly render: Readonly<VideoRenderConfiguration>;
}

async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

/** Protect the definition and every declared source, including unused assets. */
export async function protectRenderInputs(
  video: CompiledVideo,
  output: string,
  boundSources: Iterable<string>,
  signal?: AbortSignal,
) {
  const destination = await statIfPresent(resolve(output));
  if (!destination) return;
  for (const path of new Set([
    ...boundSources,
    ...authoredInputs(video),
    ...video.graphicInputs.map(({ path }) => path),
    video.path,
    ...video.project.assets.map(({ file }) =>
      resolve(dirname(video.path), file.path),
    ),
  ])) {
    signal?.throwIfAborted();
    const source = await statIfPresent(path);
    if (source?.dev === destination.dev && source.ino === destination.ino)
      throw new MediaError(`Render output must not replace input '${path}'.`);
  }
}

/** Render one compiled revision using the shared media engine. */
export async function renderCompiledVideo(
  video: CompiledVideo,
  output: string,
  {
    burnSubtitles = true,
    quality = 'quality',
    pictureCacheDirectory,
    audioMixCacheDirectory,
    revisionEvidence,
    pictureFrom,
    ...options
  }: CompiledVideoRenderOptions = {},
) {
  const { onProgress, signal, overwrite, ...settings } = options;
  video = await video.forQuality(quality, !burnSubtitles, signal);
  const layout =
    !pictureFrom && video.layoutAssertions?.length
      ? await inspectVideoLayout(video, { burnSubtitles, signal })
      : undefined;
  if (layout && !layout.ok) throw new VideoLayoutError(layout);
  const musicComparison = describeMusicComparison(video.project);
  const musicSelection = musicComparison && {
    candidate: musicComparison.selected,
    matchLoudness: musicComparison.matchLoudness,
  };
  // Record the controls the shared renderer receives, including runtime callers.
  const { range, maxDimension }: RenderControls = settings;
  const build: VideoRenderBuild | undefined = video.build && {
    version: 1,
    ...video.build,
    render: {
      quality,
      codec: settings.codec ?? 'h264',
      ...(settings.encoder && { encoder: settings.encoder }),
      resolution: settings.resolution ?? 'project',
      ...(range !== undefined && { range: structuredClone(range) }),
      ...(maxDimension !== undefined && { maxDimension }),
      ...(settings.outputSize !== undefined && {
        outputSize: structuredClone(settings.outputSize),
      }),
      ...(settings.outputFrameRate !== undefined && {
        outputFrameRate: structuredClone(settings.outputFrameRate),
      }),
      ...(settings.videoBitrateKbps !== undefined && {
        videoBitrateKbps: settings.videoBitrateKbps,
      }),
      audioBitrateKbps: settings.audioBitrateKbps ?? 192,
      audioSampleRate: settings.audioSampleRate ?? 48000,
      audioChannels: settings.audioChannels ?? 2,
      burnSubtitles,
      ...(settings.pictureVersion && {
        pictureVersion: settings.pictureVersion,
      }),
      ...(settings.audioComparison && {
        audioComparison: settings.audioComparison,
      }),
      ...(video.audioMixEdit && { audioMixEdit: video.audioMixEdit }),
      ...(musicSelection && { musicSelection }),
    },
  };
  const buildMetadata = build && JSON.stringify(build);
  const graphicSampling = { holdRenders: 0, holdReuses: 0 };
  signal?.throwIfAborted();
  return checkpointRender(
    video,
    output,
    {
      ...settings,
      quality,
      burnSubtitles,
      ...(video.audioMixEdit && { audioMixEdit: video.audioMixEdit }),
      ...(musicSelection && { musicSelection }),
    },
    signal,
    (scratchDirectory, onVerifiedOutput) =>
      withRenderSources(
        video,
        signal,
        async (plan) => {
          if (overwrite)
            await protectRenderInputs(
              video,
              output,
              plan.sourceMetadata.keys(),
              signal,
            );
          if (!burnSubtitles)
            plan.visualClips = plan.visualClips.filter(
              (clip) => !clip.subtitle,
            );
          const pictureCache =
            pictureCacheDirectory === undefined
              ? undefined
              : await openPictureCache(pictureCacheDirectory, video, signal);
          const audioMixCache = await openAudioMixCache(
            audioMixCacheDirectory,
            signal,
          );
          const evidenceSettings = revisionRenderSettings({
            ...settings,
            quality,
            burnSubtitles,
          });
          const evidencePlan = revisionEvidence
            ? await describeRevisionPlan(
                video,
                { ...plan, ...settings, quality, signal, overwrite, output },
                evidenceSettings,
              )
            : undefined;
          let evidence: RevisionEvidence | undefined;
          let fingerprint: { bytes: number; sha256: string } | undefined;
          const result = await renderVideoTimeline({
            ...plan,
            ...(pictureFrom && { pictureFrom }),
            ...settings,
            quality,
            signal,
            overwrite,
            pictureCache,
            ...(audioMixCache && { audioMixCache }),
            ...(onProgress && { onProgress }),
            ...(buildMetadata && { buildMetadata }),
            ...(scratchDirectory && { scratchDirectory }),
            async onVerifiedOutput(staged, verifiedPicture) {
              if (evidencePlan) {
                const encoded =
                  verifiedPicture ??
                  (await inspectEncodedPicture(staged, signal));
                evidencePlan.checkInputs();
                const rate = settings.outputFrameRate ?? plan.frameRate;
                evidence = {
                  version: 1,
                  settings: evidenceSettings,
                  timeline: evidencePlan.timeline,
                  packetHash: encoded.packetHash,
                  timingHash: encoded.timingHash,
                  frameCount: encoded.frameCount,
                  width: encoded.metadata.width,
                  height: encoded.metadata.height,
                  frameRate: rate,
                };
                if (!onVerifiedOutput) {
                  const { bytes, sha256 } = await fingerprintFile(
                    staged,
                    signal,
                  );
                  fingerprint = { bytes, sha256 };
                }
              }
              await onVerifiedOutput?.(staged);
            },
            output,
          });
          if (
            quality === 'maximum' &&
            video.recipes.some(({ steps }) =>
              steps.some(
                ({ parameters }) =>
                  parameters.type === 'superResolution' ||
                  isInterpolationStep(parameters),
              ),
            )
          )
            (result.warnings ??= []).push(
              'Maximum uses the same AI interpolation and super-resolution settings as quality. Authored recipe overrides still apply.',
            );
          return {
            ...result,
            ...(graphicSampling.holdRenders && { graphicSampling }),
            ...(evidence && { revisionEvidence: evidence }),
            ...(fingerprint && { outputFingerprint: fingerprint }),
            ...(layout && { layout }),
            ...(build && { build }),
            ...(musicComparison && { musicComparison }),
          };
        },
        {
          scratch: scratchDirectory,
          pictureCacheDirectory,
          graphicSampling,
          ...(onProgress && { onProgress }),
          audioComparison: settings.audioComparison,
          audioChannels: settings.audioChannels,
          audioSampleRate: settings.audioSampleRate,
          audioBitrateKbps: settings.audioBitrateKbps,
        },
      ),
  );
}

/** Compile and render in the calling process. Subprocesses are scoped to this call. */
export async function renderVideo(
  file: string,
  output: string,
  {
    params,
    processing,
    audioMixEdit,
    musicSelection,
    ...options
  }: VideoRenderOptions = {},
) {
  const video = await compileVideo(file, {
    signal: options.signal,
    preview: options.burnSubtitles === false,
    processing,
    quality: options.quality ?? 'quality',
    params,
    audioMixEdit,
    musicSelection,
  });
  return renderCompiledVideo(video, output, options);
}
