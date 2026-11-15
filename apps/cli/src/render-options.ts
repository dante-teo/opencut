import type { VideoRenderOptions } from '@opencut/core/video';
import { positiveIntegerOption, UsageError } from './usage.js';

export const renderOptionTypes = {
  quality: { type: 'string' },
  resolution: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  fps: { type: 'string' },
  codec: { type: 'string' },
  'video-bitrate': { type: 'string' },
  'audio-bitrate': { type: 'string' },
  'audio-rate': { type: 'string' },
  'audio-channels': { type: 'string' },
  overwrite: { type: 'boolean' },
  'no-subtitles': { type: 'boolean' },
} as const;

export const renderOptionHelp = `  --quality <draft|balanced|high> --resolution <project|720p|1080p>
  --width <pixels> --height <pixels> --fps <n|n/d> --codec <h264|hevc>
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
    value: T | undefined,
    allowed: readonly T[],
  ) {
    if (value === undefined) return undefined;
    if (!allowed.includes(value))
      throw new UsageError(`--${key} must be one of: ${allowed.join(', ')}.`);
    return value;
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
    quality: choice('quality', quality, [
      'draft',
      'balanced',
      'high',
    ]) as VideoRenderOptions['quality'],
    resolution: choice('resolution', resolution, [
      'project',
      '720p',
      '1080p',
    ]) as VideoRenderOptions['resolution'],
    codec: choice('codec', codec, [
      'h264',
      'hevc',
    ]) as VideoRenderOptions['codec'],
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
    ) as VideoRenderOptions['audioSampleRate'],
    audioChannels: choice(
      'audio-channels',
      positiveIntegerOption('audio-channels', values['audio-channels']),
      [1, 2],
    ) as VideoRenderOptions['audioChannels'],
    overwrite: values.overwrite,
    burnSubtitles: !values['no-subtitles'],
  };
}
