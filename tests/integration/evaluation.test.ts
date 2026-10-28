import { describe, expect, it } from 'vitest';
import {
  addTimes,
  compareTimes,
  createProject,
  evaluateTimeline,
  evaluateTimelineFrame,
  frameTime,
  moveClip,
  planProjectRender,
  splitClip,
  subtractTimes,
  trimClip,
} from '@opencut/core';
import { auditProjects } from '../../scripts/t21-projects.js';

const seconds = (numerator: number, denominator = 1) => ({
  numerator,
  denominator,
});

describe('shared timeline evaluation', () => {
  it.each(Object.keys(auditProjects()))(
    'matches every render frame of T21 %s',
    (name) => {
      const project = auditProjects()[name]!;
      const before = structuredClone(project);
      const plan = planProjectRender(project);
      for (let frame = 0; frame <= plan.frameCount; frame++) {
        const result = evaluateTimelineFrame(project, frame);
        const active = plan.visualClips.filter(
          (clip) =>
            frame >= clip.timelineStartFrame &&
            frame < clip.timelineStartFrame + clip.frameCount,
        );
        expect(result.visualClips.map((clip) => clip.id)).toEqual(
          active.map((clip) => clip.clipId),
        );
        for (const [index, clip] of active.entries()) {
          const evaluated = result.visualClips[index]!;
          expect(evaluated.sourceTime).toEqual(
            frameTime(
              clip.sourceStartFrame + frame - clip.timelineStartFrame,
              plan.frameRate,
            ),
          );
          expect(evaluated.visual).toEqual({
            x: clip.x,
            y: clip.y,
            scale: clip.scale,
            opacity: clip.opacity,
            fit: clip.fit,
          });
        }
        for (const clip of result.audioClips) {
          expect(
            plan.audioClips.find((entry) => entry.clipId === clip.id),
          ).toMatchObject({ volume: clip.volume, muted: clip.muted });
        }
        expect(evaluateTimelineFrame(project, frame)).toEqual(result);
      }
      expect(project).toEqual(before);
    },
  );

  it('distinguishes leading/interior gaps, audio tails, exact end and after end', () => {
    const project = auditProjects().gaps!;
    expect(evaluateTimelineFrame(project, 0)).toMatchObject({
      gap: true,
      visualGap: true,
      boundary: 'inside',
    });
    expect(evaluateTimelineFrame(project, 90).gap).toBe(true);
    expect(evaluateTimelineFrame(project, 180)).toMatchObject({
      gap: false,
      visualGap: true,
      mixingSources: [{ id: 'tail' }],
    });
    expect(evaluateTimelineFrame(project, 240)).toMatchObject({
      boundary: 'end',
      activeClips: [],
    });
    expect(evaluateTimelineFrame(project, 241).boundary).toBe('after');
    expect(
      evaluateTimeline(createProject({ name: 'Empty' }), seconds(0)),
    ).toMatchObject({ boundary: 'end', gap: true });
  });

  it('preserves source mapping through trim, split and move at fractional rates without accumulation', () => {
    let project = auditProjects().cuts!;
    project.settings.frameRate = { numerator: 30000, denominator: 1001 };
    project = trimClip(project, 'c0', {
      sourceIn: seconds(1),
      sourceOut: seconds(3),
    }).project;
    project = splitClip(project, 'c0', seconds(1), 'split').project;
    const original = evaluateTimeline(project, seconds(1));
    expect(original.activeClips.map((clip) => clip.id)).toEqual(['split']);
    expect(original.activeClips[0]!.sourceTime).toEqual(seconds(2));
    const far = frameTime(1_000_000_000, project.settings.frameRate);
    project = moveClip(project, 'split', { timelineStart: far }).project;
    const time = addTimes(far, frameTime(17, project.settings.frameRate));
    expect(evaluateTimeline(project, time).activeClips[0]!.sourceTime).toEqual(
      addTimes(seconds(2), frameTime(17, project.settings.frameRate)),
    );
    expect(evaluateTimelineFrame(project, 1_000_000_017)).toEqual(
      evaluateTimeline(project, time),
    );
    expect(() => planProjectRender(project)).toThrow();
  });

  it('orders layers by track array, distinguishes stills, and keeps invisible audio independent', () => {
    const project = auditProjects().overlays!;
    project.clips.reverse();
    project.clips[1]!.visual = { opacity: 0 };
    const result = evaluateTimeline(project, seconds(2));
    expect(
      result.visualClips.map((clip) => [
        clip.id,
        clip.kind,
        clip.trackIndex,
        clip.visible,
      ]),
    ).toEqual([
      ['base', 'video', 0, false],
      ['overlay', 'image', 1, true],
    ]);
    expect(result.mixingSources.map((clip) => clip.id)).toEqual(['base']);
    expect(result.visualClips[1]!.sourceTime).toEqual(seconds(1));
    result.visualClips[1]!.visual.scale = 4;
    expect(project.clips[0]!.visual!.scale).toBe(0.5);
  });

  it('resolves gain, mute, known silence and unknown streams without decoding', () => {
    const project = auditProjects().mixing!;
    project.clips[0]!.muted = true;
    project.clips[2]!.volume = 0;
    expect(evaluateTimelineFrame(project, 90).mixingSources).toEqual([]);
    expect(
      evaluateTimelineFrame(project, 90).audioClips.map((clip) => clip.id),
    ).toEqual(['base', 'music']);
    delete project.assets[1]!.metadata;
    project.clips[1]!.muted = false;
    expect(evaluateTimelineFrame(project, 90).mixingSources).toMatchObject([
      { id: 'mixed', audioPresence: 'unknown', effectiveVolume: 1 },
    ]);
  });

  it('handles mixed source rates and equivalent exact subframe queries', () => {
    const project = auditProjects().cuts!;
    project.settings.frameRate = { numerator: 24000, denominator: 1001 };
    const time = frameTime(100, project.settings.frameRate);
    const result = evaluateTimeline(project, time);
    expect(result.activeClips[0]!.sourceTime).toEqual(
      addTimes(seconds(1), subtractTimes(time, seconds(3))),
    );
    expect(
      compareTimes(
        result.time,
        seconds(time.numerator * 2, time.denominator * 2),
      ),
    ).toBe(0);
    expect(evaluateTimeline(project, seconds(6)).activeClips).toEqual([]);
  });

  it('rejects invalid times, references and same-track overlap', () => {
    const project = auditProjects().cuts!;
    for (const time of [seconds(-1), seconds(1, 0), seconds(0.1)])
      expect(() => evaluateTimeline(project, time)).toThrow();
    for (const frame of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => evaluateTimelineFrame(project, frame)).toThrow();
    project.clips[1]!.timelineStart = seconds(2);
    expect(() => evaluateTimeline(project, seconds(0))).toThrow(/overlaps/);
    project.clips[1]!.assetId = 'missing';
    expect(() => evaluateTimeline(project, seconds(0))).toThrow(
      /does not exist/,
    );
  });
});
