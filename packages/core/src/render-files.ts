import { renderVideoTimeline } from '@opencut/media';
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
) {
  const path = await canonicalProjectFilePath(projectFilePath);
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
      visualClips,
      audioClips,
      output,
    })),
  };
}
