import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { VideoTimelineOptions, VisualTimelineClip } from '@opencut/media';
import type { ProjectRenderPlan } from './render-plan.js';
import type { CompiledVideo } from './video-compiler.js';
import { copyVideoInput } from './video-input.js';

type CompiledRenderPlan = Awaited<ReturnType<CompiledVideo['resolveRender']>> &
  Pick<VideoTimelineOptions, 'snapshotSource'>;

/** Keep decoded sources stable for the lifetime of a render or preview. */
export async function withRenderSources<T>(
  video: CompiledVideo,
  signal: AbortSignal | undefined,
  render: (plan: CompiledRenderPlan) => Promise<T>,
) {
  const plan = await video.resolveRender();
  const staged = new Map<string, string>();
  let directory: string | undefined;
  try {
    return await render({
      ...plan,
      async snapshotSource(path) {
        const existing = staged.get(path);
        if (existing) return existing;
        const identity = video.sourceIdentity(path);
        if (!identity)
          throw new Error(`No compiled source identity for '${path}'.`);
        directory ??= await mkdtemp(join(tmpdir(), 'opencut-render-sources-'));
        const snapshot = join(directory, `${staged.size}${extname(path)}`);
        await copyVideoInput(path, identity, snapshot, signal);
        staged.set(path, snapshot);
        return snapshot;
      },
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Bind a planned timeline to the original files selected by its caller. */
export function bindRenderSources(
  {
    visualClips,
    audioClips,
    visualTransitions,
    ...settings
  }: ProjectRenderPlan,
  resolveSource: (assetId: string) => string,
) {
  return {
    ...settings,
    visualClips: visualClips.map<VisualTimelineClip>((clip) =>
      clip.text ? clip : { ...clip, path: resolveSource(clip.assetId) },
    ),
    audioClips: audioClips.map((clip) => ({
      ...clip,
      path: resolveSource(clip.assetId),
    })),
    ...(visualTransitions?.length && {
      visualTransitions: visualTransitions.map(({ afterClipId, layers }) => ({
        afterClipId,
        layers: layers.map((clip) => ({
          ...clip,
          path: resolveSource(clip.assetId),
        })),
      })),
    }),
  };
}
