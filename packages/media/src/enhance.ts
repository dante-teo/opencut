import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sourceColorMatrix } from '@opencut/shared';
import { interpolationTiming } from './interpolate.js';
import { recipeInputArguments, videoSourceDuration } from './probe.js';
import type { MediaMetadata, MediaStream } from './probe.js';
import { MediaError } from './process.js';
import { nativeRecipeFingerprint, runRecipeProcess } from './recipe-process.js';
import type { RecipeProcessLimits } from './recipe-process.js';

export const enhancementBackendId = 'videotoolbox-enhancement-v4';

const worker = fileURLToPath(new URL('./video-enhance', import.meta.url));

type Enhancement =
  | {
      type: 'superResolution';
      quality: 'fast' | 'high';
      width: number;
      height: number;
    }
  | { type: 'denoise'; quality: 'light' | 'medium' | 'strong' };

export async function enhancementBackendVersion(signal: AbortSignal) {
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    Number(release().split('.')[0]) < 25
  )
    throw new MediaError(
      'AI enhancement requires Apple Silicon and macOS 26 or later. Run opencut system inspect --json.',
    );
  return nativeRecipeFingerprint(
    worker,
    enhancementBackendId,
    'enhancement',
    signal,
  );
}

function enhancementTiming(input: MediaMetadata) {
  const video = input.video!;
  const ratio = video.nominalFrameRateRatio ?? video.frameRateRatio;
  const [numerator, denominator] = ratio?.split('/').map(Number) ?? [];
  const [tickNumerator, tickDenominator] =
    video.timeBase?.split('/').map(Number) ?? [];
  const seconds = videoSourceDuration(input);
  if (
    !numerator ||
    !denominator ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator > 1_000_000 ||
    !tickNumerator ||
    !tickDenominator ||
    numerator / denominator < 1 ||
    numerator / denominator > 120 ||
    !seconds ||
    (input.hasAudio && video.durationSeconds === null)
  )
    throw new MediaError(
      'AI enhancement needs a timed video stream at 1–120 fps. Remux to MOV with explicit stream timing.',
    );
  const { scale, frame, duration, frameCount } = interpolationTiming(
    numerator,
    denominator,
    seconds,
  );
  // A container with a coarse time base can round frame times differently.
  // Count frames from timestamps, allowing only the source clock's rounding.
  const tolerance = Math.min(
    (tickNumerator / tickDenominator) * 1_000_000 + 1,
    2001,
  );
  const count =
    video.frameCount && Math.abs(video.frameCount - frameCount) <= 1
      ? video.frameCount
      : Math.ceil((duration - (tolerance * scale) / 1_000_000) / frame);
  const lastDuration = duration - (count - 1) * frame;
  if (
    count < 1 ||
    !Number.isSafeInteger(count) ||
    lastDuration < 1 ||
    lastDuration > frame + (tolerance * scale) / 1_000_000
  )
    throw new MediaError(
      'AI enhancement could not determine the video packet timing.',
    );
  return {
    ratio: ratio!,
    scale,
    frame,
    duration,
    count,
    lastDuration,
    tolerance,
  };
}

function clock(input: MediaMetadata) {
  const start = input.startTimeSeconds ?? 0;
  const video = input.video?.startTimeSeconds ?? start;
  const audio = input.audio ? (input.audio.startTimeSeconds ?? start) : null;
  const origin = Math.min(video, audio ?? video);
  return {
    origin,
    videoOffset: video - origin,
    audioOffset: audio === null ? null : audio - origin,
  };
}

const colorFields = {
  colorSpace: 'colorspace',
  colorPrimaries: 'color_primaries',
  colorTransfer: 'color_trc',
} as const;

type ColorField = keyof typeof colorFields;

function enhancementColorSpace(video: MediaStream) {
  if (
    video.colorSpace &&
    !['unknown', 'unspecified'].includes(video.colorSpace)
  )
    return video.colorSpace;
  const matrix = sourceColorMatrix(
    null,
    video.width ?? 0,
    video.height ?? 0,
    video.codec,
  );
  // FFmpeg's scale filter calls this bt601, but the stream tag needs a
  // standardized matrix identifier.
  return matrix === 'bt601' ? 'smpte170m' : matrix;
}

