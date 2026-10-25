import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RenderControls } from '@opencut/media';
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
  controls: RenderControls = {},
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
  const plan = planProjectRender(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const visualClips = [];
  const checked = new Set<string>();
  const resolveSource = async (clip: { assetId: string; clipId: string }) => {
    const asset = assets.get(clip.assetId)!;
    const sourcePath = resolveMediaReference(asset.file, path);
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
    visualClips.push({ ...clip, path: await resolveSource(clip) });
  const audioClips = [];
  for (const clip of plan.audioClips)
    audioClips.push({ ...clip, path: await resolveSource(clip) });
  return {
    projectPath: path,
    ...(await renderVideoTimeline({
      ...plan,
      ...controls,
      visualClips,
      audioClips,
      output,
    })),
  };
}
