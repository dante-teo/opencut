import { lstat, realpath, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  inspectTimelineRender,
  checkRenderEncoders,
  recipeBackendVersion,
  MediaError,
  SourceChangedError,
} from '@opencut/media';
import { usesLayerTransform } from '@opencut/shared';
import { compileVideoInput } from './video-files.js';
import { findMediaEntry, mediaCacheMissReason } from './video-media-cache.js';
import { missing } from './video-integrity.js';
import { videoInputIdentity } from './video-input.js';
import { processingSettings } from './video-processing.js';
import type { RecipePlanStep } from './video-processing.js';
import { clipSpeed } from './clip-timing.js';
import { isInterpolationStep } from './video-recipe-schema.js';
import type { VideoRenderOptions } from './video-render.js';
import { bindGraphicAudio } from './graphic-audio.js';
import { protectRenderInputs } from './video-render.js';

async function freeSpace(directory: string) {
  let path = resolve(directory);
  for (;;) {
    try {
      const stats = await statfs(path, { bigint: true });
      return {
        path: directory,
        measuredAt: path,
        freeBytes: Number(stats.bavail * stats.bsize),
      };
    } catch (error) {
      if (!missing(error) || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
}

function cadenceConversion(input: number, output: number) {
  if (input < output - 0.000001) return 'frame-repetition';
  if (input > output + 0.000001) return 'frame-selection';
}

/** Inspect the current cache snapshot without writing checkpoints or building media. */
export async function planVideoRender(
  file: string,
  output: string,
  {
    processing,
    params,
    audioMixEdit,
    musicSelection,
    audioMixCacheDirectory,
    burnSubtitles = true,
    pictureCacheDirectory,
    quality = 'quality',
    ...controls
  }: VideoRenderOptions = {},
) {
  const signal = controls.signal ?? new AbortController().signal;
  const recipeSteps: RecipePlanStep[] = [];
  const pendingSources = new Map<string, string>();
  const authoredPaths = controls.overwrite ? new Set<string>() : undefined;
  const video = await compileVideoInput(file, {
    params,
    processing,
    audioMixEdit,
    musicSelection,
    quality,
    signal,
    preview: !burnSubtitles,
    authoredPaths,
    recipePlan: { steps: recipeSteps, pendingSources },
  });
  const plan = await video.resolveRender();
  bindGraphicAudio(
    video,
    plan,
    async () => {
      throw new Error('Planning cannot sample graphic audio.');
    },
    undefined,
    controls,
    signal,
  );
  if (authoredPaths)
    await protectRenderInputs(
      video,
      output,
      [...plan.sourceMetadata.keys(), ...authoredPaths],
      signal,
    );
  if (!burnSubtitles)
    plan.visualClips = plan.visualClips.filter(({ subtitle }) => !subtitle);
  const pictureRoot =
    pictureCacheDirectory && resolve(pictureCacheDirectory, 'picture-v1');
  const cache =
    pictureRoot &&
    (await realpath(pictureRoot).catch((error: unknown) => {
      if (missing(error)) return pictureRoot;
      throw error;
    }));
  if (cache && /[\r\n]/.test(cache))
    throw new MediaError('Picture cache paths cannot contain line breaks.');
  const timeline = await inspectTimelineRender(
    { ...plan, ...controls, output, quality, signal },
    {
      pendingSources,
      ...(cache && {
        cache: {
          backend: await recipeBackendVersion(signal),
          sourceIdentity(path: string) {
            if (pendingSources.has(path)) return path;
            const identity = video.sourceIdentity(path);
            const observed = videoInputIdentity(path);
            if (!identity || identity !== observed)
              throw new SourceChangedError(
                path,
                'picture render planning',
                identity ?? null,
                observed,
              );
            return identity;
          },
        },
      }),
    },
  );
  let savedPicture:
    | {
        id?: string;
        key?: string;
        status: 'save' | 'reuse' | 'blocked';
        reason?: string;
      }
    | undefined;
  const version = controls.pictureVersion;
  if (cache && version) {
    const { savedKey: key } = timeline;
    if (version === 'save')
      savedPicture = { status: 'save', ...(key && { key }) };
    else if (!key || !version.startsWith(key + '.'))
      savedPicture = {
        id: version,
        status: 'blocked',
        reason: key
          ? 'picture-or-encoder-key-changed'
          : 'recipe-artifact-needed-for-key',
      };
    else {
      const found = await findMediaEntry(cache, version, 'mp4', signal);
      if (found?.directory === join(cache, version) && controls.overwrite)
        await protectRenderInputs(
          video,
          output,
          [found.entry.metadata.path],
          signal,
        );
      savedPicture =
        found?.directory === join(cache, version)
          ? { id: version, key, status: 'reuse' }
          : {
              id: version,
              key,
              status: 'blocked',
              reason: await mediaCacheMissReason(cache, version),
            };
    }
  }
  const lookups = new Map<
    string,
    { status: 'reuse' | 'rebuild'; reason: string }
  >();
  const pictureRanges = [];
  for (const { key, pending, startFrame, endFrame } of timeline.ranges) {
    signal.throwIfAborted();
    let decision: { status: 'reuse' | 'rebuild'; reason: string };
    if (savedPicture?.status === 'reuse')
      decision = { status: 'reuse', reason: 'verified-saved-picture' };
    else if (pending)
      decision = {
        status: 'rebuild',
        reason: 'recipe-artifact-needed-for-key',
      };
    else if (!cache || !key)
      decision = { status: 'rebuild', reason: 'picture-cache-disabled' };
    else {
      const earlier = lookups.get(key);
      if (earlier)
        decision =
          earlier.status === 'rebuild'
            ? { status: 'reuse', reason: 'scheduled-earlier-range' }
            : earlier;
      else {
        decision = (await findMediaEntry(cache, key, 'mkv', signal))
          ? { status: 'reuse', reason: 'verified-cache-entry' }
          : {
              status: 'rebuild',
              reason: await mediaCacheMissReason(cache, key),
            };
        lookups.set(key, decision);
      }
    }
    pictureRanges.push({
      startFrame,
      endFrame,
      ...decision,
      ...(key && !pending && { key }),
      ...(pending && { recipeAssets: pending }),
    });
  }
  const pictureFramesToBuild = pictureRanges.reduce(
    (total, range) =>
      total +
      (range.status === 'rebuild' ? range.endFrame - range.startFrame : 0),
    0,
  );
  if (savedPicture?.status !== 'blocked')
    await checkRenderEncoders(
      [
        ...(savedPicture?.status === 'reuse' ? [] : [timeline.encoder.name]),
        'aac',
        ...((cache ? pictureFramesToBuild > 0 : timeline.requiresFfv1)
          ? ['ffv1']
          : []),
      ],
      signal,
    );
  const recipeRoot = processingSettings(processing ?? {}).directory;
  const outputDirectory = dirname(resolve(output));
  const requestedDirectories = [
    ...new Set([
      outputDirectory,
      recipeRoot,
      ...(pictureCacheDirectory ? [resolve(pictureCacheDirectory)] : []),
      ...(audioMixCacheDirectory ? [resolve(audioMixCacheDirectory)] : []),
    ]),
  ];
  const sourcePaths = new Set([
    ...plan.visualClips.flatMap((clip) =>
      clip.path && !clip.graphic
        ? [clip.path]
        : Object.values(clip.graphic?.mediaFrames ?? {}).map(
            ({ path }) => path,
          ),
    ),
    ...plan.audioClips.map(({ path }) => path),
  ]);
  let sourceCopies = 0;
  for (const path of sourcePaths) {
    signal.throwIfAborted();
    if (!pendingSources.has(path)) sourceCopies += (await lstat(path)).size;
  }
  const recipeOutputs = recipeSteps.reduce(
    (sum, step) => sum + (step.estimatedBytes ?? 0),
    0,
  );
  const {
    outputWidth,
    outputHeight,
    durationSeconds,
    outputFrameCount,
    outputFrameRate,
    encoder,
  } = timeline;
  const rateControl = encoder.settings.rateControl;
  const delivery = Math.ceil(
    (rateControl.mode === 'bitrate'
      ? rateControl.bitrateKbps * 125 * durationSeconds
      : (outputWidth * outputHeight * outputFrameCount * 0.1) / 8) +
      (controls.audioBitrateKbps ?? 192) * 125 * durationSeconds,
  );
  const pictureIntermediates =
    cache || pictureRanges.length > 1
      ? outputWidth * outputHeight * 1.5 * pictureFramesToBuild
      : 0;
  const transformedFrames = [
    ...plan.visualClips,
    ...(plan.visualTransitions?.flatMap(({ layers }) => layers) ?? []),
  ].reduce(
    (sum, clip) =>
      sum +
      (clip.graphic ||
      clip.grade ||
      clip.crop ||
      'ramp' in clip ||
      usesLayerTransform(clip.rotation, !!clip.animation)
        ? clip.frameCount
        : 0),
    0,
  );
  const transformIntermediates =
    pictureFramesToBuild && plan.width * plan.height * 4 * transformedFrames;
  const audioIntermediates =
    plan.professionalMix?.enabled !== false &&
    (plan.professionalMix || plan.musicComparison?.matchLoudness)
      ? Math.ceil(
          durationSeconds *
            (controls.audioSampleRate ?? 48000) *
            (controls.audioChannels ?? 2) *
            4 *
            (plan.audioClips.length + 2),
        )
      : 0;
  const components = {
    sourceCopies,
    recipeOutputs,
    pictureIntermediates,
    transformIntermediates,
    audioIntermediates,
    stagedDelivery: delivery * (savedPicture?.status === 'save' ? 2 : 1),
  };
  const peakScratchBytes = Object.values(components).reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  const composition = {
    width: plan.width,
    height: plan.height,
    frameRate: plan.frameRate,
    frameCount: plan.frameCount,
    durationSeconds:
      (plan.frameCount * plan.frameRate.denominator) / plan.frameRate.numerator,
  };
  const deliveryFormat = {
    width: outputWidth,
    height: outputHeight,
    frameRate: outputFrameRate,
    frameCount: outputFrameCount,
    durationSeconds,
  };
  const clips = new Map(video.project.clips.map((clip) => [clip.id, clip]));
  const recipes = new Map(
    video.recipes.map((recipe) => [recipe.assetId, recipe]),
  );
  const compositionFps =
    composition.frameRate.numerator / composition.frameRate.denominator;
  const deliveryFps = outputFrameRate.numerator / outputFrameRate.denominator;
  const deliveryMethod =
    cadenceConversion(compositionFps, deliveryFps) ?? 'same-grid';
  const shots = plan.visualClips.flatMap((layer) => {
    if (!layer.path || layer.graphic || layer.freezeFrame) return [];
    const clip = clips.get(layer.clipId);
    if (
      !clip?.assetId ||
      video.definition.assets?.[clip.assetId]?.kind !== 'video'
    )
      return [];
    const recipe = recipes.get(clip.assetId);
    const steps = recipe?.steps;
    const cadenceIndex =
      steps?.findLastIndex(
        ({ parameters }) =>
          isInterpolationStep(parameters) || parameters.type === 'frameRate',
      ) ?? -1;
    const recipeCadence = steps?.[cadenceIndex];
    const mediaFps =
      recipeCadence?.media.frameRate ??
      plan.sourceMetadata.get(layer.path)?.video?.frameRate ??
      null;
    const speed = clipSpeed(clip);
    const playbackFps =
      mediaFps === null
        ? null
        : (mediaFps * speed.numerator) / speed.denominator;
    const parameters = recipeCadence?.parameters;
    const interpolation =
      parameters && isInterpolationStep(parameters)
        ? parameters.type
        : undefined;
    const beforeRecipeFps =
      steps?.[cadenceIndex - 1]?.media.frameRate ?? recipe?.sourceFrameRate;
    const recipeMethod = interpolation
      ? 'interpolation'
      : parameters?.type === 'frameRate' &&
          beforeRecipeFps != null &&
          mediaFps != null
        ? (cadenceConversion(beforeRecipeFps, mediaFps) ?? 'native')
        : 'native';
    const compositionMethod =
      playbackFps === null
        ? 'unknown'
        : (cadenceConversion(playbackFps, compositionFps) ?? recipeMethod);
    return [
      {
        clipId: layer.clipId,
        assetId: clip.assetId,
        startFrame: layer.timelineStartFrame,
        frameCount: layer.frameCount,
        startSeconds: layer.timelineStartFrame / compositionFps,
        sourceFps: recipe ? recipe.sourceFrameRate : mediaFps,
        mediaFps,
        method:
          deliveryMethod === 'same-grid' ? compositionMethod : deliveryMethod,
        compositionMethod,
        deliveryMethod,
        ...(interpolation && { interpolation }),
      },
    ];
  });
  return {
    planVersion: 1,
    ok: savedPicture?.status !== 'blocked',
    definitionPath: video.path,
    output: resolve(output),
    width: outputWidth,
    height: outputHeight,
    frameCount: outputFrameCount,
    composition,
    delivery: deliveryFormat,
    shots,
    encoder,
    recipes: recipeSteps.sort(
      (a, b) => a.assetId.localeCompare(b.assetId) || a.step - b.step,
    ),
    pictureRanges,
    ...(savedPicture && { savedPicture }),
    storage: {
      estimated: true,
      peakScratchBytes,
      components,
      method:
        'Sum of estimated overlapping allocations using raw lossless frame equivalents, source file sizes and bitrate or 0.1 bits per pixel per delivery frame. Compression, filesystem cloning and staging can change actual use.',
      filesystems: await Promise.all(requestedDirectories.map(freeSpace)),
    },
    warnings: timeline.warnings,
  };
}
