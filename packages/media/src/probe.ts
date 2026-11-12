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
  pixelFormat: string | null;
  /** Display geometry; optional for callers supplying legacy metadata. */
  sampleAspectRatio?: number;
  colorSpace?: string | null;
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

function parseStream(value: unknown): MediaStream {
  const data = record(value);
  const index = finiteNumber(data.index);
  const type = text(data.codec_type);
  if (index === null || !Number.isInteger(index) || type === null) {
    throw new MediaError('ffprobe returned invalid stream information.');
  }
  const disposition = record(data.disposition);
  const frameRate = parseFrameRate(data.avg_frame_rate);
  return {
    index,
    type,
    codec: text(data.codec_name),
    durationSeconds: finiteNumber(data.duration),
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
    pixelFormat: text(data.pix_fmt),
    colorSpace: text(data.color_space),
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

export async function probeMedia(
  file: string,
  signal?: AbortSignal,
  options?: { localMediaOnly: boolean },
): Promise<MediaMetadata> {
  checkRenderSignal(signal);
  const path = await localFile(file);
  const output = await runMediaTool(
    'ffprobe',
    [
      '-v',
      'error',
      ...(options?.localMediaOnly
        ? [
            '-protocol_whitelist',
            'file',
            '-format_whitelist',
            'image2,jpeg_pipe,png_pipe,apng,gif,gif_pipe,webp_pipe,mp3,ogg,wav,flac,mov,matroska,webm',
          ]
        : []),
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      path,
    ],
    undefined,
    undefined,
    signal ? { signal } : undefined,
  );
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(output.toString('utf8')) as unknown);
  } catch (error) {
    throw new MediaError('ffprobe returned invalid JSON.', { cause: error });
  }
  if (!Array.isArray(data.streams) || data.streams.length === 0) {
    throw new MediaError(`No media streams found in '${path}'.`);
  }
  const streams = data.streams.map(parseStream);
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
  };
}
