import { clipSourceTime, planProjectRender } from '@opencut/core';
import type { Project, RationalTime, TimelineClip } from '@opencut/core';
import { renderVideoTimeline } from '../../packages/media/src/index.js';
import type { RenderControls } from '../../packages/media/src/index.js';
import { bindRenderSources } from '../../packages/core/src/render-sources.js';
import { dirname, resolve } from 'node:path';

/** Reference renderer for authored timeline snapshots used in native tests. */
export async function renderFixture(
  project: Project,
  location: string,
  output: string,
  controls?: RenderControls,
) {
  const paths = new Map(
    project.assets.map(({ id, file }) => [
      id,
      resolve(dirname(location), file.path),
    ]),
  );
  return renderVideoTimeline({
    ...bindRenderSources(planProjectRender(project), (assetId) => ({
      path: paths.get(assetId)!,
    })),
    ...controls,
    output,
  });
}

export function addFixtureClip(project: Project, clip: TimelineClip) {
  project.clips.push(clip);
  return project;
}

/** Describe two contiguous intervals for sample and timestamp comparisons. */
export function splitFixtureClip(
  project: Project,
  id: string,
  at: RationalTime,
  rightId: string,
) {
  const left = project.clips.find((clip) => clip.id === id)!;
  const sourceIn = clipSourceTime(left, at);
  project.clips.push({ ...left, id: rightId, timelineStart: at, sourceIn });
  left.sourceOut = sourceIn;
  return project;
}
