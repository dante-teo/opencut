import { describe, expect, it } from 'vitest';
import {
  createProject,
  createTimelineEvaluator,
  evaluateTimeline,
  frameTime,
} from '@opencut/core';
import {
  TimelineClock,
  inPlaybackLookahead,
} from '../../apps/desktop/src/renderer/timeline-playback.js';
import { auditProjects } from '../../scripts/t21-projects.js';

describe('authoritative timeline playback clock', () => {
  it('uses absolute audio-clock elapsed time, pauses without drift and clamps completion', () => {
    let now = 20;
    const clock = new TimelineClock(
      { numerator: 10, denominator: 1 },
      () => now,
    );
    clock.seek({ numerator: 1001, denominator: 30000 });
    clock.play();
    now += 1;
    expect(clock.read()).toEqual({ numerator: 31001, denominator: 30000 });
    clock.pause();
    const paused = clock.read();
    now += 100;
    expect(clock.read()).toEqual(paused);
    clock.play();
    now += 50;
    expect(clock.read()).toEqual({ numerator: 10, denominator: 1 });
    clock.pause();
    clock.play();
    expect(clock.read()).toEqual({ numerator: 0, denominator: 1 });
  });
  it('rapid seeks stop playback, use the final exact target and support an empty timeline', () => {
    let now = 0;
    const clock = new TimelineClock(
      { numerator: 6, denominator: 1 },
      () => now,
    );
    clock.play();
    now = 0.333333;
    for (const frame of [90, 0, 179, 30])
      clock.seek(frameTime(frame, { numerator: 30000, denominator: 1001 }));
    now = 100;
    expect(clock.playing).toBe(false);
    expect(clock.read()).toEqual(
      frameTime(30, { numerator: 30000, denominator: 1001 }),
    );
    const empty = new TimelineClock(
      { numerator: 0, denominator: 1 },
      () => now,
    );
    empty.play();
    expect(empty.playing).toBe(false);
  });
});

it('prepared T23 evaluation agrees at cuts, gaps and every mixing frame and isolates snapshots', () => {
  for (const project of Object.values(auditProjects())) {
    const evaluate = createTimelineEvaluator(project);
    for (let frame = 0; frame <= 240; frame++) {
      const time = frameTime(frame, project.settings.frameRate);
      expect(evaluate(time)).toEqual(evaluateTimeline(project, time));
    }
    const before = evaluate(frameTime(60, project.settings.frameRate));
    if (before.activeClips[0]) before.activeClips[0].visual.opacity = 0;
    expect(evaluate(frameTime(60, project.settings.frameRate))).toEqual(
      evaluateTimeline(project, frameTime(60, project.settings.frameRate)),
    );
    project.clips = [];
    expect(
      evaluate({ numerator: 0, denominator: 1 }).duration.numerator,
    ).toBeGreaterThan(0);
  }
  expect(
    createTimelineEvaluator(createProject({ name: 'Empty' }))({
      numerator: 0,
      denominator: 1,
    }).boundary,
  ).toBe('end');
});

it('lookahead comparisons and clock failure preserve valid extreme rational UI positions', () => {
  const time = {
    numerator: 8_999_999_999_999_999,
    denominator: 450_751_252_086_811,
  };
  expect(inPlaybackLookahead({ numerator: 20, denominator: 1 }, time)).toBe(
    true,
  );
  expect(inPlaybackLookahead({ numerator: 23, denominator: 1 }, time)).toBe(
    false,
  );
  let now = 0;
  const clock = new TimelineClock({ numerator: 30, denominator: 1 }, () => now);
  clock.seek(time);
  clock.play();
  now = 0.000001;
  expect(clock.read()).toEqual(time);
  expect(clock.playing).toBe(false);
  expect(clock.error).toContain('safe JSON integers');
});
