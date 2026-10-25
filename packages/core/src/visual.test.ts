import { describe, expect, it } from 'vitest';
import {
  addClip,
  createProject,
  deserializeProject,
  executeTransaction,
  frameTime,
  planProjectRender,
  redoEdit,
  serializeProject,
  setCanvas,
  setClipVisual,
  splitClip,
  undoEdit,
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
  return addClip(project, {
    id: 'clip',
    assetId: 'asset',
    trackId: 'bottom',
    timelineStart: frameTime(0, project.settings.frameRate),
    sourceIn: frameTime(0, project.settings.frameRate),
    sourceOut: frameTime(30, project.settings.frameRate),
  }).project;
}

describe('T12 visual model and headless editing', () => {
  it('preserves old files without inserting visual or canvas defaults', () => {
    const project = example();
    expect(deserializeProject(serializeProject(project))).toEqual(project);
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
  it('merges properties, keeps omission unchanged, copies transforms on split and rejects visual audio clips', () => {
    const project = example();
    const changed = setClipVisual(project, 'clip', {
      x: -40.5,
      y: 12,
      scale: 0.5,
      opacity: 0.25,
      fit: 'cover',
    }).project;
    const merged = setClipVisual(changed, 'clip', {
      x: 0,
      opacity: undefined,
    }).project;
    expect(merged.clips[0]!.visual).toEqual({
      x: 0,
      y: 12,
      scale: 0.5,
      opacity: 0.25,
      fit: 'cover',
    });
    expect(project.clips[0]).not.toHaveProperty('visual');
    expect(setClipVisual(merged, 'clip', { x: 0 }).project).toEqual(merged);
    const split = splitClip(
      merged,
      'clip',
      frameTime(10, merged.settings.frameRate),
      'right',
    );
    expect(split.left.visual).toEqual(split.right.visual);
    expect(() => setClipVisual(project, 'missing', { x: 2 })).toThrow(
      /does not exist/,
    );
    expect(() => setClipVisual(project, 'clip', {})).toThrow(/at least one/);
    changed.clips[0]!.trackId = 'audio';
    expect(validateProject(changed).success).toBe(false);
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
  it('commits atomic canvas/visual changes with exact undo/redo and rejects invalid batches', () => {
    const original = example();
    const edited = executeTransaction(original, {
      expectedRevision: 0,
      operations: [
        {
          type: 'canvas.set',
          width: 1080,
          height: 1920,
          backgroundColor: '#123aBC',
        },
        { type: 'clip.visual', id: 'clip', x: 10, opacity: 0.5 },
        {
          type: 'clip.add',
          id: 'overlay',
          assetId: 'asset',
          trackId: 'top',
          at: 5,
          in: 0,
          out: 10,
          visual: { scale: 0.5, fit: 'stretch' },
        },
      ],
    }).project;
    expect(edited.editing!.undo).toHaveLength(1);
    const plan = planProjectRender(edited);
    expect(plan.visualClips.map((clip) => clip.clipId)).toEqual([
      'clip',
      'overlay',
    ]);
    expect(plan.audioClips.map((clip) => clip.clipId)).toEqual([
      'clip',
      'overlay',
    ]);
    expect(plan.frameCount).toBe(30);
    expect(undoEdit(edited).clips).toEqual(original.clips);
    expect(redoEdit(undoEdit(edited)).clips).toEqual(edited.clips);
    expect(redoEdit(undoEdit(edited)).settings).toEqual(edited.settings);
    expect(
      executeTransaction(edited, {
        expectedRevision: 1,
        operations: [{ type: 'clip.visual', id: 'clip', x: 10 }],
      }).project,
    ).toEqual(edited);
    expect(() =>
      executeTransaction(original, {
        expectedRevision: 0,
        operations: [
          { type: 'canvas.set', width: 100 },
          { type: 'clip.visual', id: 'clip' },
        ],
      }),
    ).toThrow(/at least one/);
    expect(original.settings.width).toBe(1920);
    expect(() => setCanvas(original, { backgroundColor: 'red' })).toThrow();
    expect(() => setCanvas(original, {})).toThrow(/at least one/);
  });
  it('supports portrait UHD and guards scaled rectangles and output pixel budget', () => {
    let project = setCanvas(example(), { width: 2160, height: 3840 }).project;
    expect(planProjectRender(project).height).toBe(3840);
    project = setClipVisual(project, 'clip', { scale: 4 }).project;
    expect(() => planProjectRender(project)).toThrow(/8192/);
    project = setCanvas(example(), { width: 3840, height: 3840 }).project;
    expect(() => planProjectRender(project)).toThrow(/even dimensions/);
  });
});
