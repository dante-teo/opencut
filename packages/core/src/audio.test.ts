import { describe, expect, it } from 'vitest';
import {
  addClip,
  createProject,
  deserializeProject,
  executeTransaction,
  frameTime,
  redoEdit,
  serializeProject,
  setClipAudio,
  splitClip,
  trimClip,
  undoEdit,
} from './index.js';

const rate = { numerator: 30, denominator: 1 };
const at = (n: number) => frameTime(n, rate);
function example() {
  const project = createProject({ name: 'Audio' });
  project.assets = [
    {
      id: 'av',
      name: 'AV',
      mediaTypes: ['video', 'audio'],
      file: { type: 'relative', path: 'offline.mp4' },
    },
  ];
  project.tracks = [{ id: 'v', name: 'Video', type: 'video' }];
  return addClip(project, {
    id: 'c',
    assetId: 'av',
    trackId: 'v',
    timelineStart: at(3),
    sourceIn: at(6),
    sourceOut: at(36),
  }).project;
}

describe('clip audio properties', () => {
  it('keeps legacy clips unchanged and round trips explicit gains and mute', () => {
    const original = example();
    expect(
      deserializeProject(serializeProject(original)).clips[0],
    ).not.toHaveProperty('volume');
    const next = setClipAudio(original, 'c', {
      volume: 0.25,
      muted: true,
    }).project;
    expect(original.clips[0]).not.toHaveProperty('muted');
    expect(deserializeProject(serializeProject(next)).clips[0]).toMatchObject({
      volume: 0.25,
      muted: true,
    });
    const trimmed = trimClip(next, 'c', { sourceIn: at(9) }).project;
    const split = splitClip(trimmed, 'c', at(9), 'right');
    for (const clip of [split.left, split.right])
      expect(clip).toMatchObject({ volume: 0.25, muted: true });
    expect(setClipAudio(next, 'c', { muted: false }).clip.volume).toBe(0.25);
    expect(
      setClipAudio(next, 'c', { volume: 0.25, muted: true }).project,
    ).toEqual(next);
  });

  it.each([-1, 1.01, NaN, Infinity])(
    'rejects invalid volume %s without changing input',
    (volume) => {
      const project = example();
      const before = serializeProject(project);
      expect(() => setClipAudio(project, 'c', { volume })).toThrow();
      expect(serializeProject(project)).toBe(before);
    },
  );

  it('supports audio in atomic transactions and persistent undo/redo', () => {
    const project = example();
    const next = executeTransaction(project, {
      expectedRevision: 0,
      operations: [
        { type: 'clip.audio', id: 'c', volume: 0.5, muted: true },
        { type: 'clip.split', id: 'c', at: 12, rightId: 'right' },
      ],
    }).project;
    expect(next.clips.every((clip) => clip.volume === 0.5 && clip.muted)).toBe(
      true,
    );
    const restored = deserializeProject(serializeProject(next));
    const undone = undoEdit(restored);
    expect(undone.clips).toEqual(project.clips);
    expect(redoEdit(undone).clips).toEqual(next.clips);
    expect(
      executeTransaction(restored, {
        expectedRevision: 1,
        operations: [{ type: 'clip.audio', id: 'c', volume: 0.5 }],
      }).project,
    ).toEqual(restored);
    expect(() =>
      executeTransaction(project, {
        expectedRevision: 0,
        operations: [
          { type: 'clip.audio', id: 'c', volume: 0.5 },
          { type: 'clip.audio', id: 'missing', muted: true },
        ],
      }),
    ).toThrow(/does not exist/);
    expect(project.clips[0]).not.toHaveProperty('volume');
    expect(() => setClipAudio(project, 'c', {})).toThrow(/Specify/);
  });
});
