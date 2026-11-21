import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  accountRenderFile,
  decodeStillFrame,
  exposeGraphic,
  MediaError,
  openGraphicsRenderer,
  withDefaultRenderBudget,
} from '@opencut/media';
import type {
  GraphicLayer,
  VideoTimelineOptions,
  VisualTimelineClip,
} from '@opencut/media';
import { bindGraphicAudio } from './graphic-audio.js';
import { graphicFrameSamples } from './graphic-sampling.js';
import { compareTimes, frameTime } from './time.js';
import type { AudioRenderClip, ProjectRenderPlan } from './render-plan.js';
import type { CompiledVideo } from './video-compiler.js';
import { copyVideoInput } from './video-input.js';
import { graphicsFrameCache } from './video-graphics-cache.js';
import type { GraphicProps } from './video-graphics-contract.js';

type BoundPlan = Awaited<ReturnType<CompiledVideo['resolveRender']>>;
type RenderSourceBindings = Pick<
  VideoTimelineOptions,
  'snapshotSource' | 'renderGraphic'
>;
type RenderGraphic = NonNullable<RenderSourceBindings['renderGraphic']>;

interface RenderSourceOptions {
  scratch?: string | undefined;
  pictureCacheDirectory?: string | undefined;
  /** A watcher owns these private media copies for the full playback render. */
  pinnedPlan?: BoundPlan;
  audioComparison?: VideoTimelineOptions['audioComparison'];
}

