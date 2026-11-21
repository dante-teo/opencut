import type { VideoRenderOptions } from '@opencut/core/video';
import {
  renderCodecs,
  renderEncoders,
  renderQualities,
  renderResolutions,
} from '@opencut/media';
import type { RenderQuality } from '@opencut/media';
import { positiveIntegerOption, UsageError } from './usage.js';

export const renderOptionTypes = {
  quality: { type: 'string' },
  resolution: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  fps: { type: 'string' },
  codec: { type: 'string' },
  encoder: { type: 'string' },
  'video-bitrate': { type: 'string' },
  'audio-bitrate': { type: 'string' },
  'audio-rate': { type: 'string' },
  'audio-channels': { type: 'string' },
  overwrite: { type: 'boolean' },
  'no-subtitles': { type: 'boolean' },
} as const;

export const qualityOption = '[--quality <fast|quality|maximum>]';

export function parseRenderQuality(
  value: string | undefined,
  fallback: RenderQuality,
) {
  if (value === undefined) return fallback;
  const quality = renderQualities.find((profile) => profile === value);
  if (!quality)
    throw new UsageError('--quality must be fast, quality or maximum.');
  return quality;
}

export const renderOptionHelp = `  --quality <fast|quality|maximum> --resolution <project|720p|1080p>
  --width <pixels> --height <pixels> --fps <n|n/d> --codec <h264|hevc>
  --encoder <${renderEncoders.join('|')}>
  --video-bitrate <kbps> --audio-bitrate <kbps> --audio-rate <44100|48000>
  --audio-channels <1|2> --no-subtitles --overwrite`;

export function parseRenderControls(values: {
  [
    K in keyof typeof renderOptionTypes
  ]?: (typeof renderOptionTypes)[K]['type'] extends 'string'
    ? string | undefined
    : boolean | undefined;
}): VideoRenderOptions {
  function choice<T extends string | number>(
    key: string,
    value: string | number | undefined,
    allowed: readonly T[],
  ) {
    if (value === undefined) return undefined;
    const match = allowed.find((option) => option === value);
    if (match === undefined)
      throw new UsageError(`--${key} must be one of: ${allowed.join(', ')}.`);
    return match;
  }
  const width = positiveIntegerOption('width', values.width);
  const height = positiveIntegerOption('height', values.height);
  if ((width === undefined) !== (height === undefined))
    throw new UsageError('Specify both --width and --height.');
  const fps = values.fps;
  if (fps !== undefined && !/^\d+(?:\/\d+)?$/.test(fps))
    throw new UsageError(
      '--fps must be an integer or fraction such as 30000/1001.',
    );
  const [numerator, denominator = 1] = fps?.split('/').map(Number) ?? [];
  if (
    numerator !== undefined &&
    [numerator, denominator].some((n) => !Number.isSafeInteger(n) || n <= 0)
  )
    throw new UsageError('--fps requires positive safe integers.');

  const { quality, resolution, codec } = values;
  return {
    quality: parseRenderQuality(quality, 'quality'),
    resolution: choice('resolution', resolution, renderResolutions),
    codec: choice('codec', codec, renderCodecs),
    encoder: choice('encoder', values.encoder, renderEncoders),
    outputSize:
      width !== undefined && height !== undefined
        ? { width, height }
        : undefined,
    outputFrameRate:
      numerator === undefined ? undefined : { numerator, denominator },
    videoBitrateKbps: positiveIntegerOption(
      'video-bitrate',
      values['video-bitrate'],
    ),
    audioBitrateKbps: positiveIntegerOption(
      'audio-bitrate',
      values['audio-bitrate'],
    ),
    audioSampleRate: choice(
      'audio-rate',
      positiveIntegerOption('audio-rate', values['audio-rate']),
      [44100, 48000],
    ),
    audioChannels: choice(
      'audio-channels',
      positiveIntegerOption('audio-channels', values['audio-channels']),
      [1, 2],
    ),
    overwrite: values.overwrite,
    burnSubtitles: !values['no-subtitles'],
  };
}
