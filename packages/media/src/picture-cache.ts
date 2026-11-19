import { createHash } from 'node:crypto';
import { opaqueCanvasColor } from '@opencut/shared';
import type { TextLayer } from '@opencut/shared';
import { MediaError, checkRenderSignal, runMediaTool } from './process.js';
import { isStillImage, probeMedia } from './probe.js';
import type { MediaMetadata } from './probe.js';
import type { TextRaster } from './text.js';
import type { VideoTimelineOptions, VisualTimelineClip } from './render.js';

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
}

type FrameRate = VideoTimelineOptions['frameRate'];
type Transition = NonNullable<
  VideoTimelineOptions['visualTransitions']
>[number];
type Time = NonNullable<VisualTimelineClip['animation']>['start'];

interface CachePlan {
  options: VideoTimelineOptions;
  cache: PictureCache;
  visualClips: VisualTimelineClip[];
  byOwner: ReadonlyMap<string, Transition[]>;
  startFrame: number;
  endFrame: number;
  outputWidth: number;
  outputHeight: number;
  warnings: string[];
  rasterize(
    clip: VisualTimelineClip & { text: TextLayer },
  ): Promise<TextRaster>;
  encode(
    startFrame: number,
    endFrame: number,
    destination: string,
  ): Promise<void>;
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
export async function cachePicture({
  options,
  cache,
  visualClips,
  byOwner,
  startFrame,
  endFrame,
  outputWidth,
  outputHeight,
  warnings,
  rasterize,
  encode,
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
            clip.y,
            clip.scale,
            clip.opacity,
            clip.rotation,
            clip.fit,
            clip.crop,
            clip.grade,
            animation?.keyframes,
          ]),
        ),
      };
      layers.set(clip, layer);
    }
    const offset = start - clip.timelineStartFrame;
    return [
      layer.key,
      animation && relativeTime(animation.start, start, frameRate),
      layer.still
        ? null
        : retiming
          ? [
              offset,
              retiming.speed,
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
  let concat = '';
  const ranges: PictureRange[] = [];
  const settings = [
    cache.backend,
    width,
    height,
    frameRate,
    outputWidth,
    outputHeight,
    opaqueCanvasColor(options.backgroundColor ?? '#000000'),
  ];
  for (let i = 1; i < edges.length; i++) {
    checkRenderSignal(signal);
    const start = edges[i - 1]!;
    const end = edges[i]!;
    const count = end - start;
    const composition = [];
    for (const clip of visualClips) {
      const at = clip.timelineStartFrame;
      if (active(at, at + clip.frameCount, start))
        composition.push(['layer', await layerKey(clip, start)]);
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
                await layerKey(layer, start),
              ]),
            ),
          ]);
      }
    }
    const key = digest(JSON.stringify([settings, count, composition]));
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
          { signal },
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
    ranges.push({
      startFrame: start,
      endFrame: end,
      status: reused ? 'reused' : 'rendered',
    });
  }
  return { concat, ranges };
}
