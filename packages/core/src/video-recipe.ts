import {
  isStillImage,
  MediaError,
  recipeInputArguments,
  videoSourceDuration,
} from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import type { IdentifiedMedia } from './video-input.js';
import type {
  RecipeFormat,
  ResolvedVideoRecipe,
} from './video-recipe-schema.js';

type Step = ResolvedVideoRecipe[number];
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
  steps: RecipeStep[];
}

export function inspectRecipe(
  assetId: string,
  source: MediaMetadata,
  recipe: ResolvedVideoRecipe,
  kind: RecipeMedia['kind'],
): VideoRecipeInspection {
  let input = recipeMedia(source);
  const steps = recipe.map((parameters, index) => {
    try {
      const step = resolveRecipeStep(input, parameters);
      input = step.media;
      return step;
    } catch (cause) {
      throw recipeStepError(assetId, index, cause);
    }
  });
  if (input.kind !== kind)
    throw new MediaError(
      `assets.${assetId}.kind: Recipe produces ${input.kind}, expected ${kind}.`,
    );
  return { assetId, source: source.path, steps };
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
): RecipeStep {
  const media = { ...input };
  let output: RecipeFormat =
    input.kind === 'image' ? 'png' : input.kind === 'audio' ? 'wav' : 'mov';
  switch (parameters.type) {
    case 'trim':
      return {
        parameters,
        format: output,
        media: trimRecipeMedia(input, parameters.start, parameters.end),
      };
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

export function recipeArguments(
  input: MediaMetadata,
  step: RecipeStep,
  output: string,
) {
  const { parameters, media, format } = step;
  const video = media.kind !== 'audio' ? input.video : null;
  const audio = media.hasAudio ? input.audio : null;
  const args = [...recipeInputArguments(), '-i', input.path];
  if (parameters.type === 'trim')
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
    const filters = [];
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

export function validateRecipeOutput(output: MediaMetadata, step: RecipeStep) {
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
