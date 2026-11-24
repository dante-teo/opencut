import {
  checkRenderSignal,
  localFile,
  MediaError,
  runMediaTool,
} from './process.js';

export interface MediaStream {
  index: number;
  type: string;
  codec: string | null;
  durationSeconds: number | null;
  startTimeSeconds: number | null;
  timeBase: string | null;
  bitRate: number | null;
  language: string | null;
  isDefault: boolean;
  isAttachedPicture: boolean;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  frameRateRatio: string | null;
  frameCount?: number | null;
  nominalFrameRateRatio?: string | null;
  hasHdrMetadata?: boolean;
  pixelFormat: string | null;
  /** Display geometry; optional for callers supplying legacy metadata. */
  sampleAspectRatio?: number;
  colorSpace?: string | null;
  colorRange?: string | null;
  colorPrimaries?: string | null;
  colorTransfer?: string | null;
  chromaLocation?: string | null;
  fieldOrder?: string | null;
  hasAlpha?: boolean;
  rotation?: number;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
}

export interface MediaMetadata {
  path: string;
  formatName: string | null;
  startTimeSeconds: number | null;
  durationSeconds: number | null;
  hasAudio: boolean;
  video: MediaStream | null;
  audio: MediaStream | null;
  streams: MediaStream[];
  diagnostic?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value !== 'N/A'
    ? value
    : null;
}

function finiteNumber(value: unknown, minimum = 0): number | null {
  if (typeof value !== 'number' && text(value) === null) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= minimum ? result : null;
}

