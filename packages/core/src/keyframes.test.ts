import { describe, expect, it } from 'vitest';
import {
  createProject,
  createPlaybackTimelineEvaluator,
  createTimelineEvaluator,
  deserializeProject,
  editClipKeyframe,
  evaluateTimeline,
  executeTransaction,
  moveClip,
  redoEdit,
  serializeProject,
  setClipSpeed,
  splitClip,
  trimClip,
  undoEdit,
  validateProject,
  type KeyframeEasing,
} from './index.js';

const seconds = (numerator: number, denominator = 1) => ({
  numerator,
  denominator,
});
function fixture() {
  const project = createProject({ name: 'Keyframes' });
  project.assets = [
    {
      id: 'asset',
      name: 'Offline',
      file: { type: 'relative', path: 'source.mp4' },
      mediaTypes: ['video', 'audio'],
    },
  ];
  project.tracks = [
    { id: 'video', name: 'Video', type: 'video' },
    { id: 'audio', name: 'Audio', type: 'audio' },
  ];
  project.clips = [
    {
      id: 'clip',
      assetId: 'asset',
      trackId: 'video',
      timelineStart: seconds(2),
      sourceIn: seconds(4),
      sourceOut: seconds(8),
      visual: { x: -12, opacity: 0.75 },
    },
  ];
  return project;
}

function animate(easing: KeyframeEasing) {
  return executeTransaction(fixture(), {
    expectedRevision: 0,
    operations: [
      {
        type: 'clip.keyframe.add',
        id: 'clip',
        property: 'x',
        time: seconds(1),
        value: 0,
        easing,
      },
      {
        type: 'clip.keyframe.add',
        id: 'clip',
        property: 'x',
        time: seconds(3),
        value: 80,
      },
    ],
  }).project;
}

