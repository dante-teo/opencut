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
  const segments = [];
  const checked = new Set<string>();
  for (const segment of plan.segments) {
    if (segment.kind === 'gap') {
      segments.push(segment);
      continue;
    }
    const asset = assets.get(segment.assetId)!;
    const sourcePath = resolveMediaReference(asset.file, path);
    // Foreign-platform absolute references must never become cwd-relative inputs.
    if (!checked.has(sourcePath)) {
      const source = await inspectMediaFile(sourcePath);
      if (source.status === 'unsupported_path')
        throw new RenderError(
          `Clip '${segment.clipId}': ${source.message} Relink the source for this operating system before rendering.`,
        );
      checked.add(sourcePath);
    }
    segments.push({ ...segment, path: sourcePath });
  }
  return {
    projectPath: path,
    ...(await renderVideoTimeline({ ...plan, segments, output })),
  };
}
