import { checkRenderSignal, MediaError, runMediaTool } from './process.js';
import { renderQualityProfiles } from '@opencut/shared';
import type { RenderQuality } from '@opencut/shared';

export const renderEncoders = ['auto', 'software', 'videotoolbox'] as const;
export type RenderEncoder = (typeof renderEncoders)[number];

interface EncoderTarget {
  codec: 'h264' | 'hevc';
  quality: RenderQuality;
  width: number;
  height: number;
  rate: { numerator: number; denominator: number };
  bitrate?: number | undefined;
  keyframeInterval?: number | undefined;
}

type Settings = {
  pixelFormat: 'yuv420p';
  rateControl:
    { mode: 'crf'; crf: number } | { mode: 'bitrate'; bitrateKbps: number };
  preset?: string;
  threads?: number;
  x265Params?: string;
  keyframeInterval?: number;
  closedGop?: boolean;
  allowSoftware?: false;
  realtime?: false;
};
export interface RenderEncoderReport {
  requested: RenderEncoder;
  selected: Exclude<RenderEncoder, 'auto'>;
  name: string;
  settings: Settings;
  fallbackReason?: string;
}

export function encoderArguments(report: RenderEncoderReport): string[] {
  const { name, settings } = report;
  const { rateControl, pixelFormat, preset, threads, x265Params } = settings;
  return [
    '-c:v',
    name,
    ...(preset ? ['-preset', preset] : []),
    ...(rateControl.mode === 'crf'
      ? ['-crf', String(rateControl.crf)]
      : ['-b:v', `${rateControl.bitrateKbps}k`]),
    ...((settings.keyframeInterval && [
      '-g',
      String(settings.keyframeInterval),
    ]) ||
      []),
    ...(settings.closedGop && name === 'libx264'
      ? ['-sc_threshold', '0', '-flags', '+cgop']
      : []),
    ...(x265Params ? ['-x265-params', x265Params] : []),
    ...(settings.allowSoftware === false ? ['-allow_sw', '0'] : []),
    ...(settings.realtime === false ? ['-realtime', '0'] : []),
    ...(threads ? ['-threads', String(threads)] : []),
    '-pix_fmt',
    pixelFormat,
  ];
}

export async function selectRenderEncoder(
  requested: RenderEncoder | undefined,
  target: EncoderTarget,
  signal?: AbortSignal,
): Promise<RenderEncoderReport> {
  const { codec, quality, width, height, rate, bitrate, keyframeInterval } =
    target;
  const { encoding } = renderQualityProfiles[quality];
  const software: RenderEncoderReport = {
    requested: requested ?? 'software',
    selected: 'software',
    name: codec === 'h264' ? 'libx264' : 'libx265',
    settings: {
      pixelFormat: 'yuv420p',
      rateControl:
        bitrate === undefined
          ? { mode: 'crf', crf: Number(encoding.crf) }
          : { mode: 'bitrate', bitrateKbps: bitrate },
      preset: encoding.preset,
      threads: 2,
      ...(keyframeInterval && { keyframeInterval, closedGop: true }),
      ...(codec === 'hevc' && {
        x265Params:
          'pools=2:log-level=error' +
          (keyframeInterval ? ':open-gop=0:scenecut=0' : ''),
      }),
    },
  };
  if (requested === undefined) return software;
  if (!renderEncoders.includes(requested))
    throw new MediaError(
      'Unknown render encoder. Choose auto, software or videotoolbox.',
    );

  const bitsPerPixel = { fast: 0.05, quality: 0.1, maximum: 0.16 }[quality];
  const targetKbps = Math.max(
    100,
    Math.ceil(
      (((width * height * rate.numerator) / rate.denominator) *
        bitsPerPixel *
        (codec === 'hevc' ? 0.75 : 1)) /
        1000,
    ),
  );
  const hardware: RenderEncoderReport = {
    requested,
    selected: 'videotoolbox',
    name: `${codec}_videotoolbox`,
    settings: {
      pixelFormat: 'yuv420p',
      rateControl: { mode: 'bitrate', bitrateKbps: bitrate ?? targetKbps },
      ...(keyframeInterval && { keyframeInterval }),
      allowSoftware: false,
      realtime: false,
    },
  };
  const check = async (report: RenderEncoderReport) => {
    try {
      await runMediaTool(
        'ffmpeg',
        [
          '-hide_banner',
          '-v',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          `color=s=${width}x${height}:r=${rate.numerator}/${rate.denominator},format=yuv420p`,
          '-frames:v',
          '2',
          '-an',
          ...encoderArguments(report),
          '-f',
          'null',
          'pipe:1',
        ],
        undefined,
        30_000,
        { signal, stage: `checking ${report.name} support` },
      );
    } catch (cause) {
      checkRenderSignal(signal);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new MediaError(
        `${report.name} cannot encode ${codec} at ${width}×${height}, ${rate.numerator}/${rate.denominator} fps. ` +
          (report.selected === 'videotoolbox'
            ? 'Use --encoder software or choose other delivery settings. '
            : 'Check FFmpeg encoder support or choose other delivery settings. ') +
          reason,
        { cause },
      );
    }
  };
  if (requested === 'software') {
    await check(software);
    return software;
  }
  try {
    await check(hardware);
    return hardware;
  } catch (error) {
    if (requested !== 'auto') throw error;
    checkRenderSignal(signal);
    await check(software);
    return { ...software, fallbackReason: (error as Error).message };
  }
}
