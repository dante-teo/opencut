import { basename, dirname } from 'node:path';
import { beautySource } from '@opencut/media';
import { isActiveBeautyEffect, isActiveBeautyStep } from './beauty-schema.js';
import type { BeautyRenderReport } from './beauty-report.js';
import { rationalTime } from './time.js';
import type { RationalTime } from './time.js';
import {
  interpolationTiming,
  isStillImage,
  MediaError,
  readVideoPresentationTicks,
  recipeInputArguments,
  renderQualityProfiles,
  videoSourceDuration,
  validateEnhancementOutput,
} from '@opencut/media';
import type {
  InterpolationPlan,
  MediaMetadata,
  RenderQuality,
} from '@opencut/media';
import type { IdentifiedMedia } from './video-input.js';
import {
  isEnhancementStep,
  isInterpolationStep,
} from './video-recipe-schema.js';
import type {
  EnhancementStep,
  InterpolationStep,
  RecipeFormat,
  ResolvedVideoRecipe,
} from './video-recipe-schema.js';

type ProfiledStep = Extract<
  ResolvedVideoRecipe[number],
  { type: 'interpolateFrames' | 'smoothSlowMotion' | 'superResolution' }
>;
type Step =
  | Exclude<ResolvedVideoRecipe[number], ProfiledStep>
  | (ProfiledStep & { quality: 'fast' | 'quality' });

export type RecipeMedia = {
  kind: 'video' | 'image' | 'audio';
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  frameRate: number | null;
  hasAudio: boolean;
  /** End of the audio stream on the container clock, including any lead-in. */
  audioDurationSeconds: number | null;
  videoStartSeconds: number | null;
  audioStartSeconds: number | null;
};
export type RecipeStep = {
  parameters: Step;
  format: RecipeFormat;
  media: RecipeMedia;
};

type ResolvedRecipeStep = RecipeStep & { interpolation?: InterpolationPlan };

export interface RecipeInput {
  input: IdentifiedMedia;
  inspection: VideoRecipeInspection;
}

