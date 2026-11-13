import type { Project } from './project.js';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RenderControls, VisualTimelineClip } from '@opencut/media';
import { renderVideoTimeline, RenderCancelledError } from '@opencut/media';
import {
  canonicalProjectFilePath,
  readProjectFile,
  inspectMediaFile,
  resolveMediaReference,
} from './project-files.js';
import { planProjectRender, RenderError } from './render-plan.js';

/** Read a single project snapshot; rendering never saves or changes editing history. */
export async function renderProjectFile(
  projectFilePath: string,
  output: string,
  controls: RenderControls & { burnSubtitles?: boolean | undefined } = {},
) {
  if (controls.signal?.aborted) throw new RenderCancelledError();
  const path = await canonicalProjectFilePath(projectFilePath);
  if (controls.overwrite) {
    const destination = await stat(resolve(output)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    });
    const projectStat = await stat(path);
    if (
      destination &&
      destination.dev === projectStat.dev &&
      destination.ino === projectStat.ino
    )
      throw new RenderError('Render output must not replace the project file.');
  }
  const project = await readProjectFile(path);
  const plan = await resolveProjectRender(project, path, controls);
  return {
    projectPath: path,
    ...(await renderVideoTimeline({
      ...plan,
      ...controls,
      output,
    })),
  };
}

/** Resolve original references once, detached from any preview/cache or editor session. */
export async function resolveProjectRender(
  project: Project,
  projectFilePath: string,
  options?: { burnSubtitles?: boolean | undefined },
) {
  const plan = planProjectRender(project, options);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const visualClips: VisualTimelineClip[] = [];
  const checked = new Set<string>();
  const resolveSource = async (clip: { assetId: string; clipId: string }) => {
    const asset = assets.get(clip.assetId)!;
    const sourcePath = resolveMediaReference(asset.file, projectFilePath);
    if (!checked.has(sourcePath)) {
      const source = await inspectMediaFile(sourcePath);
      if (source.status === 'unsupported_path')
        throw new RenderError(
          `Clip '${clip.clipId}': ${source.message} Relink the source for this operating system before rendering.`,
        );
      checked.add(sourcePath);
    }
    return sourcePath;
  };
  for (const clip of plan.visualClips)
    visualClips.push(
      clip.text ? clip : { ...clip, path: await resolveSource(clip) },
    );
  const audioClips = [];
  for (const clip of plan.audioClips)
    audioClips.push({ ...clip, path: await resolveSource(clip) });
  const { visualTransitions: transitions, ...settings } = plan;
  const visualTransitions = [];
  for (const { afterClipId, layers } of transitions ?? []) {
    const resolved = [];
    for (const clip of layers)
      resolved.push({ ...clip, path: await resolveSource(clip) });
    visualTransitions.push({ afterClipId, layers: resolved });
  }
  return {
    ...settings,
    visualClips,
    audioClips,
    ...(visualTransitions.length && { visualTransitions }),
  };
}