/** Keep decoded sources stable for the lifetime of a render or preview. */
export async function withRenderSources<T>(
  video: CompiledVideo,
  signal: AbortSignal | undefined,
  render: (plan: BoundPlan & RenderSourceBindings) => Promise<T>,
  {
    scratch = tmpdir(),
    pictureCacheDirectory,
    pinnedPlan,
    audioComparison,
  }: RenderSourceOptions = {},
) {
  const plan = pinnedPlan ?? (await video.resolveRender());
  return withDefaultRenderBudget(signal, async () => {
    const staged = new Map<string, Promise<string>>();
    let sourceCount = 0;
    let directory: string | undefined;
    let opening: Promise<string> | undefined;
    const open = async () =>
      (directory = await (opening ??= mkdtemp(
        join(scratch, 'opencut-render-sources-'),
      )));

    async function snapshotSource(path: string) {
      const existing = staged.get(path);
      if (existing) return existing;
      const identity = video.sourceIdentity(path);
      if (!identity)
        throw new Error(`No compiled source identity for '${path}'.`);
      const index = sourceCount++;
      const pending = (async () => {
        const snapshot = join(await open(), `${index}${extname(path)}`);
        await accountRenderFile(path);
        await copyVideoInput(path, identity, snapshot, signal);
        return snapshot;
      })();
      staged.set(path, pending);
      return pending;
    }

    const sourceSnapshot = pinnedPlan ? undefined : snapshotSource;
    const decodeMedia = async (
      graphic: GraphicLayer,
      sample: number | import('./time.js').RationalTime,
      signal?: AbortSignal,
    ) => {
      const resources: Record<string, string> = Object.create(null);
      const time =
        typeof sample === 'number' ? frameTime(sample, plan.frameRate) : sample;
      for (const [id, { path, offset }] of Object.entries(
        graphic.mediaFrames ?? {},
      )) {
        const info = plan.sourceMetadata.get(path);
        if (!info)
          throw new MediaError(
            `Missing pinned source for media frame '${id}'.`,
          );
        const seconds =
          time.numerator / time.denominator +
          (offset ? offset.numerator / offset.denominator : 0);
        const snapshot = sourceSnapshot ? await sourceSnapshot(path) : path;
        const png = await decodeStillFrame(
          { ...info, path: snapshot },
          seconds,
          false,
          signal,
        );
        resources[id] = 'data:image/png;base64,' + png.toString('base64');
      }
      return resources;
    };
    const graphics = plan.visualClips.some(({ graphic }) => graphic)
      ? bindGraphicFrames(
          video,
          plan.frameRate,
          pictureCacheDirectory,
          bindGraphicAudio(
            video,
            plan,
            open,
            sourceSnapshot,
            audioComparison,
            signal,
          ),
          decodeMedia,
        )
      : undefined;
    try {
      return await render({
        ...plan,
        ...(!pinnedPlan && { snapshotSource }),
        ...(graphics && { renderGraphic: graphics.frame }),
      });
    } finally {
      try {
        await graphics?.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  });
}

function bindGraphicFrames(
  video: CompiledVideo,
  frameRate: BoundPlan['frameRate'],
  pictureCacheDirectory: string | undefined,
  audioAt: ReturnType<typeof bindGraphicAudio>,
  mediaAt: (
    graphic: GraphicLayer,
    sample: number | import('./time.js').RationalTime,
    signal?: AbortSignal,
  ) => Promise<Record<string, string>>,
) {
  const graphics = openGraphicsRenderer();
  const cache = pictureCacheDirectory
    ? graphicsFrameCache(pictureCacheDirectory)
    : undefined;
  const frame: RenderGraphic = async (clip, timelineFrame, signal) => {
    const { graphic, path, clipId } = clip;
    const bundle = video.graphicSource(graphic.bundleKey);
    if (!bundle)
      throw new MediaError(`No compiled graphic source for '${path}'.`);
    const { durationFrames } = graphic;
    let sampleDescription = '';
    let sampleContext = 'source sample';
    try {
      const samples = graphicFrameSamples(clip, timelineFrame, frameRate);
      sampleDescription = samples
        .map((sample) =>
          typeof sample === 'number'
            ? String(sample)
            : `${sample.numerator}/${sample.denominator}s`,
        )
        .join(', ');
      sampleContext =
        typeof samples[0] === 'number'
          ? `source frame ${sampleDescription}`
          : `source samples [${sampleDescription}]`;

      if (
        durationFrames !== undefined &&
        samples.some((sample) =>
          typeof sample === 'number'
            ? sample < 0 || sample >= durationFrames
            : compareTimes(sample, frameTime(durationFrames, frameRate)) >= 0,
        )
      )
        throw new MediaError('Sample is outside the graphics source.');
      const audio = await audioAt(graphic, timelineFrame);
      const rasterize = () =>
        exposeGraphic(
          graphic.width,
          graphic.height,
          samples.length,
          (index) =>
            graphics.frame(
              bundle,
              graphic,
              samples[index]!,
              frameRate,
              signal,
              audio,
              graphic.mediaFrames
                ? () => mediaAt(graphic, samples[index]!, signal)
                : undefined,
            ),
          signal,
        );
      const key = audio
        ? `${timelineFrame}:${sampleDescription}`
        : typeof samples[0] === 'number'
          ? samples[0]
          : sampleDescription;
      return await (cache
        ? cache(graphic.key, key, rasterize, signal)
        : rasterize());
    } catch (cause) {
      signal?.throwIfAborted();
      throw new MediaError(
        `Clip '${clipId}' graphic '${path}', timeline frame ${timelineFrame}, ${sampleContext}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  };
  return { frame, close: graphics.close };
}

/** Bind each timeline layer to the source selected by the project compiler. */
export function bindRenderSources(
  {
    visualClips,
    audioClips,
    visualTransitions,
    ...settings
  }: ProjectRenderPlan,
  resolveSource: (
    assetId: string,
    props?: GraphicProps,
  ) => { path: string; graphic?: GraphicLayer },
) {
  return {
    ...settings,
    visualClips: visualClips.map<VisualTimelineClip>((clip) => {
      if (clip.text) return clip;
      const { graphicProps, ...layer } = clip;
      return { ...layer, ...resolveSource(clip.assetId, graphicProps) };
    }),
    audioClips: audioClips.map<AudioRenderClip & { path: string }>((clip) => ({
      ...clip,
      path: resolveSource(clip.assetId).path,
    })),
    ...(visualTransitions?.length && {
      visualTransitions: visualTransitions.map(({ afterClipId, layers }) => ({
        afterClipId,
        layers: layers.map((clip) => ({
          ...clip,
          ...resolveSource(clip.assetId, clip.graphicProps),
        })),
      })),
    }),
  };
}