export function recipeStepError(
  assetId: string,
  index: number,
  cause: unknown,
) {
  return new MediaError(
    `assets.${assetId}.recipe.${index}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

export interface VideoRecipeInspection {
  assetId: string;
  source: string;
  sourceFrameRate: number | null;
  steps: RecipeStep[];
  beauty?: BeautyRenderReport;
  beautyArtifact?: string;
}

export function inspectRecipe(
  assetId: string,
  source: MediaMetadata,
  recipe: ResolvedVideoRecipe,
  kind: RecipeMedia['kind'],
  quality: RenderQuality,
): VideoRecipeInspection {
  let input = recipeMedia(source);
  const sourceFrameRate = input.frameRate;
  const steps = recipe.map((authored, index) => {
    try {
      if (authored.type === 'beauty' && isActiveBeautyStep(authored)) {
        beautySource(source);
        for (const effect of authored.effects.filter(isActiveBeautyEffect))
          if (effect.target.assetId !== assetId)
            throw new MediaError(
              "Beauty target asset ID must match the recipe's asset '" +
                assetId +
                "'.",
            );
      }
      const profile =
        renderQualityProfiles[
          ('quality' in authored ? authored.quality : undefined) ?? quality
        ];
      const parameters =
        authored.type === 'superResolution'
          ? { ...authored, quality: profile.superResolution }
          : isInterpolationStep(authored)
            ? { ...authored, quality: profile.interpolation }
            : authored;
      const { format, media } = resolveRecipeStep(input, parameters);
      input = media;
      return { parameters, format, media };
    } catch (cause) {
      throw recipeStepError(assetId, index, cause);
    }
  });
  if (input.kind !== kind)
    throw new MediaError(
      `assets.${assetId}.kind: Recipe produces ${input.kind}, expected ${kind}.`,
    );
  return { assetId, source: source.path, sourceFrameRate, steps };
}

export function recipeMedia(source: MediaMetadata): RecipeMedia {
  const kind = isStillImage(source)
    ? 'image'
    : source.video
      ? 'video'
      : 'audio';
  const rotated = Math.abs(source.video?.rotation ?? 0) % 180 === 90;
  const origin = source.startTimeSeconds ?? 0;
  const videoStartSeconds =
    kind === 'video'
      ? (source.video?.startTimeSeconds ?? origin) - origin
      : null;
  const audioStartSeconds = source.audio
    ? (source.audio.startTimeSeconds ?? origin) - origin
    : null;
  const audioDurationSeconds = !source.audio
    ? null
    : source.audio.durationSeconds === null
      ? source.durationSeconds
      : source.audio.durationSeconds + (audioStartSeconds ?? 0);
  return {
    kind,
    width: (rotated ? source.video?.height : source.video?.width) ?? null,
    height: (rotated ? source.video?.width : source.video?.height) ?? null,
    durationSeconds:
      kind === 'image'
        ? null
        : kind === 'video'
          ? videoSourceDuration(source)
          : audioDurationSeconds,
    frameRate: kind === 'video' ? (source.video?.frameRate ?? null) : null,
    hasAudio: source.hasAudio,
    audioDurationSeconds,
    videoStartSeconds,
    audioStartSeconds,
  };
}

export function resolveRecipeStep(
  input: RecipeMedia,
  parameters: Step,
): ResolvedRecipeStep {
  const media = { ...input };
  let output: RecipeFormat =
    input.kind === 'image' ? 'png' : input.kind === 'audio' ? 'wav' : 'mov';
  switch (parameters.type) {
    case 'beauty':
      break;
    case 'trim': {
      const { clock, start, end } = parameters;
      const origin = clock === 'picture' ? input.videoStartSeconds : 0;
      if (origin === null)
        throw new MediaError('A picture-clock trim requires timed video.');
      if (
        clock === 'picture' &&
        (input.durationSeconds === null ||
          end > input.durationSeconds + 0.000001)
      )
        throw new MediaError(
          'A picture-clock trim must end within the video stream.',
        );
      return {
        parameters,
        format: output,
        media: trimRecipeMedia(input, start + origin, end + origin),
      };
    }
    case 'crop':
      if (
        input.width === null ||
        input.height === null ||
        parameters.x + parameters.width > input.width ||
        parameters.y + parameters.height > input.height
      )
        throw new Error('Crop rectangle must fit inside the current image.');
      media.width = parameters.width;
      media.height = parameters.height;
      break;
    case 'resize':
      if (input.kind === 'audio')
        throw new Error('Resize requires a visual stream.');
      media.width = parameters.width;
      media.height = parameters.height;
      break;
    case 'frameRate': {
      const fps = parameters.numerator / parameters.denominator;
      if (input.kind !== 'video' || fps < 1 || fps > 120)
        throw new Error(
          'Frame rate conversion requires video and a rate between 1 and 120 fps.',
        );
      media.frameRate = fps;
      break;
    }
    case 'interpolateFrames':
    case 'smoothSlowMotion':
      return resolveInterpolation(input, parameters);
    case 'superResolution':
    case 'denoise':
      return resolveEnhancement(input, parameters);
    case 'extractAudio':
      if (!input.hasAudio)
        throw new Error('Audio extraction requires an audio stream.');
      Object.assign(media, {
        kind: 'audio',
        width: null,
        height: null,
        frameRate: null,
        durationSeconds: input.audioDurationSeconds,
        videoStartSeconds: null,
        audioStartSeconds: 0,
      });
      output = 'wav';
      break;
    case 'normalizeAudio':
      if (!input.hasAudio)
        throw new Error('Audio normalization requires an audio stream.');
      break;
    case 'convert':
      output = parameters.format;
      if (
        ((output === 'mp4' || output === 'mov') && input.kind !== 'video') ||
        (output === 'png' && input.kind !== 'image') ||
        ((output === 'wav' || output === 'flac') && input.kind !== 'audio')
      )
        throw new Error(
          'The format must match the current media kind. Use extractAudio to change kind.',
        );
      if (
        output === 'mp4' &&
        (input.width === null ||
          input.height === null ||
          input.width % 2 ||
          input.height % 2)
      )
        throw new Error('MP4 conversion requires even dimensions.');
      break;
  }
  return { parameters, format: output, media };
}

function resolveEnhancement(
  input: RecipeMedia,
  parameters: Extract<Step, EnhancementStep>,
): ResolvedRecipeStep {
  const { kind, width, height, frameRate, durationSeconds } = input;
  if (
    kind !== 'video' ||
    !width ||
    !height ||
    width % 2 ||
    height % 2 ||
    !frameRate ||
    !durationSeconds
  )
    throw new MediaError(
      'AI enhancement requires timed video with even dimensions.',
    );
  const { media: rebased } = rebaseRecipeStreams(input, input.hasAudio);
  if (parameters.type === 'denoise')
    return { parameters, format: 'mov', media: { ...input, ...rebased } };
  const { width: targetWidth, height: targetHeight, quality } = parameters;
  const maximumScale = quality === 'fast' ? 2 : 4;
  if (
    targetWidth % 2 ||
    targetHeight % 2 ||
    targetWidth <= width ||
    targetWidth > width * maximumScale ||
    targetWidth * height !== targetHeight * width
  )
    throw new MediaError(
      `AI super-resolution requires larger even dimensions with the original aspect ratio and a scale no greater than ${maximumScale}× at this quality.`,
    );
  return {
    parameters,
    format: 'mov',
    media: { ...input, ...rebased, width: targetWidth, height: targetHeight },
  };
}

function rebaseRecipeStreams(input: RecipeMedia, hasAudio: boolean) {
  const pictureStart = input.videoStartSeconds ?? 0;
  const audioStart = hasAudio ? input.audioStartSeconds : null;
  const originShiftSeconds = Math.min(pictureStart, audioStart ?? pictureStart);
  return {
    originShiftSeconds,
    media: {
      hasAudio,
      videoStartSeconds: pictureStart - originShiftSeconds,
      audioStartSeconds:
        audioStart === null ? null : audioStart - originShiftSeconds,
      audioDurationSeconds:
        hasAudio && input.audioDurationSeconds !== null
          ? input.audioDurationSeconds - originShiftSeconds
          : null,
    },
  };
}

function resolveInterpolation(
  input: RecipeMedia,
  parameters: Extract<Step, InterpolationStep>,
): ResolvedRecipeStep {
  const { numerator, denominator, quality, sceneCuts, sceneThreshold } =
    parameters;
  const fps = numerator / denominator;
  const preserveAudio = parameters.type === 'interpolateFrames';
  const speed = preserveAudio ? 1 : parameters.speed;
  const sourceRate = fps / speed;
  const { durationSeconds, frameRate, width, height } = input;
  if (
    input.kind !== 'video' ||
    durationSeconds === null ||
    frameRate === null ||
    fps < 1 ||
    fps > 120 ||
    sourceRate <= frameRate + 0.000001
  )
    throw new Error(
      'AI interpolation requires timed video, a target of 1–120 fps, and a higher sampling rate on the source clock (target fps / speed).',
    );

  const offline = quality !== 'fast';
  if (!offline && sourceRate > frameRate * 2 + 0.000001)
    throw new Error(
      'Fast interpolation supports at most 2× sampling on the source clock. Choose quality interpolation, lower the target fps, or increase speed.',
    );
  if (!width || !height || width % 2 || height % 2)
    throw new Error(
      'VideoToolbox interpolation requires even video dimensions.',
    );
  if (
    sceneCuts.some(
      (cut, index) =>
        cut >= durationSeconds || (index > 0 && cut <= sceneCuts[index - 1]!),
    )
  )
    throw new Error(
      'Scene cuts must be strictly increasing and inside the current picture duration.',
    );

  const duration = durationSeconds / speed;
  const { originShiftSeconds, media: rebased } = rebaseRecipeStreams(
    input,
    preserveAudio && input.hasAudio,
  );
  return {
    parameters,
    format: 'mov',
    media: {
      ...input,
      frameRate: fps,
      durationSeconds: duration,
      ...rebased,
    },
    interpolation: {
      numerator,
      denominator,
      timing: interpolationTiming(numerator, denominator, duration),
      backend: offline ? 'offline' : 'low-latency',
      sceneThreshold,
      sceneCuts,
      speed,
      videoStartSeconds: rebased.videoStartSeconds,
      originShiftSeconds,
      preserveAudio,
    },
  };
}

function trimRecipeMedia(
  input: RecipeMedia,
  start: number,
  end: number,
): RecipeMedia {
  const videoEnd =
    input.videoStartSeconds === null || input.durationSeconds === null
      ? null
      : input.videoStartSeconds + input.durationSeconds;
  const primaryEnd =
    input.kind === 'audio' ? input.audioDurationSeconds : videoEnd;
  const timedEnd = Math.max(primaryEnd ?? 0, input.audioDurationSeconds ?? 0);
  if (primaryEnd === null || start >= end || end > timedEnd + 0.000001)
    throw new Error(
      'Trim requires an increasing range inside the timed input.',
    );

  const video = streamOverlap(input.videoStartSeconds, videoEnd, start, end);
  // Unknown audio endpoints can be resolved by the probe after the trim.
  const audio = streamOverlap(
    input.audioStartSeconds,
    input.audioDurationSeconds ?? end,
    start,
    end,
  );
  if (input.kind === 'video' ? !video : !audio)
    throw new Error(`Trim range must overlap the ${input.kind} stream.`);

  // Timed video containers start at the first retained stream. Audio-only
  // outputs pad a leading gap with silence on the requested trim clock.
  const origin = video
    ? Math.min(video.start, audio?.start ?? video.start)
    : start;
  const audioEnd = audio ? audio.end - origin : null;
  return {
    ...input,
    durationSeconds: video ? video.end - video.start : audioEnd,
    videoStartSeconds: video ? video.start - origin : null,
    hasAudio: audio !== null,
    audioStartSeconds: audio ? (video ? audio.start - origin : 0) : null,
    audioDurationSeconds: audioEnd,
  };
}

function streamOverlap(
  streamStart: number | null,
  streamEnd: number | null,
  start: number,
  end: number,
) {
  if (streamStart === null || streamEnd === null) return null;
  const overlapStart = Math.max(streamStart, start);
  const overlapEnd = Math.min(streamEnd, end);
  return overlapStart < overlapEnd
    ? { start: overlapStart, end: overlapEnd }
    : null;
}

async function pictureTrim(
  input: MediaMetadata,
  start: number,
  end: number,
  signal?: AbortSignal,
) {
  const video = input.video!;
  const [n = 0, d = 0] = video.timeBase?.split('/').map(Number) ?? [];
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0)
    throw new MediaError(
      'A picture-clock trim requires a usable video time base.',
    );
  const origin = input.startTimeSeconds ?? 0;
  const pictureStart = Math.round(((video.startTimeSeconds ?? origin) * d) / n);
  const toTicks = (seconds: number) => (seconds * d) / n;
  const toSeconds = (ticks: number) => (ticks * n) / d;
  // Remove floating-point noise before choosing the enclosing integer PTS.
  const coveringTick = pictureStart + Math.floor(toTicks(start) + 1e-7);
  const endTick = pictureStart + Math.ceil(toTicks(end) - 1e-7);
  const toMicroseconds = (ticks: number) => Math.round(toSeconds(ticks) * 1e6);
  const startUs = Math.round((toSeconds(pictureStart) + start) * 1e6);
  const durationUs = Math.round((end - start) * 1e6);
  if (durationUs < 1)
    throw new MediaError(
      'A picture-clock trim requires at least one microsecond.',
    );
  const ticks = await readVideoPresentationTicks(
    input.path,
    video.index,
    Math.floor(toSeconds(coveringTick) * 1e6) / 1e6,
    toSeconds(endTick) + 1,
    signal,
    recipeInputArguments(),
  );
  let first = -Infinity;
  let last = -Infinity;
  for (const pts of ticks) {
    if (pts <= coveringTick) first = Math.max(first, pts);
    if (pts < endTick && toMicroseconds(pts) < startUs + durationUs)
      last = Math.max(last, pts);
  }
  if (!Number.isSafeInteger(first) || last < first)
    throw new MediaError('No video frame covers the picture-clock trim start.');
  const lastUs = Math.max(0, toMicroseconds(last) - startUs);
  const seek = Math.max(0, toSeconds(first) - origin - 0.000002);
  return {
    input: ['-copyts', ...(seek > 0 ? ['-ss', seek.toFixed(6)] : [])],
    // Retain the frame covering the cut. Its visible interval starts at zero;
    // later frames and audio retain their offsets from the requested in-point.
    video: [
      '-vf',
      `trim=start_pts=${first}:end_pts=${endTick},settb=AVTB,setpts=max(PTS-(${startUs})\\,0),trim=end_pts=${durationUs}`,
      '-bsf:v',
      `setts=duration='if(eq(PTS,${lastUs}),${durationUs - lastUs},DURATION)'`,
      '-video_track_timescale',
      '1000000',
      '-movie_timescale',
      '1000000',
      '-use_editlist',
      '1',
      '-avoid_negative_ts',
      'disabled',
    ],
    audio: `atrim=start=${(startUs / 1e6).toFixed(6)}:end=${((startUs + durationUs) / 1e6).toFixed(6)},asetpts=PTS-(${startUs}/1000000)/TB`,
  };
}

export async function recipeArguments(
  input: MediaMetadata,
  step: RecipeStep,
  output: string,
  signal?: AbortSignal,
) {
  const { parameters, media, format } = step;
  const video = media.kind !== 'audio' ? input.video : null;
  const audio = media.hasAudio ? input.audio : null;
  const window =
    parameters.type === 'trim' && parameters.clock === 'picture'
      ? await pictureTrim(input, parameters.start, parameters.end, signal)
      : undefined;
  const args = [
    ...recipeInputArguments(),
    ...(window?.input ?? []),
    '-i',
    input.path,
  ];
  if (parameters.type === 'trim' && !window)
    args.push(
      '-ss',
      parameters.start.toFixed(6),
      '-t',
      (parameters.end - parameters.start).toFixed(6),
    );
  if (video) {
    args.push('-map', `0:${video.index}`, '-threads:v', '1');
    if (media.kind === 'image') args.push('-frames:v', '1');
    else args.push('-fps_mode', 'passthrough', '-enc_time_base:v', 'filter');
    if (window) args.push(...window.video);
    switch (parameters.type) {
      case 'crop':
        args.push(
          '-vf',
          `crop=${parameters.width}:${parameters.height}:${parameters.x}:${parameters.y}:exact=1`,
        );
        break;
      case 'resize':
        args.push(
          '-vf',
          `scale=${parameters.width}:${parameters.height}:flags=${parameters.method === 'nearest' ? 'neighbor' : parameters.method},setsar=1`,
        );
        break;
      case 'frameRate':
        args.push(
          '-vf',
          `fps=${parameters.numerator}/${parameters.denominator}:round=near`,
        );
        break;
    }
  }
  if (audio) {
    args.push('-map', `0:${audio.index}`, '-threads:a', '1');
    const filters = window ? [window.audio] : [];
    if (parameters.type === 'normalizeAudio')
      filters.push(
        `loudnorm=I=${parameters.targetLufs}:TP=-1.5:LRA=11:linear=false`,
      );
    // Audio-only containers have no start offset. Preserve silence at the head.
    if (!video) filters.push('aresample=async=1:first_pts=0');
    if (parameters.type === 'normalizeAudio')
      filters.push(`aresample=${audio.sampleRate ?? 48000}`);
    if (filters.length) args.push('-af', filters.join(','));
  }
  const encoding: Record<RecipeFormat, string[]> = {
    mov: ['-c:v', 'ffv1', ...(audio ? ['-c:a', 'pcm_f32le'] : [])],
    mp4: [
      '-c:v',
      'libx264',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'fast',
      '-crf',
      '18',
      ...(audio ? ['-c:a', 'aac'] : []),
    ],
    png: ['-c:v', 'png', '-update', '1', '-f', 'image2'],
    wav: ['-c:a', 'pcm_f32le', '-rf64', 'auto'],
    flac: ['-c:a', 'flac'],
  };
  return [
    ...args,
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    ...encoding[format],
    '-n',
    output,
  ];
}

export function validateRecipeOutput(
  input: MediaMetadata,
  output: MediaMetadata,
  step: ResolvedRecipeStep,
) {
  const actual = recipeMedia(output);
  const expected = step.media;
  if (
    actual.kind !== expected.kind ||
    actual.width !== expected.width ||
    actual.height !== expected.height ||
    actual.hasAudio !== expected.hasAudio ||
    (actual.kind !== 'image' &&
      !(actual.durationSeconds && actual.durationSeconds > 0))
  )
    throw new MediaError(
      'Recipe result did not contain the expected media streams, dimensions, or duration.',
    );
  if (step.parameters.type === 'beauty') {
    // The beauty worker verifies decoded picture and audio timestamps before
    // this check. A container can omit stream duration and include initial
    // codec padding in its reported start. Only compare real stream lengths.
    if (
      (input.video?.durationSeconds != null &&
        Math.abs(
          (actual.durationSeconds ?? 0) - (expected.durationSeconds ?? 0),
        ) > 0.001) ||
      (input.audio?.durationSeconds != null &&
        Math.abs(
          (output.audio?.durationSeconds ?? 0) - input.audio.durationSeconds,
        ) > 0.001)
    )
      throw new MediaError(
        'Beauty recipe failed to preserve the expected picture or audio timing.',
      );
    return;
  }
  if (isEnhancementStep(step.parameters)) {
    validateEnhancementOutput(input, output);
    return;
  }
  if (step.interpolation) {
    const { timing, videoStartSeconds, preserveAudio } = step.interpolation;
    const audio = preserveAudio ? input.audio : null;
    if (
      Math.abs(actual.durationSeconds! - expected.durationSeconds!) >
        0.000003 ||
      Math.abs((actual.videoStartSeconds ?? 0) - videoStartSeconds) >
        0.000003 ||
      output.video?.frameCount !== timing.frameCount ||
      (audio &&
        expected.audioStartSeconds !== null &&
        Math.abs((actual.audioStartSeconds ?? 0) - expected.audioStartSeconds) >
          0.001) ||
      (audio?.durationSeconds != null &&
        expected.audioDurationSeconds !== null &&
        Math.abs(
          (actual.audioDurationSeconds ?? 0) - expected.audioDurationSeconds,
        ) > 0.001)
    )
      throw new MediaError(
        'AI interpolation output did not preserve the expected picture or audio timing.',
      );
    return;
  }
  if (step.parameters.type === 'trim' && step.parameters.clock === 'picture') {
    if (
      Math.abs(actual.videoStartSeconds ?? Infinity) > 0.000001 ||
      Math.abs(actual.durationSeconds! - expected.durationSeconds!) > 0.000002
    )
      throw new MediaError(
        'Picture-clock trim did not preserve its requested video timing.',
      );
    return;
  }
  const tolerance = Math.max(0.05, 1 / (actual.frameRate ?? 1000));
  if (
    step.parameters.type !== 'extractAudio' &&
    expected.durationSeconds !== null &&
    actual.durationSeconds !== null &&
    Math.abs(actual.durationSeconds - expected.durationSeconds) >
      tolerance + 0.000001
  )
    throw new MediaError(
      'Recipe result duration differed from the expected duration by more than one frame or 50 ms.',
    );
  if (
    step.parameters.type === 'frameRate' &&
    (actual.frameRate === null ||
      Math.abs(actual.frameRate - expected.frameRate!) > 0.000001)
  )
    throw new MediaError(
      'Recipe result did not have the requested frame rate.',
    );
}

export function originalRecipeTime(
  time: RationalTime,
  recipe: VideoRecipeInspection | undefined,
) {
  let seconds: number | undefined;
  for (const { parameters } of [...(recipe?.steps ?? [])].reverse()) {
    if (parameters.type === 'trim') {
      const start = Number(parameters.start.toFixed(6));
      if (start)
        seconds = (seconds ?? time.numerator / time.denominator) + start;
    } else if (parameters.type === 'smoothSlowMotion') {
      seconds =
        (seconds ?? time.numerator / time.denominator) * parameters.speed;
    }
  }
  // Recipes seek and sample on a microsecond clock. Round the mapped time
  // once so chained speeds do not inflate the rational denominator.
  return seconds === undefined
    ? time
    : rationalTime(BigInt(Math.round(seconds * 1_000_000)), 1_000_000n);
}

export function beautyReports(recipes: readonly VideoRecipeInspection[]) {
  return recipes.flatMap(({ assetId, beauty, beautyArtifact }) =>
    beauty && beautyArtifact
      ? [
          {
            assetId,
            artifact: beautyArtifact,
            recipeKey: basename(dirname(beautyArtifact)),
            ...beauty,
          },
        ]
      : [],
  );
}
