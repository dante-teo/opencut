import { describe, expect, it } from 'vitest';
import {
  addClip,
  evaluateTimeline,
  evaluateTimelineFrame,
  planProjectRender,
  setTrackAudio,
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

describe('T35 audio envelope', () => {
  const faded = () =>
    setClipAudio(example(), 'c', {
      volume: 0.5,
      fadeIn: at(10),
      fadeOut: at(8),
    }).project;
  const gain = (project: ReturnType<typeof example>, frame: number) =>
    evaluateTimelineFrame(project, frame).audioClips[0]?.effectiveVolume;

  it('applies linear amplitude at exact clip offsets, combines track and clip gain, and honors either mute', () => {
    const mixed = setTrackAudio(faded(), 'v', { volume: 0.4 }).project;
    for (const [frame, expected] of [
      [3, 0],
      [8, 0.1],
      [13, 0.2],
      [25, 0.2],
      [29, 0.1],
      [32, 0.025],
    ] as const)
      expect(gain(mixed, frame)).toBeCloseTo(expected, 12);
    expect(gain(mixed, 33)).toBeUndefined();
    expect(evaluateTimelineFrame(mixed, 8).audioClips[0]?.sourceTime).toEqual(
      at(11),
    );
    expect(planProjectRender(mixed).audioClips[0]).toMatchObject({
      volume: 0.2,
      muted: false,
      fadeIn: { duration: at(10), from: 0, to: 1 },
      fadeOut: { duration: at(8), from: 1, to: 0 },
    });
    expect(gain(setTrackAudio(mixed, 'v', { muted: true }).project, 15)).toBe(
      0,
    );
    expect(gain(setClipAudio(mixed, 'c', { muted: true }).project, 15)).toBe(0);
    expect(gain(setTrackAudio(mixed, 'v', { volume: 0 }).project, 15)).toBe(0);
  });

  it.each([5, 11, 13, 20, 25, 28, 32])(
    'preserves the envelope when split at frame %i',
    (frame) => {
      const before = faded();
      const split = splitClip(before, 'c', at(frame), 'right');
      const after = deserializeProject(serializeProject(split.project));
      for (let sample = 3; sample < 33; sample++)
        expect(gain(after, sample)).toBeCloseTo(gain(before, sample)!, 12);
    },
  );

  it('rejects overlapping fades, clears zero durations, and shortens fades on trims', () => {
    const project = faded();
    expect(() => setClipAudio(project, 'c', { fadeIn: at(23) })).toThrow(
      /without overlapping/,
    );
    expect(() => setClipAudio(project, 'c', { fadeOut: at(31) })).toThrow(
      /without overlapping/,
    );
    const trimmed = trimClip(project, 'c', { sourceIn: at(24) }).clip;
    expect(trimmed.fadeIn?.duration).toEqual(at(4));
    expect(trimmed.fadeOut?.duration).toEqual(at(8));
    const trimmedEnd = trimClip(project, 'c', { sourceOut: at(18) }).clip;
    expect(trimmedEnd.fadeIn?.duration).toEqual(at(10));
    expect(trimmedEnd.fadeOut?.duration).toEqual(at(2));
    expect(
      setClipAudio(project, 'c', { fadeIn: at(0) }).clip.fadeIn,
    ).toBeUndefined();
    expect(setClipAudio(project, 'c', { fadeIn: at(10) }).project).toEqual(
      project,
    );
  });

  it('evaluates a subframe release whose remaining time cannot be stored as a rational', () => {
    const project = example();
    project.clips[0]!.timelineStart = at(0);
    project.clips[0]!.sourceIn = at(0);
    project.clips[0]!.sourceOut = at(30);
    const d = Number.MAX_SAFE_INTEGER - 110;
    const faded = setClipAudio(project, 'c', {
      fadeOut: { numerator: 1, denominator: d },
    }).project;
    const t = { numerator: d + 1, denominator: d + 2 };
    expect(
      evaluateTimeline(faded, t).audioClips[0]!.effectiveVolume,
    ).toBeCloseTo(d / (d + 2), 15);
  });

  it('round-trips track and clip settings in a single undoable transaction', () => {
    const project = example();
    const next = executeTransaction(project, {
      expectedRevision: 0,
      operations: [
        { type: 'track.audio', id: 'v', volume: 0.7, muted: true },
        { type: 'clip.audio', id: 'c', fadeIn: 15, fadeOut: 15 },
      ],
    }).project;
    const loaded = deserializeProject(serializeProject(next));
    const undone = undoEdit(loaded);
    expect(undone.tracks).toEqual(project.tracks);
    expect(undone.clips).toEqual(project.clips);
    const redone = redoEdit(undone);
    expect(redone.tracks).toEqual(next.tracks);
    expect(redone.clips).toEqual(next.clips);
  });
});