function enhancementColorTags(
  video: MediaStream,
  colorSpace = enhancementColorSpace(video),
) {
  return (Object.keys(colorFields) as ColorField[]).flatMap((field) => {
    const value = field === 'colorSpace' ? colorSpace : video[field];
    return value && !['unknown', 'unspecified'].includes(value)
      ? [{ field, value }]
      : [];
  });
}

export async function runEnhancement(
  input: MediaMetadata,
  operation: Enhancement,
  output: string,
  limits: RecipeProcessLimits,
  signal: AbortSignal,
  onTime: (seconds: number) => void,
) {
  const video = input.video!;
  if (
    video.hasAlpha ||
    video.hasHdrMetadata ||
    !['yuv420p', 'nv12'].includes(video.pixelFormat ?? '') ||
    (video.colorRange && !['unknown', 'tv'].includes(video.colorRange)) ||
    ['smpte2084', 'arib-std-b67'].includes(video.colorTransfer ?? '') ||
    (video.fieldOrder &&
      !['unknown', 'progressive'].includes(video.fieldOrder)) ||
    (video.sampleAspectRatio ?? 1) !== 1
  )
    throw new MediaError(
      'AI enhancement requires progressive, square-pixel, 8-bit, video-range SDR 4:2:0. HDR and alpha are unsupported.',
    );

  const rotation = Math.abs(video.rotation ?? 0);
  if (rotation % 90 !== 0)
    throw new MediaError(
      'AI enhancement requires right-angle display rotation.',
    );
  const rotated = rotation % 180 === 90;
  const width = (rotated ? video.height : video.width)!;
  const height = (rotated ? video.width : video.height)!;
  const upscale = operation.type === 'superResolution';
  const offline = upscale && operation.quality === 'high';
  const portrait = offline && width < height;
  const targetWidth = upscale ? operation.width : width;
  const targetHeight = upscale ? operation.height : height;
  const nativeWidth = portrait ? height : width;
  const nativeHeight = portrait ? width : height;
  const nativeScale = offline
    ? 4
    : operation.type === 'denoise'
      ? 1
      : targetWidth <= width * 1.5 && width % 4 === 0 && height % 4 === 0
        ? 1.5
        : 2;
  if (offline && (nativeWidth > 1920 || nativeHeight > 1080))
    throw new MediaError(
      'VideoToolbox high quality supports inputs up to 1920×1080 or 1080×1920.',
    );
  const rawWidth = nativeWidth * nativeScale;
  const rawHeight = nativeHeight * nativeScale;

  const matrices: Partial<Record<string, string>> = {
    bt709: 'bt709',
    bt470bg: 'bt601',
    smpte170m: 'bt601',
    smpte240m: 'smpte240m',
    bt2020nc: 'bt2020',
  };
  const colorSpace = enhancementColorSpace(video);
  const matrix = matrices[colorSpace];
  if (offline && !matrix)
    throw new MediaError(
      'VideoToolbox high quality cannot round-trip the source color matrix.',
    );
  const { ratio, scale, frame, count, lastDuration, tolerance } =
    enhancementTiming(input);
  const { origin, videoOffset, audioOffset } = clock(input);
  const offset = Math.round(videoOffset * scale);
  const audio = input.audio;
  const audioEnd =
    audioOffset !== null && audio?.durationSeconds != null
      ? audioOffset + audio.durationSeconds
      : null;
  const rawFormat = offline ? 'rgba' : 'nv12';
  const decodeFilters = [
    'format=yuv420p',
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    'scdet',
    "metadata=mode=print:key=lavfi.scd.score:file='pipe\\:3':direct=1",
    ...(portrait ? ['transpose=clock'] : []),
    ...(offline
      ? [
          `scale=in_range=tv:out_range=pc:in_color_matrix=${matrix}:flags=accurate_rnd+full_chroma_int`,
        ]
      : []),
    `format=${rawFormat}`,
  ];
  const filterWidth = portrait ? targetHeight : targetWidth;
  const filterHeight = portrait ? targetWidth : targetHeight;
  const tags = enhancementColorTags(video, colorSpace);
  // Set the tags on the converted frames as well as on the encoder. The
  // offline worker's raw RGB stream carries neither primaries nor transfer.
  const colorParameters = [
    'range=tv',
    ...tags.map(({ field, value }) => `${colorFields[field]}=${value}`),
  ];
  const encodeFilters = [
    ...(upscale
      ? [
          `scale=${filterWidth}:${filterHeight}:flags=lanczos+accurate_rnd${offline ? `:in_range=pc:out_range=tv:out_color_matrix=${matrix}` : ''}`,
        ]
      : []),
    'format=yuv420p',
    ...(portrait ? ['transpose=cclock'] : []),
    'setsar=1',
    `setparams=${colorParameters.join(':')}`,
    `settb=1/${scale}`,
    `setpts=PTS+${offset}`,
  ];
  const colors = [
    '-color_range',
    'tv',
    ...tags.flatMap(({ field, value }) => [`-${colorFields[field]}`, value]),
  ];
  await runRecipeProcess(
    {
      label: 'AI enhancement',
      timingPipe: `${output}.frames`,
      decoder: [
        ...recipeInputArguments(),
        '-i',
        input.path,
        '-map',
        `0:${video.index}`,
        '-vf',
        decodeFilters.join(','),
        '-fps_mode',
        'passthrough',
        '-threads:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      worker: {
        executable: worker,
        args: [
          offline ? 'video' : operation.type === 'denoise' ? 'noise' : 'fast',
          String(nativeWidth),
          String(nativeHeight),
          String(nativeScale),
          String(count),
          String(scale),
          String(frame),
          String(tolerance),
          String(
            operation.type === 'denoise'
              ? { light: 0.25, medium: 0.5, strong: 0.75 }[operation.quality]
              : 0,
          ),
          String(limits.maxBufferedFrames),
        ],
      },
      encoder: [
        '-copyts',
        ...(!offline ? colors : []),
        // The internal scaler surface can be larger than the source or target.
        '-max_pixels',
        String(Math.max(limits.maxPixels, rawWidth * rawHeight)),
        '-f',
        'rawvideo',
        '-pixel_format',
        rawFormat,
        '-video_size',
        `${rawWidth}x${rawHeight}`,
        '-framerate',
        ratio,
        '-i',
        'pipe:0',
        ...(audio
          ? [
              ...recipeInputArguments(),
              '-itsoffset',
              (-origin).toFixed(6),
              '-i',
              input.path,
              '-map',
              `1:${audio.index}`,
              '-c:a',
              'pcm_f32le',
              '-threads:a',
              '1',
              ...(audioEnd === null
                ? []
                : ['-af', `atrim=end=${audioEnd.toFixed(6)}`]),
            ]
          : []),
        '-map',
        '0:v:0',
        '-vf',
        encodeFilters.join(','),
        '-enc_time_base:v',
        `1:${scale}`,
        '-fps_mode',
        'passthrough',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-qp',
        '0',
        '-threads:v',
        '1',
        '-pix_fmt',
        'yuv420p',
        ...colors,
        '-bsf:v',
        // H.264 can omit its range flag when all other color tags are unknown.
        `h264_metadata=video_full_range_flag=0,setts=duration='if(eq(N,${count - 1}),${lastDuration},${frame})'`,
        '-video_track_timescale',
        String(scale),
        '-movie_timescale',
        String(scale),
        '-movflags',
        '+write_colr',
        '-use_editlist',
        '1',
        '-avoid_negative_ts',
        'disabled',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-n',
        output,
      ],
    },
    limits,
    signal,
    onTime,
  );
}

