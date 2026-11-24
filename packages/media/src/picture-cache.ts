import { createHash } from 'node:crypto';
import { opaqueCanvasColor } from '@opencut/shared';
import type { TextLayer } from '@opencut/shared';
import { MediaError, checkRenderSignal, runMediaTool } from './process.js';
import { isStillImage, probeMedia } from './probe.js';
import type { MediaMetadata } from './probe.js';
import type { TextRaster } from './text.js';
import type { VideoTimelineOptions, VisualTimelineClip } from './render.js';
import { accountRenderFile } from './render-budget.js';

export interface PictureRange {
  startFrame: number;
  endFrame: number;
  status: 'reused' | 'rendered';
}

export interface PictureCache {
  backend: string;
  sourceIdentity(path: string): string;
  materialize(
    key: string,
    encode: (path: string) => Promise<MediaMetadata>,
  ): Promise<{ path: string; reused: boolean }>;
  encoded?: {
    find(key: string): Promise<string | undefined>;
    store(
      key: string,
      encode: (path: string) => Promise<MediaMetadata>,
    ): Promise<string>;
  };
}

type FrameRate = VideoTimelineOptions['frameRate'];
type Transition = NonNullable<
  VideoTimelineOptions['visualTransitions']
>[number];
type Time = NonNullable<VisualTimelineClip['animation']>['start'];

interface CachePlan {
  options: VideoTimelineOptions;
  cache: Pick<PictureCache, 'backend' | 'sourceIdentity'>;
  pendingSources?: ReadonlyMap<string, string>;
  visualClips: VisualTimelineClip[];
  byOwner: ReadonlyMap<string, Transition[]>;
  startFrame: number;
  endFrame: number;
  outputWidth: number;
  outputHeight: number;
  warnings: string[];
  textRasterKeys?: Map<string, string>;
  rasterize(
    clip: VisualTimelineClip & { text: TextLayer },
  ): Promise<TextRaster>;
}

function digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function relativeTime(time: Time, frame: number, rate: FrameRate) {
  const n =
    BigInt(time.numerator) * BigInt(rate.numerator) -
    BigInt(frame) * BigInt(rate.denominator) * BigInt(time.denominator);
  const d = BigInt(time.denominator) * BigInt(rate.numerator);
  let a = n < 0n ? -n : n;
  let b = d;
  while (b) [a, b] = [b, a % b];
  return [(n / a).toString(), (d / a).toString()];
}

