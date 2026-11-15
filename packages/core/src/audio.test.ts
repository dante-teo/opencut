import { describe, expect, it } from 'vitest';
import {
  evaluateTimeline,
  evaluateTimelineFrame,
  planProjectRender,
  createProject,
  frameTime,
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
  project.clips.push({
    id: 'c',
    assetId: 'av',
    trackId: 'v',
    timelineStart: at(3),
    sourceIn: at(6),
    sourceOut: at(36),
  });
  return project;
}

describe('clip audio properties', () => {
  it('applies audio defaults and respects explicit gains and mute', () => {
    const original = example();
    expect(planProjectRender(original).audioClips[0]).toMatchObject({
      volume: 1,
      muted: false,
    });
    Object.assign(original.clips[0]!, { volume: 0.25, muted: true });
    expect(planProjectRender(original).audioClips[0]).toMatchObject({
      volume: 0.25,
      muted: true,
    });
  });

  it.each([-1, 1.01, NaN, Infinity])('rejects invalid volume %s', (volume) => {
    const project = example();
    project.clips[0]!.volume = volume;
    expect(() => planProjectRender(project)).toThrow();
  });
});

describe('T35 audio envelope', () => {
  const faded = () => {
    const project = example();
    Object.assign(project.clips[0]!, {
      volume: 0.5,
      fadeIn: { duration: at(10) },
      fadeOut: { duration: at(8) },
    });
    return project;
  };
  const gain = (project: ReturnType<typeof example>, frame: number) =>
    evaluateTimelineFrame(project, frame).audioClips[0]?.effectiveVolume;

  it('applies linear amplitude at exact clip offsets, combines track and clip gain, and honors either mute', () => {
    const mixed = faded();
    mixed.tracks[0]!.volume = 0.4;
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
    mixed.tracks[0]!.muted = true;
    expect(gain(mixed, 15)).toBe(0);
    mixed.tracks[0]!.muted = false;
    mixed.clips[0]!.muted = true;
    expect(gain(mixed, 15)).toBe(0);
  });

  it('rejects overlapping fades', () => {
    const project = faded();
    project.clips[0]!.fadeIn = { duration: at(23) };
    expect(() => planProjectRender(project)).toThrow(/without overlapping/);
  });

  it('evaluates a subframe release whose remaining time cannot be stored as a rational', () => {
    const project = example();
    project.clips[0]!.timelineStart = at(0);
    project.clips[0]!.sourceIn = at(0);
    project.clips[0]!.sourceOut = at(30);
    const d = Number.MAX_SAFE_INTEGER - 110;
    project.clips[0]!.fadeOut = { duration: { numerator: 1, denominator: d } };
    const t = { numerator: d + 1, denominator: d + 2 };
    expect(
      evaluateTimeline(project, t).audioClips[0]!.effectiveVolume,
    ).toBeCloseTo(d / (d + 2), 15);
  });
});