export function validateEnhancementOutput(
  input: MediaMetadata,
  output: MediaMetadata,
) {
  if (
    output.video?.colorRange !== 'tv' ||
    enhancementColorTags(input.video!).some(
      ({ field, value }) => output.video?.[field] !== value,
    )
  )
    throw new MediaError(
      'AI enhancement output did not preserve the expected SDR color tags.',
    );
  const { scale, duration, count } = enhancementTiming(input);
  const sourceClock = clock(input);
  const resultClock = clock(output);
  const sourceAudio = input.audio;
  const resultAudio = output.audio;
  if (
    output.video?.frameCount !== count ||
    Math.abs((output.video.durationSeconds ?? 0) - duration / scale) >
      0.000003 ||
    Math.abs(resultClock.videoOffset - sourceClock.videoOffset) > 0.000003 ||
    (sourceClock.audioOffset !== null &&
      (resultClock.audioOffset === null ||
        Math.abs(resultClock.audioOffset - sourceClock.audioOffset) > 0.001)) ||
    (sourceAudio?.durationSeconds != null &&
      Math.abs(
        (resultAudio?.durationSeconds ?? 0) - sourceAudio.durationSeconds,
      ) > 0.001)
  )
    throw new MediaError(
      'AI enhancement output did not preserve picture or audio timing.',
    );
}
