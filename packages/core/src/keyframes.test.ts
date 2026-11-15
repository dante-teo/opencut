import { describe, expect, it } from 'vitest';
import {
  createProject,
  createTimelineEvaluator,
  evaluateTimeline,
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
  const project = fixture();
  project.clips[0]!.keyframes = {
    x: [
      { time: seconds(1), value: 0, easing },
      { time: seconds(3), value: 80, easing: 'linear' },
    ],
  };
  return project;
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

  it('returns frame samples with detached keys', () => {
    const evaluate = createTimelineEvaluator(animate('ease-in'), true);
    const at = seconds(401, 100);
    const clip = evaluate(at).visualClips[0]!;
    expect(clip.visual.x).toBe(20);
    clip.keyframes!.x![0]!.value = 999;
    expect(evaluate(at).visualClips[0]?.keyframes?.x?.[0]?.value).toBe(0);
  });

  it('samples narrowed easing at finite precision near a flat endpoint', () => {
    const project = animate('ease-out');
    project.clips[0]!.keyframes!.x![0]!.curve = [1 - Number.EPSILON / 2, 1];
    expect(evaluateTimeline(project, seconds(4)).visualClips[0]?.visual.x).toBe(
      60,
    );
  });

  it('rejects duplicate keys, invalid property values, and animation on audio tracks', () => {
    const duplicate = animate('linear');
    duplicate.clips[0]!.keyframes!.x![1]!.time = seconds(2, 2);
    expect(validateProject(duplicate).success).toBe(false);
    const scale = animate('linear');
    scale.clips[0]!.keyframes!.scale = [
      { time: seconds(1), value: 0, easing: 'linear' },
    ];
    expect(validateProject(scale).success).toBe(false);
    const audio = animate('linear');
    audio.clips[0]!.trackId = 'audio';
    expect(validateProject(audio).success).toBe(false);
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
});