function parseFrameRate(value: unknown): number | null {
  const parts = text(value)?.split('/');
  if (!parts || parts.length !== 2) return null;
  const numerator = finiteNumber(parts[0]);
  const denominator = finiteNumber(parts[1]);
  if (numerator === null || !denominator) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function sameFrameRate(
  actual: string | null,
  numerator: number,
  denominator: number,
): boolean {
  const parts = actual?.match(/^(\d+)\/(\d+)$/);
  return (
    !!parts &&
    BigInt(parts[1]!) * BigInt(denominator) ===
      BigInt(numerator) * BigInt(parts[2]!) &&
    BigInt(parts[2]!) > 0n
  );
}

function parseStream(value: unknown): MediaStream {
  const data = record(value);
  const index = finiteNumber(data.index);
  const type = text(data.codec_type);
  if (index === null || !Number.isInteger(index) || type === null) {
    throw new MediaError('ffprobe returned invalid stream information.');
  }
  const disposition = record(data.disposition);
  const frameRate = parseFrameRate(data.avg_frame_rate);
  const durationTicks = finiteNumber(data.duration_ts);
  const [timeNumerator, timeDenominator] =
    text(data.time_base)?.split('/').map(Number) ?? [];
  return {
    index,
    type,
    codec: text(data.codec_name),
    durationSeconds:
      durationTicks !== null &&
      Number.isSafeInteger(durationTicks) &&
      timeNumerator !== undefined &&
      timeNumerator > 0 &&
      timeDenominator !== undefined &&
      timeDenominator > 0 &&
      Number.isSafeInteger(timeNumerator) &&
      Number.isSafeInteger(timeDenominator)
        ? (durationTicks * timeNumerator) / timeDenominator
        : finiteNumber(data.duration),
    startTimeSeconds: finiteNumber(data.start_time, -Infinity),
    timeBase: text(data.time_base),
    bitRate: finiteNumber(data.bit_rate),
    language: text(record(data.tags).language),
    isDefault: disposition.default === 1,
    isAttachedPicture: disposition.attached_pic === 1,
    width: finiteNumber(data.width, 1),
    height: finiteNumber(data.height, 1),
    frameRate,
    frameRateRatio: frameRate === null ? null : text(data.avg_frame_rate),
    frameCount: finiteNumber(data.nb_frames),
    nominalFrameRateRatio: text(data.r_frame_rate),
    hasHdrMetadata:
      Array.isArray(data.side_data_list) &&
      data.side_data_list.some((side) =>
        /HDR|DOVI|Dolby Vision|Mastering display|Content light/i.test(
          String(record(side).side_data_type ?? ''),
        ),
      ),
    pixelFormat: text(data.pix_fmt),
    colorSpace: text(data.color_space),
    colorRange: text(data.color_range),
    colorPrimaries: text(data.color_primaries),
    colorTransfer: text(data.color_transfer),
    chromaLocation: text(data.chroma_location),
    fieldOrder: text(data.field_order),
    hasAlpha:
      /^(?:yuva|gbrap|rgba|argb|bgra|abgr|ya|pal8)/.test(
        text(data.pix_fmt) ?? '',
      ) || String(record(data.tags).alpha_mode) === '1',
    sampleAspectRatio:
      parseFrameRate(text(data.sample_aspect_ratio)?.replace(':', '/')) ?? 1,
    rotation:
      finiteNumber(
        record(
          Array.isArray(data.side_data_list)
            ? data.side_data_list.find(
                (side) => record(side).rotation !== undefined,
              )
            : null,
        ).rotation,
        -Infinity,
      ) ?? 0,
    sampleRate: finiteNumber(data.sample_rate, 1),
    channels: finiteNumber(data.channels, 1),
    channelLayout: text(data.channel_layout),
  };
}

export function isStillImage(source: MediaMetadata): boolean {
  const format = source.formatName ?? '';
  return Boolean(
    source.video &&
    !source.audio &&
    (format.endsWith('_pipe') ||
      ['image2', 'image2pipe'].includes(format) ||
      (['gif', 'apng'].includes(format) && !source.durationSeconds)),
  );
}

export function videoSourceDuration(source: MediaMetadata): number | null {
  if (!source.video) return null;
  const offset =
    (source.video.startTimeSeconds ?? source.startTimeSeconds ?? 0) -
    (source.startTimeSeconds ?? 0);
  return (
    source.video.durationSeconds ??
    (source.durationSeconds === null ? null : source.durationSeconds - offset)
  );
}

function audioSourceOrigin(source: MediaMetadata): number {
  return (
    source.video?.startTimeSeconds ??
    source.audio?.startTimeSeconds ??
    source.startTimeSeconds ??
    0
  );
}

/** Convert OpenCut source time to an FFmpeg input seek from the container start. */
export function audioSourceSeek(
  source: MediaMetadata,
  seconds: number,
): number {
  const origin = audioSourceOrigin(source);
  return Math.max(0, seconds + origin - (source.startTimeSeconds ?? origin));
}

export function audioSourceDuration(source: MediaMetadata): number | null {
  if (!source.audio) return null;
  const origin = audioSourceOrigin(source);
  const offset = (source.audio.startTimeSeconds ?? origin) - origin;
  return source.audio.durationSeconds === null
    ? source.durationSeconds === null
      ? null
      : source.durationSeconds - (origin - (source.startTimeSeconds ?? origin))
    : source.audio.durationSeconds + offset;
}

const dialogueFormats =
  'image2,jpeg_pipe,png_pipe,apng,gif,gif_pipe,webp_pipe,mp3,ogg,wav,flac,mov,matroska,webm';
const recipeFormats = `${dialogueFormats},bmp_pipe,tiff_pipe,avi,aac,aiff`;

function localInputArguments(formats: string) {
  return ['-protocol_whitelist', 'file', '-format_whitelist', formats];
}

export function recipeInputArguments() {
  return localInputArguments(recipeFormats);
}

export function probeMedia(
  file: string,
  signal?: AbortSignal,
  options?: { localMediaOnly?: boolean; stage?: string },
): Promise<MediaMetadata> {
  return probe(
    file,
    signal,
    options?.localMediaOnly ? localInputArguments(dialogueFormats) : [],
    options?.stage,
  );
}

export function probeRecipeMedia(file: string, signal?: AbortSignal) {
  return probe(file, signal, recipeInputArguments());
}

async function probe(
  file: string,
  signal: AbortSignal | undefined,
  inputArguments: string[],
  stage = 'probing media input',
): Promise<MediaMetadata> {
  checkRenderSignal(signal);
  const path = await localFile(file);
  const context = `${stage} '${path}'`;
  let diagnostic: string | undefined;
  const output = await runMediaTool(
    'ffprobe',
    [
      '-v',
      'error',
      ...inputArguments,
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      path,
    ],
    undefined,
    undefined,
    {
      signal,
      stage: context,
      onNonfatalDiagnostic(message) {
        diagnostic = message;
      },
    },
  );
  const invalidMetadata = (reason: string, cause?: unknown) =>
    new MediaError(
      `Error while ${context}. ffprobe exited with status 0 and returned ${reason}.`,
      cause === undefined ? undefined : { cause },
    );
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(output.toString('utf8')) as unknown);
  } catch (error) {
    throw invalidMetadata('invalid JSON', error);
  }
  if (!Array.isArray(data.streams) || data.streams.length === 0)
    throw invalidMetadata('no media streams');
  let streams: MediaStream[];
  try {
    streams = data.streams.map(parseStream);
  } catch (cause) {
    throw invalidMetadata('invalid stream information', cause);
  }
  const videos = streams.filter(
    (item) => item.type === 'video' && !item.isAttachedPicture,
  );
  const audios = streams.filter((item) => item.type === 'audio');
  const format = record(data.format);
  const durations = streams.flatMap((item) =>
    item.durationSeconds === null ? [] : [item.durationSeconds],
  );
  return {
    path,
    formatName: text(format.format_name),
    startTimeSeconds: finiteNumber(format.start_time, -Infinity),
    durationSeconds:
      finiteNumber(format.duration) ??
      (durations.length ? Math.max(...durations) : null),
    hasAudio: audios.length > 0,
    video: videos.find((item) => item.isDefault) ?? videos[0] ?? null,
    audio: audios.find((item) => item.isDefault) ?? audios[0] ?? null,
    streams,
    ...(diagnostic && { diagnostic }),
  };
}
