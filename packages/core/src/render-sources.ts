import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  accountRenderFile,
  MediaError,
  openGraphicsRenderer,
  withDefaultRenderBudget,
} from '@opencut/media';
import type {
  GraphicLayer,
  VideoTimelineOptions,
  VisualTimelineClip,
} from '@opencut/media';
import { sampleClipSourceFrame } from './clip-timing.js';
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
  }: RenderSourceOptions = {},
) {
  const plan = pinnedPlan ?? (await video.resolveRender());
  return withDefaultRenderBudget(signal, async () => {
    const staged = new Map<string, string>();
    let directory: string | undefined;
    const graphics = plan.visualClips.some(({ graphic }) => graphic)
      ? bindGraphicFrames(video, plan.frameRate, pictureCacheDirectory)
      : undefined;

    async function snapshotSource(path: string) {
      const existing = staged.get(path);
      if (existing) return existing;
      const identity = video.sourceIdentity(path);
      if (!identity)
        throw new Error(`No compiled source identity for '${path}'.`);
      directory ??= await mkdtemp(join(scratch, 'opencut-render-sources-'));
      const snapshot = join(directory, `${staged.size}${extname(path)}`);
      await accountRenderFile(path);
      await copyVideoInput(path, identity, snapshot, signal);
      staged.set(path, snapshot);
      return snapshot;
    }

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
) {
  const graphics = openGraphicsRenderer();
  const cache = pictureCacheDirectory
    ? graphicsFrameCache(pictureCacheDirectory)
    : undefined;
  const frame: RenderGraphic = async (clip, timelineFrame, signal) => {
    const { graphic, path, clipId, retiming } = clip;
    const bundle = video.graphicSource(graphic.bundleKey);
    if (!bundle)
      throw new MediaError(`No compiled graphic source for '${path}'.`);
    const { durationFrames } = graphic;
    const sample =
      durationFrames === undefined
        ? 0
        : retiming
          ? sampleClipSourceFrame(retiming, timelineFrame, frameRate)
          : clip.sourceStartFrame + timelineFrame - clip.timelineStartFrame;
    if (
      durationFrames !== undefined &&
      (sample < 0 || sample >= durationFrames)
    )
      throw new MediaError(
        `Clip '${clipId}' sampled outside its graphics source.`,
      );

    try {
      const rasterize = () =>
        graphics.frame(bundle, graphic, sample, frameRate, signal);
      return await (cache
        ? cache(graphic.key, sample, rasterize, signal)
        : rasterize());
    } catch (cause) {
      signal?.throwIfAborted();
      throw new MediaError(
        `Clip '${clipId}' graphic '${path}', source frame ${sample}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
          path: resolveSource(clip.assetId).path,
        })),
      })),
    }),
  };
}