/** Use render inputs and clip-local sample positions as the identity of a range. */
export async function planPictureRanges({
  options,
  cache,
  pendingSources,
  visualClips,
  byOwner,
  startFrame,
  endFrame,
  outputWidth,
  outputHeight,
  warnings,
  textRasterKeys,
  rasterize,
}: CachePlan) {
  const { width, height, frameRate, signal } = options;
  const boundaries = new Set([startFrame, endFrame]);
  const include = (boundary: number) => {
    if (boundary > startFrame && boundary < endFrame) boundaries.add(boundary);
  };
  const sources = new Map(options.sourceMetadata);
  const identities = new Map<string, string>();
  const layers = new Map<VisualTimelineClip, { key: string; still: boolean }>();
  const layerKey = async (clip: VisualTimelineClip, start: number) => {
    let layer = layers.get(clip);
    const { retiming, text, animation } = clip;
    if (!layer) {
      let sourceKey: unknown;
      let still = !!text;
      if (text) {
        // Include the raster so font installation and fallback affect cache hits.
        const { png, x, y, warning } = await rasterize(clip);
        if (warning) warnings.push(`Clip '${clip.clipId}': ${warning}`);
        sourceKey = png && [digest(png), x, y];
        textRasterKeys?.set(
          clip.clipId,
          digest(JSON.stringify(sourceKey ?? null)),
        );
      } else if (clip.graphic) {
        still = clip.graphic.durationFrames === undefined;
        sourceKey = clip.graphic.key;
      } else {
        let identity = identities.get(clip.path);
        if (!identity) {
          identity = cache.sourceIdentity(clip.path);
          identities.set(clip.path, identity);
        }
        let metadata = sources.get(clip.path);
        if (!metadata) {
          metadata = await probeMedia(clip.path, signal);
          sources.set(clip.path, metadata);
        }
        const { freezeFrame } = clip;
        still = !!freezeFrame || isStillImage(metadata);
        sourceKey = [clip.path, identity, freezeFrame];
      }
      layer = {
        still,
        key: digest(
          JSON.stringify([
            sourceKey,
            clip.x,
            ...(clip.trackId ? [clip.trackId] : []),
            clip.y,
            clip.scale,
            clip.opacity,
            clip.rotation,
            clip.fit,
            clip.crop,
            clip.sourceWindow,
            clip.grade,
            animation?.keyframes,
            ...(animation && !text ? ['subpixel-transforms'] : []),
          ]),
        ),
      };
      layers.set(clip, layer);
    }
    const offset = start - clip.timelineStartFrame;
    return [
      layer.key,
      ...(clip.graphic?.audioAnalysis ? [start] : []),
      animation && relativeTime(animation.start, start, frameRate),
      ...(clip.graphic?.motionBlur
        ? [
            offset,
            clip.frameCount - offset,
            retiming && relativeTime(retiming.timelineEnd, start, frameRate),
          ]
        : []),
      layer.still
        ? null
        : retiming
          ? [
              offset,
              retiming.speed,
              ...(clip.graphic
                ? [
                    relativeTime(retiming.timelineStart, start, frameRate),
                    retiming.sourceIn,
                  ]
                : []),
              retiming.localSourceOriginNs ?? [
                retiming.sourceOriginNs,
                clip.timelineStartFrame,
              ],
            ]
          : clip.sourceStartFrame + offset,
    ];
  };
  const active = (start: number, end: number, frame: number) =>
    start <= frame && frame < end;
  for (const clip of visualClips) {
    include(clip.timelineStartFrame);
    include(clip.timelineStartFrame + clip.frameCount);
    for (const { layers } of byOwner.get(clip.clipId) ?? []) {
      const { startFrame, endFrame } = layers[0]!.ramp;
      include(startFrame);
      include(endFrame);
    }
  }
  const edges = [...boundaries].sort((a, b) => a - b);
  const ranges: {
    key: string;
    startFrame: number;
    endFrame: number;
    pending?: string[];
  }[] = [];
  const settings = [
    'ffv1-matroska-limited-bt709-v1',
    cache.backend,
    width,
    height,
    frameRate,
    outputWidth,
    outputHeight,
    opaqueCanvasColor(options.backgroundColor ?? '#000000'),
    ...(options.visualGroups?.length ? [options.visualGroups] : []),
  ];
  for (let i = 1; i < edges.length; i++) {
    checkRenderSignal(signal);
    const start = edges[i - 1]!;
    const end = edges[i]!;
    const count = end - start;
    const composition = [];
    const pending = new Set<string>();
    const activeKey = (clip: VisualTimelineClip) => {
      const paths = [
        clip.path,
        ...Object.values(clip.graphic?.mediaFrames ?? {}).map(
          ({ path }) => path,
        ),
      ];
      for (const path of paths)
        if (path && pendingSources?.has(path))
          pending.add(pendingSources.get(path)!);
      return layerKey(clip, start);
    };
    for (const clip of visualClips) {
      const at = clip.timelineStartFrame;
      if (active(at, at + clip.frameCount, start))
        composition.push(['layer', await activeKey(clip)]);
      for (const { layers } of byOwner.get(clip.clipId) ?? []) {
        const { startFrame, endFrame } = layers[0]!.ramp;
        if (active(startFrame, endFrame, start))
          composition.push([
            'transition',
            start - startFrame,
            endFrame - startFrame,
            await Promise.all(
              layers.map(async (layer) => [
                layer.ramp.direction,
                ...(layer.ramp.style ? [layer.ramp.style] : []),
                await activeKey(layer),
              ]),
            ),
          ]);
      }
    }
    const key = digest(JSON.stringify([settings, count, composition]));
    ranges.push({
      key,
      startFrame: start,
      endFrame: end,
      ...(pending.size && { pending: [...pending].sort() }),
    });
  }
  return ranges;
}