describe('clip-local keyframes', () => {
  it.each([
    ['linear', 20, 60],
    ['ease-in', 5, 45],
    ['ease-out', 35, 75],
    ['ease-in-out', 10, 70],
  ] as const)(
    'samples %s, holds edges, and preserves half-open clip visibility',
    (easing, first, last) => {
      const project = animate(easing);
      const sample = (n: number, d = 1) =>
        evaluateTimeline(project, seconds(n, d)).visualClips[0]?.visual;
      expect(sample(2)).toMatchObject({ x: 0, opacity: 0.75 });
      expect(sample(7, 2)?.x).toBe(first);
      expect(sample(9, 2)?.x).toBe(last);
      expect(sample(5)?.x).toBe(80);
      expect(sample(11, 2)?.x).toBe(80);
      expect(sample(6)).toBeUndefined();
    },
  );

  it('shares frame sampling with playback while retaining detached public keys', () => {
    const project = animate('ease-in');
    const evaluate = createTimelineEvaluator(project, true);
    const playback = createPlaybackTimelineEvaluator(project);
    const at = seconds(401, 100);
    const publicClip = evaluate(at).visualClips[0]!;
    expect(playback(at).visualClips[0]).toMatchObject({
      animated: true,
      visual: publicClip.visual,
      sourceTime: publicClip.sourceTime,
    });
    expect(playback(at).visualClips[0]).not.toHaveProperty('keyframes');
    publicClip.keyframes!.x![0]!.value = 999;
    expect(evaluate(at).visualClips[0]?.keyframes?.x?.[0]?.value).toBe(0);
    expect(playback(at).visualClips[0]?.visual.x).toBe(20);
  });

  it('samples narrowed easing at finite precision near a flat endpoint', () => {
    const project = animate('ease-out');
    project.clips[0]!.keyframes!.x![0]!.curve = [1 - Number.EPSILON / 2, 1];
    expect(evaluateTimeline(project, seconds(4)).visualClips[0]?.visual.x).toBe(
      60,
    );
  });

  it('edits, moves and deletes channels atomically through persistent history', () => {
    const original = animate('ease-in');
    const project = executeTransaction(original, {
      expectedRevision: 1,
      operations: [
        {
          type: 'clip.keyframe.set',
          id: 'clip',
          property: 'x',
          time: seconds(2, 2),
          newTime: seconds(0),
          value: -24,
          easing: 'ease-out',
        },
        {
          type: 'clip.keyframe.remove',
          id: 'clip',
          property: 'x',
          time: seconds(3),
        },
        {
          type: 'clip.keyframe.add',
          id: 'clip',
          property: 'rotation',
          time: seconds(4),
          value: 720,
        },
        {
          type: 'clip.keyframe.add',
          id: 'clip',
          property: 'opacity',
          time: seconds(0),
          value: 0,
        },
      ],
    }).project;
    const saved = deserializeProject(serializeProject(project));
    expect(saved.clips[0]?.keyframes).toEqual({
      x: [{ time: seconds(0), value: -24, easing: 'ease-out' }],
      rotation: [{ time: seconds(4), value: 720, easing: 'linear' }],
      opacity: [{ time: seconds(0), value: 0, easing: 'linear' }],
    });
    const evaluation = evaluateTimeline(saved, seconds(3));
    expect(evaluation.visualClips[0]).toMatchObject({
      visible: false,
      visual: { x: -24, opacity: 0, rotation: 720 },
    });
    expect(undoEdit(saved).clips).toEqual(original.clips);
    expect(redoEdit(undoEdit(saved)).clips).toEqual(saved.clips);
    const removed = editClipKeyframe(saved, 'clip', {
      type: 'clip.keyframe.remove',
      property: 'x',
      time: seconds(0),
    }).project;
    expect(evaluateTimeline(removed, seconds(3)).visualClips[0]?.visual.x).toBe(
      -12,
    );
    expect(() =>
      executeTransaction(original, {
        expectedRevision: 1,
        operations: [
          {
            type: 'clip.keyframe.remove',
            id: 'clip',
            property: 'x',
            time: seconds(1),
          },
          {
            type: 'clip.keyframe.add',
            id: 'clip',
            property: 'x',
            time: seconds(41, 10),
            value: 3,
          },
        ],
      }),
    ).toThrow(/duration/);
    expect(original.clips[0]?.keyframes?.x).toHaveLength(2);
  });

  it('rejects duplicates, invalid property values, and animation on audio tracks', () => {
    const original = animate('linear');
    expect(() =>
      editClipKeyframe(original, 'clip', {
        type: 'clip.keyframe.add',
        property: 'x',
        time: seconds(2, 2),
        value: 9,
      }),
    ).toThrow(/already exists/);
    expect(() =>
      editClipKeyframe(original, 'clip', {
        type: 'clip.keyframe.set',
        property: 'x',
        time: seconds(1),
        newTime: seconds(6, 2),
      }),
    ).toThrow(/strictly increasing/);
    expect(() =>
      editClipKeyframe(original, 'clip', {
        type: 'clip.keyframe.add',
        property: 'scale',
        time: seconds(1),
        value: 0,
      }),
    ).toThrow();
    original.clips[0]!.trackId = 'audio';
    expect(validateProject(original).success).toBe(false);
  });

  it('reports a malformed saved time at the keyframe path', () => {
    const project = animate('linear');
    project.clips[0]!.keyframes!.x![0]!.time.denominator = 0;
    expect(validateProject(project)).toMatchObject({
      success: false,
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: '/clips/0/keyframes/x/0/time/denominator',
          }),
        ]),
      },
    });
  });

  it('samples two synthetic boundaries when a trim stays within one easing segment', () => {
    const original = animate('ease-in');
    const clipped = trimClip(original, 'clip', {
      sourceIn: seconds(11, 2),
      sourceOut: seconds(13, 2),
    }).project;
    expect(clipped.clips[0]?.keyframes?.x).toEqual([
      { time: seconds(0), value: 5, easing: 'ease-in', curve: [0.25, 0.75] },
      { time: seconds(1), value: 45, easing: 'linear' },
    ]);
    expect(
      evaluateTimeline(clipped, seconds(5, 2)).visualClips[0]?.visual.x,
    ).toBe(20);
  });

  it('preserves easing through trim, split, exact fractional retiming and repositioning', () => {
    const original = animate('ease-in-out');
    const trimmed = trimClip(original, 'clip', {
      sourceIn: seconds(21, 4),
      sourceOut: seconds(27, 4),
    }).project;
    const split = splitClip(trimmed, 'clip', seconds(23, 8), 'right').project;
    for (let i = 0; i < 12; i++) {
      expect(
        evaluateTimeline(split, seconds(16 + i, 8)).visualClips[0]?.visual.x,
      ).toBeCloseTo(
        evaluateTimeline(original, seconds(26 + i, 8)).visualClips[0]!.visual.x,
        10,
      );
    }
    const fast = setClipSpeed(original, 'clip', seconds(3, 2)).project;
    expect(fast.clips[0]?.keyframes?.x?.map(({ time }) => time)).toEqual([
      seconds(2, 3),
      seconds(2),
    ]);
    const moved = moveClip(fast, 'clip', { timelineStart: seconds(5) }).project;
    expect(evaluateTimeline(moved, seconds(6)).visualClips[0]?.visual.x).toBe(
      10,
    );
    const extended = trimClip(trimmed, 'clip', {
      sourceIn: seconds(5),
      sourceOut: seconds(7),
    }).project;
    expect(
      evaluateTimeline(extended, seconds(2)).visualClips[0]?.visual.x,
    ).toBeCloseTo(
      evaluateTimeline(trimmed, seconds(2)).visualClips[0]!.visual.x,
    );
    expect(
      evaluateTimeline(extended, seconds(15, 4)).visualClips[0]?.visual.x,
    ).toBeCloseTo(
      evaluateTimeline(original, seconds(19, 4)).visualClips[0]!.visual.x,
    );
  });
});
