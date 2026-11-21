import { describe, expect, it } from 'vitest';
import { createProject, frameTime } from './index.js';
import { planProjectRender } from './render-plan.js';
import type { Project } from './project.js';

function example(): Project {
  const project = createProject({
    name: 'Render',
    settings: {
      width: 320,
      height: 180,
      frameRate: { numerator: 30000, denominator: 1001 },
    },
  });
  project.assets = [
    {
      id: 'source',
      name: 'Video',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'source.mp4' },
    },
  ];
  project.tracks = [{ id: 'video', name: 'Video', type: 'video' }];
  return project;
}
const at = (n: number) => frameTime(n, { numerator: 30000, denominator: 1001 });
function clip(
  project: Project,
  id: string,
  start: number,
  sourceIn: number,
  sourceOut: number,
) {
  project.clips.push({
    id,
    assetId: 'source',
    trackId: 'video',
    timelineStart: at(start),
    sourceIn: at(sourceIn),
    sourceOut: at(sourceOut),
  });
  return project;
}

describe('pure project render planning', () => {
  it('sorts adjacent clips, inserts leading/interior gaps and preserves the input', () => {
    const project = clip(example(), 'a', 3, 6, 16);
    clip(project, 'b', 13, 16, 30);
    clip(project, 'c', 30, 0, 2);
    project.clips.reverse();
    const before = structuredClone(project);
    expect(planProjectRender(project)).toMatchObject({
      width: 320,
      height: 180,
      frameRate: project.settings.frameRate,
      frameCount: 32,
      visualClips: [
        {
          clipId: 'a',
          assetId: 'source',
          timelineStartFrame: 3,
          sourceStartFrame: 6,
          frameCount: 10,
          x: 0,
          y: 0,
          scale: 1,
          opacity: 1,
          fit: 'contain',
        },
        {
          clipId: 'b',
          timelineStartFrame: 13,
          sourceStartFrame: 16,
          frameCount: 14,
        },
        {
          clipId: 'c',
          timelineStartFrame: 30,
          sourceStartFrame: 0,
          frameCount: 2,
        },
      ],
    });
    expect(project).toEqual(before);
  });

  it('preserves 64 one-frame boundaries exactly at fractional rates', () => {
    let project = example();
    for (let i = 0; i < 64; i++) project = clip(project, `c${i}`, i, i, i + 1);
    expect(planProjectRender(project).frameCount).toBe(64);
    expect(
      planProjectRender(project).visualClips.every((s) => s.frameCount === 1),
    ).toBe(true);
  });

  it.each([
    ['timelineStart', 1, 30, -1_000_000],
    ['sourceIn', 0, 30, 1_000_000],
    ['sourceOut', 0, 15, 0],
  ] as const)(
    'samples subframe %s at default speed',
    (field, timelineStartFrame, frameCount, sourceOriginNs) => {
      const project = clip(example(), 'a', 0, 0, 30);
      project.clips[0]![field] = {
        numerator: 1,
        denominator: field === 'sourceOut' ? 2 : 1000,
      };
      const plan = planProjectRender(project);
      expect(plan.frameCount).toBe(timelineStartFrame + frameCount);
      expect(plan.visualClips[0]).toMatchObject({
        timelineStartFrame,
        frameCount,
        retiming: { speed: { numerator: 1, denominator: 1 }, sourceOriginNs },
      });
      expect(plan.audioClips[0]?.retiming?.[field]).toEqual(
        project.clips[0]![field],
      );
    },
  );

  it('shares a tempo run only when adjacent media pieces keep the same mapping', () => {
    const split = clip(example(), 'a', 0, 15, 17);
    clip(split, 'b', 8, 17, 45);
    for (const piece of split.clips)
      piece.speed = { numerator: 1, denominator: 4 };
    split.clips[1]!.muted = true;
    const plan = planProjectRender(split);
    expect(plan.audioClips.map(({ tempoRunId }) => tempoRunId)).toEqual([
      'a',
      'a',
    ]);
    expect(
      plan.visualClips.map(({ retiming }) => retiming?.sourceOriginNs),
    ).toEqual([500_500_000, 500_500_000]);
    split.clips[1]!.timelineStart = at(9);
    expect(
      planProjectRender(split).audioClips.map(({ tempoRunId }) => tempoRunId),
    ).toEqual(['a', 'b']);
  });

  it('allows multiple and empty video/audio tracks, requiring at least one visual clip', () => {
    const project = clip(example(), 'a', 0, 0, 30);
    project.tracks.push(
      { id: 'extra', name: 'Extra', type: 'video' },
      { id: 'audio', name: 'Audio', type: 'audio' },
    );
    expect(planProjectRender(project).visualClips).toHaveLength(1);
    expect(planProjectRender(project).frameCount).toBe(30);
    project.tracks[0]!.type = 'audio';
    project.assets[0]!.mediaTypes = ['audio'];
    expect(() => planProjectRender(project)).toThrow(/empty/);
  });

  it('plans overlapping audio and extends black video to the longest audio end', () => {
    const project = clip(example(), 'video-clip', 0, 0, 3);
    project.tracks.unshift({ id: 'music', name: 'Music', type: 'audio' });
    project.assets[0]!.mediaTypes.push('audio');
    project.clips.push({
      id: 'sound',
      assetId: 'source',
      trackId: 'music',
      timelineStart: at(2),
      sourceIn: at(5),
      sourceOut: at(10),
      volume: 0.25,
      muted: true,
    });
    const plan = planProjectRender(project);
    expect(plan.frameCount).toBe(7);
    expect(plan.visualClips[0]).toMatchObject({
      timelineStartFrame: 0,
      frameCount: 3,
    });
    expect(plan.audioClips).toEqual([
      {
        clipId: 'sound',
        assetId: 'source',
        timelineStartFrame: 2,
        sourceStartFrame: 5,
        frameCount: 5,
        volume: 0.25,
        muted: true,
        required: true,
      },
      {
        clipId: 'video-clip',
        assetId: 'source',
        timelineStartFrame: 0,
        sourceStartFrame: 0,
        frameCount: 3,
        volume: 1,
        muted: false,
        required: false,
      },
    ]);
    project.clips[1]!.sourceIn = { numerator: 1, denominator: 1000 };
    expect(
      planProjectRender(project).audioClips[0]?.retiming?.sourceIn,
    ).toEqual(project.clips[1]!.sourceIn);
  });

  it('validates the project before compiling it', () => {
    const project = clip(clip(example(), 'a', 0, 0, 30), 'b', 30, 0, 30);
    project.clips[1]!.timelineStart = at(29);
    expect(() => planProjectRender(project)).toThrow(/overlaps/);
    project.clips[1]!.assetId = 'missing';
    expect(() => planProjectRender(project)).toThrow(/does not exist/);
  });

  it.each([
    { width: 321 },
    { height: 1 },
    { width: 3842 },
    { frameRate: { numerator: 121, denominator: 1 } },
    { frameRate: { numerator: 1, denominator: 2 } },
    { frameRate: { numerator: 2147483648, denominator: 2147483647 } },
  ])('rejects unsupported settings %j', (settings) => {
    const project = clip(example(), 'a', 0, 0, 30);
    Object.assign(project.settings, settings);
    expect(() => planProjectRender(project)).toThrow(/dimensions|frame rate/);
  });

  it('rejects empty tracks, excessive length and excessive clip counts', () => {
    expect(() => planProjectRender(example())).toThrow(/empty/);
    expect(() => planProjectRender(clip(example(), 'a', 18000, 0, 1))).toThrow(
      /600 seconds/,
    );
    let project = example();
    for (let i = 0; i < 129; i++) project = clip(project, `c${i}`, i, 0, 1);
    expect(() => planProjectRender(project)).toThrow(/128 clips/);
  });

  it('reduces equivalent rational frame rates before FFmpeg compilation', () => {
    const project = clip(example(), 'a', 0, 0, 30);
    project.settings.frameRate = { numerator: 60000, denominator: 2002 };
    expect(planProjectRender(project).frameRate).toEqual({
      numerator: 30000,
      denominator: 1001,
    });
  });
});
