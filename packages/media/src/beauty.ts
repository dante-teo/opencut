import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MediaError, runMediaTool } from './process.js';
import type { MediaMetadata } from './probe.js';
import { isStillImage, videoSourceDuration } from './probe.js';
import { sourceColorMatrix } from '@opencut/shared';
import { orientedSource } from './source-window.js';

export const beautyModels = [
  {
    file: 'face.task',
    version: 'face_landmarker/float16/1',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    file: 'pose.task',
    version: 'pose_landmarker_full/float16/1',
    sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  },
  {
    file: 'parts.tflite',
    version: 'selfie_multiclass_256x256/float32/1',
    sha256: 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0',
  },
] as const;

export const beautyBackend = 'mediapipe-cpu-v1';
export const beautyRuntimeHint =
  'See docs/BEAUTY.md. Set OPENCUT_BEAUTY_PYTHON to the isolated Python executable and OPENCUT_BEAUTY_MODELS to the directory containing the pinned local model files.';
export const beautyWorkerFiles = [
  'worker.py',
  'analysis.py',
  'effects.py',
  'controls.py',
  'deformation.py',
  'background.py',
  'contours.py',
  'response.py',
  'visible-result.json',
].map((name) => fileURLToPath(new URL('./beauty/' + name, import.meta.url)));

export function beautySource(media: MediaMetadata) {
  const { video } = media;
  const duration = videoSourceDuration(media);
  if (
    !video ||
    isStillImage(media) ||
    video.isAttachedPicture ||
    !duration ||
    !video.timeBase
  )
    throw new MediaError(
      'Beauty requires timed video with a known duration and presentation time base.',
    );
  const { width, height, sar } = orientedSource(video);
  const rotation = video.rotation ?? 0;
  if (
    !width ||
    !height ||
    width < 32 ||
    height < 32 ||
    width * height > 8_294_400 ||
    sar !== 1 ||
    rotation % 90 !== 0 ||
    (video.fieldOrder && !['progressive', 'unknown'].includes(video.fieldOrder))
  )
    throw new MediaError(
      'Beauty requires progressive square-pixel video, 32 pixels or larger per side and up to 8,294,400 pixels.',
    );
  const timeScale = Number(video.timeBase.split('/')[1]);
  if (
    !Number.isSafeInteger(timeScale) ||
    timeScale < 1 ||
    timeScale > 2_147_483_647
  )
    throw new MediaError(
      'Beauty cannot preserve this source time base in a MOV.',
    );
  const pixelFormat = video.pixelFormat ?? '';
  const matrix =
    (!video.colorSpace || ['unknown', 'unspecified'].includes(video.colorSpace)
      ? null
      : video.colorSpace) ??
    (sourceColorMatrix(
      null,
      video.width ?? width,
      video.height ?? height,
      video.codec,
    ) === 'bt709'
      ? 'bt709'
      : 'smpte170m');
  if (
    !/^(yuvj?(420|422|444)p|rgb24|bgr24)$/.test(pixelFormat) ||
    video.hasHdrMetadata ||
    video.hasAlpha ||
    !['bt709', 'smpte170m', 'bt470bg', 'gbr'].includes(matrix) ||
    ![
      null,
      undefined,
      'bt709',
      'smpte170m',
      'iec61966-2-1',
      'unknown',
      'unspecified',
    ].includes(video.colorTransfer) ||
    ![
      null,
      undefined,
      'bt709',
      'smpte170m',
      'bt470bg',
      'unknown',
      'unspecified',
    ].includes(video.colorPrimaries) ||
    ![null, undefined, 'tv', 'pc', 'unknown', 'unspecified'].includes(
      video.colorRange,
    )
  )
    throw new MediaError(
      'Beauty supports 8-bit SDR BT.709, BT.601, and sRGB inputs. Convert unsupported color configurations explicitly before analysis.',
    );
  return {
    width,
    height,
    rotation,
    matrix: matrix === 'bt709' ? 1 : 5,
    range:
      video.colorRange === 'pc' || /^(yuvj|[rb]gr)/.test(pixelFormat)
        ? 'JPEG'
        : 'MPEG',
    stream: video.index,
    timeScale,
  };
}

type WorkerCommand =
  'preflight' | 'analyze' | 'render' | 'samples' | 'evaluate' | 'verify';
export async function runBeautyWorker(
  command: WorkerCommand,
  request: string | undefined,
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    onTime?: ((seconds: number) => void) | undefined;
    onResult?: ((value: unknown) => void) | undefined;
  } = {},
): Promise<unknown> {
  const python = process.env.OPENCUT_BEAUTY_PYTHON;
  if (!python?.trim())
    throw new MediaError(
      'Required executable for beauty is unconfigured. ' + beautyRuntimeHint,
    );
  let line = '';
  let result: unknown;
  await runMediaTool(
    resolve(python),
    [
      command === 'evaluate'
        ? fileURLToPath(new URL('./beauty/evaluation.py', import.meta.url))
        : beautyWorkerFiles[0]!,
      command,
      ...(request ? [request] : []),
    ],
    28 * 1024 * 1024,
    options.timeoutMs ?? 10_000,
    {
      signal: options.signal,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        OMP_NUM_THREADS: '1',
        OPENBLAS_NUM_THREADS: '1',
      },
      writesFile: !!request,
      stage: 'running beauty ' + command,
      onDiagnostics() {
        // MediaPipe's optional delegate warnings are diagnostic on success.
      },
      onStdout(chunk) {
        line += chunk.toString('utf8');
        const lines = line.split('\n');
        line = lines.pop()!;
        for (const item of lines) {
          if (!item.trim()) continue;
          const event = JSON.parse(item) as {
            event?: unknown;
            seconds?: unknown;
            result?: unknown;
          };
          if (event.event === 'result') {
            result = event.result;
            options.onResult?.(result);
          } else if (
            event.event === 'progress' &&
            typeof event.seconds === 'number'
          )
            options.onTime?.(event.seconds);
        }
      },
    },
  );
  if (result === undefined)
    throw new MediaError('Beauty worker did not return its structured result.');
  return result;
}
