import { describe, expect, it } from 'vitest';
import {
  addClip,
  addTrack,
  createProject,
  frameTime,
  splitClip,
  trimClip,
} from './index.js';
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
  return addClip(project, {
    id,
    assetId: 'source',
    trackId: 'video',
    timelineStart: at(start),
    sourceIn: at(sourceIn),
    sourceOut: at(sourceOut),
  }).project;
}

describe('pure project render planning', () => {
  it('reuses trims/splits, sorts clips, inserts leading/interior gaps and preserves the input', () => {
    let project = clip(example(), 'a', 3, 6, 36);
    project = trimClip(project, 'a', { sourceOut: at(30) }).project;
    project = splitClip(project, 'a', at(13), 'b').project;
    project = clip(project, 'c', 30, 0, 2);
    project.clips.reverse();
    const before = structuredClone(project);
    expect(planProjectRender(project)).toEqual({
      width: 320,
      height: 180,
      frameRate: project.settings.frameRate,
      frameCount: 32,
      segments: [
        { kind: 'gap', frameCount: 3 },
        {
          kind: 'clip',
          clipId: 'a',
          assetId: 'source',
          sourceStartFrame: 6,
          frameCount: 10,
        },
        {
          kind: 'clip',
          clipId: 'b',
          assetId: 'source',
          sourceStartFrame: 16,
          frameCount: 14,
        },
        { kind: 'gap', frameCount: 3 },
        {
          kind: 'clip',
          clipId: 'c',
          assetId: 'source',
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
      planProjectRender(project).segments.every((s) => s.frameCount === 1),
    ).toBe(true);
  });

  it.each(['timelineStart', 'sourceIn', 'sourceOut'] as const)(
    'rejects subframe %s instead of rounding',
    (field) => {
      const project = clip(example(), 'a', 0, 0, 30);
      project.clips[0]![field] = {
        numerator: 1,
        denominator: field === 'sourceOut' ? 2 : 1000,
      };
      expect(() => planProjectRender(project)).toThrow(
        /between project frames/,
      );
    },
  );

  it('rejects multiple tracks even when empty and rejects audio content', () => {
    const project = clip(example(), 'a', 0, 0, 30);
    for (const type of ['video', 'audio'] as const)
      expect(() =>
        planProjectRender(addTrack(project, { name: 'Extra', type }).project),
      ).toThrow(/exactly one video track/);
    project.tracks[0]!.type = 'audio';
    project.assets[0]!.mediaTypes = ['audio'];
    expect(() => planProjectRender(project)).toThrow(/no audio/);
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
    for (let i = 0; i < 65; i++) project = clip(project, `c${i}`, i, 0, 1);
    expect(() => planProjectRender(project)).toThrow(/64 clips/);
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
