import { describe, expect, it } from 'vitest';
import {
  createProject,
  createTimelineEvaluator,
  evaluateTimeline,
  frameTime,
  resolveTimeline,
  setClipAudio,
  splitClip,
} from '@opencut/core';
import {
  TimelineClock,
  TimelinePlayback,
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

it.each(['split', 'touching'] as const)(
  'schedules the outgoing ramp and incoming gain at the same timestamp for %s fades',
  (boundary) => {
    const project = createProject({ name: 'Fade boundary' });
    const at = (frame: number) => frameTime(frame, project.settings.frameRate);
    project.assets = [
      {
        id: 'audio',
        name: 'Audio',
        mediaTypes: ['audio'],
        file: { type: 'relative', path: 'tone.wav' },
      },
    ];
    project.tracks = [{ id: 'track', name: 'Audio', type: 'audio' }];
    project.clips = [
      {
        id: 'left',
        assetId: 'audio',
        trackId: 'track',
        timelineStart: at(3),
        sourceIn: at(0),
        sourceOut: at(12),
      },
    ];
    const faded = setClipAudio(
      project,
      'left',
      boundary === 'split'
        ? { fadeIn: at(12) }
        : { fadeIn: at(6), fadeOut: at(6) },
    ).project;
    const input =
      boundary === 'split'
        ? splitClip(faded, 'left', at(9), 'right').project
        : faded;
    const run = resolveTimeline(input).clips;
    const active = evaluateTimeline(input, at(3)).audioClips[0]!;
    const events: { type: 'set' | 'ramp'; gain: number; time: number }[] = [];
    const param = {
      cancelScheduledValues() {},
      setValueAtTime(gain: number, time: number) {
        events.push({ type: 'set', gain, time });
      },
      linearRampToValueAtTime(gain: number, time: number) {
        events.push({ type: 'ramp', gain, time });
      },
    };
    // Exercise the production scheduler with a fixed audio clock. A live
    // clock can round away the original mismatch when adding its current time.
    Reflect.apply(
      Reflect.get(TimelinePlayback.prototype, 'scheduleGain'),
      {
        context: { currentTime: 0.125 },
        runs: new Map([['left', run]]),
        action: 1,
      },
      [{ key: 'left', gain: { gain: param } }, active, at(3)],
    );
    const [, attackEnd, followingGain] = events;
    const gain = boundary === 'split' ? 0.5 : 1;
    expect(attackEnd).toMatchObject({ type: 'ramp', gain });
    expect(followingGain).toEqual({ type: 'set', gain, time: attackEnd!.time });
  },
);

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
