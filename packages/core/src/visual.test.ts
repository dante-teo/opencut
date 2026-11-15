import { describe, expect, it } from 'vitest';
import {
  createProject,
  frameTime,
  planProjectRender,
  validateProject,
} from './index.js';

function example() {
  const project = createProject({ name: 'Visual edits' });
  project.assets = [
    {
      id: 'asset',
      name: 'Offline video',
      file: { type: 'relative' as const, path: 'video.mp4' },
      mediaTypes: ['video' as const, 'audio' as const],
    },
  ];
  project.tracks = [
    { id: 'bottom', name: 'Bottom', type: 'video' as const },
    { id: 'top', name: 'Top', type: 'video' as const },
    { id: 'audio', name: 'Audio', type: 'audio' as const },
  ];
  project.clips.push({
    id: 'clip',
    assetId: 'asset',
    trackId: 'bottom',
    timelineStart: frameTime(0, project.settings.frameRate),
    sourceIn: frameTime(0, project.settings.frameRate),
    sourceOut: frameTime(30, project.settings.frameRate),
  });
  return project;
}

describe('visual snapshot validation', () => {
  it('applies render defaults without changing the snapshot', () => {
    const project = example();
    expect(project.clips[0]).not.toHaveProperty('visual');
    expect(project.settings).not.toHaveProperty('backgroundColor');
    expect(planProjectRender(project).visualClips[0]).toMatchObject({
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
      fit: 'contain',
    });
    expect(planProjectRender(project).backgroundColor).toBe('#000000');
  });
  it('preserves transparent canvas colors in render plans', () => {
    for (const backgroundColor of ['transparent', '#18304880']) {
      const project = example();
      project.settings.backgroundColor = backgroundColor;
      expect(planProjectRender(project).backgroundColor).toBe(backgroundColor);
    }
  });
  it.each([
    { x: Infinity },
    { x: -32769 },
    { y: 32769 },
    { scale: 0 },
    { scale: 4.1 },
    { opacity: -0.1 },
    { opacity: 1.1 },
    { fit: 'invalid' },
  ])('rejects invalid visual settings %j', (visual) => {
    const project = example();
    Object.assign(project.clips[0]!, { visual });
    expect(validateProject(project).success).toBe(false);
  });
  it('supports portrait UHD and guards scaled rectangles and output pixel budget', () => {
    const project = example();
    Object.assign(project.settings, { width: 2160, height: 3840 });
    expect(planProjectRender(project).height).toBe(3840);
    project.clips[0]!.visual = { scale: 4 };
    expect(() => planProjectRender(project)).toThrow(/8192/);
    project.settings.width = 3840;
    expect(() => planProjectRender(project)).toThrow(/even dimensions/);
  });
});
