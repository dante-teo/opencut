import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sourceColorMatrix } from '@opencut/shared';
import { MediaError } from './process.js';
import { recipeInputArguments } from './probe.js';
import type { MediaMetadata, MediaStream } from './probe.js';
import { nativeRecipeFingerprint, runRecipeProcess } from './recipe-process.js';
import type { RecipeProcessLimits } from './recipe-process.js';

export const interpolationBackendId = 'videotoolbox-interpolation-v3';
const interpolationAlgorithms = {
  'low-latency': 'videotoolbox-low-latency-nv12-midpoint',
  offline: 'videotoolbox-frame-rate-conversion-revision-1-quality-rgba-half',
} as const;

const worker = fileURLToPath(new URL('./video-interpolate', import.meta.url));

export async function interpolationBackendVersion(
  backend: InterpolationPlan['backend'],
  signal: AbortSignal,
) {
  const offline = backend === 'offline';
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    Number(release().split('.')[0]) < (offline ? 24 : 25)
  )
    throw new MediaError(
      `VideoToolbox ${backend} interpolation requires Apple Silicon and macOS ${offline ? '15.4' : '26'} or later. Run opencut system inspect --json.`,
    );
  return nativeRecipeFingerprint(
    worker,
    interpolationAlgorithms[backend],
    'interpolation',
    signal,
  );
}

export interface InterpolationPlan {
  numerator: number;
  denominator: number;
  backend: keyof typeof interpolationAlgorithms;
  sceneThreshold: number;
  sceneCuts: number[];
  speed: number;
  timing: ReturnType<typeof interpolationTiming>;
  videoStartSeconds: number;
  originShiftSeconds: number;
  preserveAudio: boolean;
}