export function encodedPictureKey(
  ranges: Awaited<ReturnType<typeof planPictureRanges>>,
  settings: readonly unknown[],
) {
  return digest(JSON.stringify(['opencut-picture-v1', ranges, settings]));
}

/** Retain only the already verified picture packets, with a content-specific ID. */
export async function saveEncodedPicture(
  cache: NonNullable<PictureCache['encoded']>,
  key: string,
  path: string,
  timescale: number,
  signal?: AbortSignal,
) {
  const ffmpeg = [
    '-hide_banner',
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-xerror',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-map_metadata',
    '-1',
    '-c:v',
    'copy',
  ];
  const fingerprint = await runMediaTool(
    'ffmpeg',
    [...ffmpeg, '-f', 'hash', '-hash', 'sha256', 'pipe:1'],
    undefined,
    600_000,
    {
      signal,
      stage: `identifying verified picture in '${path}'`,
    },
  );
  const hash = /^SHA256=([a-f0-9]{64})$/.exec(
    fingerprint.toString().trim(),
  )?.[1];
  if (!hash)
    throw new MediaError('Could not identify the encoded picture packets.');
  const id = `${key}.${hash}`;
  const saved = await cache.store(id, async (output) => {
    await runMediaTool(
      'ffmpeg',
      [
        ...ffmpeg,
        '-video_track_timescale',
        String(timescale),
        '-f',
        'mp4',
        output,
      ],
      undefined,
      600_000,
      {
        signal,
        writesFile: true,
        stage: `saving verified picture '${id}'`,
      },
    );
    await accountRenderFile(output);
    return probeMedia(output, signal, { stage: 'verifying saved picture' });
  });
  return { id, path: saved };
}

export async function cachePicture(
  planned: Awaited<ReturnType<typeof planPictureRanges>>,
  cache: PictureCache,
  frameRate: FrameRate,
  signal: AbortSignal | undefined,
  encode: (
    startFrame: number,
    endFrame: number,
    destination: string,
  ) => Promise<void>,
  onRange?: (range: PictureRange) => void,
) {
  let concat = '';
  const ranges: PictureRange[] = [];
  for (const { key, startFrame: start, endFrame: end } of planned) {
    const count = end - start;
    const { path, reused } = await cache.materialize(
      key,
      async (destination) => {
        await encode(start, end, destination);
        const packets = await runMediaTool(
          'ffprobe',
          [
            '-v',
            'error',
            '-count_packets',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=nb_read_packets',
            '-of',
            'csv=p=0',
            destination,
          ],
          undefined,
          600_000,
          {
            signal,
            stage: `verifying picture range [${start}, ${end}) in '${destination}'`,
          },
        );
        if (Number(packets.toString().trim()) !== count)
          throw new MediaError(
            `Picture range [${start}, ${end}) has an unexpected frame count.`,
          );
        return probeMedia(destination, signal);
      },
    );
    if (/[\r\n]/.test(path))
      throw new MediaError('Picture cache paths cannot contain line breaks.');
    const duration = (count * frameRate.denominator) / frameRate.numerator;
    concat += `file '${path.replaceAll("'", "'\\''")}'\nduration ${duration.toFixed(6)}\n`;
    const range: PictureRange = {
      startFrame: start,
      endFrame: end,
      status: reused ? 'reused' : 'rendered',
    };
    ranges.push(range);
    onRange?.(range);
  }
  return { concat, ranges };
}