export async function runInterpolation(
  input: MediaMetadata,
  plan: InterpolationPlan,
  output: string,
  limits: RecipeProcessLimits,
  signal: AbortSignal,
  onTime: (seconds: number) => void,
) {
  const video = input.video!;
  const audio = plan.preserveAudio ? input.audio : null;
  const origin = (input.startTimeSeconds ?? 0) + plan.originShiftSeconds;
  if (input.hasAudio && video.durationSeconds === null)
    throw new MediaError(
      'AI interpolation needs a declared video stream duration when audio is present. Remux to MOV with explicit stream timing.',
    );
  if (
    video.hasAlpha ||
    !['yuv420p', 'nv12'].includes(video.pixelFormat ?? '') ||
    (video.colorRange && !['unknown', 'tv'].includes(video.colorRange)) ||
    ['smpte2084', 'arib-std-b67'].includes(video.colorTransfer ?? '') ||
    (video.fieldOrder && !['unknown', 'progressive'].includes(video.fieldOrder))
  )
    throw new MediaError(
      'VideoToolbox interpolation requires progressive, 8-bit, video-range SDR 4:2:0 input.',
    );
  const rotation = Math.abs(video.rotation ?? 0);
  if (rotation % 90 !== 0)
    throw new MediaError(
      'AI interpolation requires a right-angle display rotation.',
    );
  const rotated = rotation % 180 === 90;
  const width = (rotated ? video.height : video.width)!;
  const height = (rotated ? video.width : video.height)!;
  if (limits.maxBufferedFrames < 3)
    throw new MediaError(
      'AI interpolation requires a buffer limit of at least 3 frames.',
    );

  const { numerator, denominator, timing } = plan;
  const { scale, frame, duration, frameCount } = timing;
  const last = frameCount - 1;
  const lastDuration = duration - last * frame;
  const offset = Math.round(plan.videoStartSeconds * scale);
  const sar = video.sampleAspectRatio ?? 1;
  const offline = plan.backend === 'offline';
  const rawFormat = offline ? 'rgba' : 'nv12';
  const colorSpace =
    video.colorSpace && !['unknown', 'unspecified'].includes(video.colorSpace)
      ? video.colorSpace
      : sourceColorMatrix(null, video.width!, video.height!, video.codec);
  const matrix = {
    bt709: 'bt709',
    bt601: 'bt601',
    bt470bg: 'bt601',
    smpte170m: 'bt601',
    smpte240m: 'smpte240m',
    bt2020nc: 'bt2020',
  }[colorSpace];
  if (offline && !matrix)
    throw new MediaError(
      'Offline interpolation cannot round-trip this SDR color matrix. Convert to BT.709 or explicitly select fast.',
    );
  const colorOptions = [
    '-color_range',
    'tv',
    ...(
      [
        [
          '-colorspace',
          offline
            ? colorSpace === 'bt601'
              ? 'smpte170m'
              : colorSpace
            : video.colorSpace,
        ],
        ['-color_primaries', video.colorPrimaries],
        ['-color_trc', video.colorTransfer],
        ['-chroma_sample_location', video.chromaLocation],
      ] as const
    ).flatMap(([flag, value]) =>
      value && value !== 'unknown' && value !== 'unspecified'
        ? [flag, value]
        : [],
    ),
  ];
  const decode = [
    ...recipeInputArguments(),
    '-i',
    input.path,
    '-map',
    `0:${video.index}`,
    '-vf',
    [
      'format=yuv420p,setpts=PTS-STARTPTS,settb=AVTB,scdet',
      "metadata=mode=print:key=lavfi.scd.score:file='pipe\\:3':direct=1",
      ...(offline
        ? [
            `scale=in_range=tv:out_range=pc:in_color_matrix=${matrix}:flags=accurate_rnd+full_chroma_int`,
          ]
        : []),
      `format=${rawFormat}`,
    ].join(','),
    '-fps_mode',
    'passthrough',
    '-threads:v',
    '1',
    '-pix_fmt',
    rawFormat,
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  const encode = [
    '-copyts',
    // Rawvideo carries no tags. Set its range and matrix before conversion.
    ...(!offline ? colorOptions : []),
    '-f',
    'rawvideo',
    '-pixel_format',
    rawFormat,
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    `${numerator}/${denominator}`,
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
          ...audioTrimArguments(audio, origin),
        ]
      : []),
    '-map',
    '0:v:0',
    '-vf',
    [
      ...(offline
        ? [
            `scale=in_range=pc:out_range=tv:out_color_matrix=${matrix}:flags=accurate_rnd+full_chroma_int`,
            'format=yuv420p',
          ]
        : []),
      `settb=1/${scale},setpts=PTS+${offset},setsar=${rotated ? 1 / sar : sar}:max=100000`,
    ].join(','),
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
    ...colorOptions,
    '-bsf:v',
    `setts=duration='if(eq(N,${last}),${lastDuration},${frame})'`,
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
  ];
  const native = [
    String(width),
    String(height),
    offline ? '1' : '0',
    String(scale),
    String(frame),
    String(duration),
    String(plan.speed),
    String(plan.sceneThreshold),
    JSON.stringify(plan.sceneCuts),
  ];
  await runRecipeProcess(
    {
      label: 'AI interpolation',
      timingPipe: `${output}.frames`,
      decoder: decode,
      worker: { executable: worker, args: native },
      encoder: encode,
    },
    limits,
    signal,
    onTime,
  );
}

export function interpolationTiming(
  numerator: number,
  denominator: number,
  seconds: number,
) {
  // Use an integer number of clock ticks per frame and retain microsecond
  // resolution for delayed starts and a partial final frame.
  const scale = numerator * Math.floor(1_000_000 / numerator);
  const frame = (scale / numerator) * denominator;
  const duration = Math.round(seconds * scale);
  if (!Number.isSafeInteger(duration) || duration < 1)
    throw new MediaError('AI interpolation output duration is out of range.');
  return { scale, frame, duration, frameCount: Math.ceil(duration / frame) };
}

function audioTrimArguments(audio: MediaStream, origin: number) {
  if (audio.durationSeconds === null) return [];
  const end =
    (audio.startTimeSeconds ?? origin) - origin + audio.durationSeconds;
  // Remove decoder tail padding past the declared audio stream endpoint.
  return ['-af', `atrim=end=${end.toFixed(6)}`];
}
