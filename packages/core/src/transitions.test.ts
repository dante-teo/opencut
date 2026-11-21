import { transitionProgress } from '@opencut/shared';
import { expect, it } from 'vitest';
import {
  createProject,
  createTimelineEvaluator,
  evaluateTimeline,
  evaluateTimelineFrame,
  frameTime,
  planProjectRender,
  validateProject,
} from './index.js';

const rate = { numerator: 30000, denominator: 1001 };
const at = (frame: number) => frameTime(frame, rate);
const dissolve = {
  kind: 'cross-dissolve',
  from: 'left',
  to: 'right',
  frames: 9,
} as const;
function fixture() {
  const project = createProject({ name: 'Transition fixture' });
  project.settings.frameRate = rate;
  project.tracks = [{ id: 'video', type: 'video', name: 'Video' }];
  project.assets = ['a', 'b'].map((id) => ({
    id,
    name: id,
    file: { type: 'relative', path: id + '.mp4' },
    mediaTypes: ['video', 'audio'],
    duration: at(120),
  }));
  project.clips = [
    {
      id: 'left',
      assetId: 'a',
      trackId: 'video',
      timelineStart: at(0),
      sourceIn: at(8),
      sourceOut: at(48),
      speed: { numerator: 2, denominator: 1 },
    },
    {
      id: 'right',
      assetId: 'b',
      trackId: 'video',
      timelineStart: at(20),
      sourceIn: at(8),
      sourceOut: at(28),
      speed: { numerator: 1, denominator: 2 },
      keyframes: { opacity: [{ time: at(0), value: 0.5, easing: 'linear' }] },
    },
  ];
  return project;
}

it('shares a project-frame window and speed-adjusted source handles while preserving audio intervals', () => {
  const base = fixture();
  const project = { ...base, transitions: [{ id: 'mix', ...dissolve }] };
  const plan = planProjectRender(project);
  const baseline = planProjectRender(base);
  expect(plan.frameCount).toBe(baseline.frameCount);
  expect(plan.audioClips).toEqual(baseline.audioClips);
  expect(plan.visualClips).toEqual(baseline.visualClips);
  expect(
    plan.visualTransitions?.[0]?.layers.map(({ clipId, retiming, ramp }) => ({
      clipId,
      in: retiming?.sourceIn,
      out: retiming?.sourceOut,
      ramp,
    })),
  ).toEqual([
    {
      clipId: 'left',
      in: at(40),
      out: at(58),
      ramp: { startFrame: 16, endFrame: 25, direction: 'out' },
    },
    {
      clipId: 'right',
      in: at(6),
      out: frameTime(21, { numerator: 60000, denominator: 1001 }),
      ramp: { startFrame: 16, endFrame: 25, direction: 'in' },
    },
  ]);
  for (const [frame, left, right, audio] of [
    [15, 1, null, 'left'],
    [16, 1, 0, 'left'],
    [20, 0.5, 0.25, 'right'],
    [24, 0, 0.5, 'right'],
    [25, null, 0.5, 'right'],
  ] as const) {
    const sampled = evaluateTimelineFrame(project, frame);
    expect(
      sampled.visualClips.find(({ id }) => id === 'left')?.visual.opacity ??
        null,
    ).toBe(left);
    expect(
      sampled.visualClips.find(({ id }) => id === 'right')?.visual.opacity ??
        null,
    ).toBe(right);
    expect(sampled.audioClips.map(({ id }) => id)).toEqual([audio]);
  }
  expect(evaluateTimelineFrame(project, 16).visualClips[1]?.sourceTime).toEqual(
    at(6),
  );
  expect(evaluateTimelineFrame(project, 24).visualClips[0]?.sourceTime).toEqual(
    at(56),
  );
});

it('supports a bounded cubic directional wipe while preserving exact endpoints and the linear default', () => {
  const easing = {
    type: 'cubic-bezier',
    x1: 0.32,
    y1: 0,
    x2: 0.18,
    y2: 1,
  } as const;
  const style = { kind: 'wipe', direction: 'left', easing } as const;
  const ramp = {
    direction: 'in',
    startFrame: 315,
    endFrame: 345,
    style,
  } as const;
  expect(
    [314, 315, 344, 345].map((frame) => transitionProgress(frame, ramp)),
  ).toEqual([0, 0, 1, 1]);
  expect(1920 * (1 - transitionProgress(330, ramp))).toBeCloseTo(345.37, 2);
  expect(
    transitionProgress(330, {
      ...ramp,
      style: { kind: 'wipe', direction: 'left' },
    }),
  ).toBe(15 / 29);
  const project = {
    ...fixture(),
    transitions: [{ id: 'mix', ...dissolve, style }],
  };
  const [entry] = planProjectRender(project).visualTransitions!;
  expect(entry?.layers.map(({ ramp: { style } }) => style)).toEqual([
    style,
    style,
  ]);
  expect(
    validateProject({
      ...project,
      transitions: [
        {
          id: 'mix',
          ...dissolve,
          style: { ...style, easing: { ...easing, y2: 1.1 } },
        },
      ],
    }).success,
  ).toBe(false);
});

it('preserves exact subtitle timing when an unrelated transition exists', () => {
  const project = fixture();
  project.subtitles = {
    style: {},
    cues: [
      {
        id: 'caption',
        text: 'Caption',
        start: { numerator: 101, denominator: 1000 },
        end: { numerator: 200, denominator: 1000 },
      },
    ],
  };
  const withFade = {
    ...project,
    transitions: [
      { id: 'fade', kind: 'fade-out' as const, clipId: 'right', frames: 6 },
    ],
  };
  const time = { numerator: 105, denominator: 1000 };
  const exact = evaluateTimeline(project, time).visualClips;
  expect(exact.some((clip) => clip.kind === 'text' && clip.subtitle)).toBe(
    true,
  );
  expect(evaluateTimeline(withFade, time).visualClips).toEqual(exact);
  expect(
    createTimelineEvaluator(
      withFade,
      true,
    )(time).visualClips.some((clip) => clip.kind === 'text' && clip.subtitle),
  ).toBe(false);
});

it.each([
  ['video', 'video'],
  ['video', 'image'],
  ['image', 'video'],
  ['image', 'image'],
] as const)(
  'plans a %s to %s dissolve without changing audio intervals',
  (from, to) => {
    const project = fixture();
    for (const [index, kind] of [from, to].entries()) {
      if (kind === 'video') continue;
      const asset = project.assets[index]!;
      delete asset.duration;
      asset.mediaTypes = ['video'];
      asset.metadata = {
        kind: 'image',
        durationSeconds: null,
        formatName: 'png_pipe',
        width: 160,
        height: 90,
        videoCodec: 'png',
        audioCodec: null,
        frameRate: null,
        frameRateRatio: null,
        hasAudio: false,
      };
      const clip = project.clips[index]!;
      const duration = index === 0 ? 20 : 40;
      delete clip.speed;
      clip.sourceIn = at(0);
      clip.sourceOut = at(duration);
    }
    const baseline = planProjectRender(project);
    project.transitions = [{ id: 'mix', ...dissolve }];
    const plan = planProjectRender(project);
    expect(plan.audioClips).toEqual(baseline.audioClips);
    expect(plan.frameCount).toBe(baseline.frameCount);
    const layers = plan.visualTransitions?.[0]?.layers;
    const samples = evaluateTimelineFrame(project, 16).visualClips;
    for (const [index, kind] of [from, to].entries()) {
      expect(layers?.[index]?.retiming !== undefined).toBe(kind === 'video');
      if (kind === 'image') expect(samples[index]?.sourceTime).toEqual(at(0));
    }
  },
);

it('rejects missing handles, off-grid cuts, conflicts and unknown types', () => {
  const base = fixture();
  const mix = { id: 'mix', ...dissolve };
  const check = (project: ReturnType<typeof fixture>) =>
    planProjectRender({
      ...project,
      transitions: [mix],
    });
  expect(() =>
    planProjectRender({
      ...base,
      transitions: [
        mix,
        { id: 'fade', kind: 'fade-out', clipId: 'left', frames: 6 },
      ],
    }),
  ).toThrow(/overlap/);
  const outgoing = fixture();
  outgoing.assets[0]!.duration = at(52);
  expect(() => check(outgoing)).toThrow(/insufficient source/);
  const shortStream = fixture();
  shortStream.assets[0]!.metadata = {
    kind: 'video',
    durationSeconds: 4,
    videoDuration: at(52),
    formatName: null,
    width: null,
    height: null,
    videoCodec: null,
    audioCodec: null,
    frameRate: null,
    frameRateRatio: null,
    hasAudio: true,
  };
  expect(() => check(shortStream)).toThrow(/insufficient source/);
  const incoming = fixture();
  incoming.clips[1]!.sourceIn = at(1);
  expect(() => check(incoming)).toThrow(/before its in point/);
  const offGrid = fixture();
  offGrid.clips[0]!.sourceOut = at(47);
  offGrid.clips[1]!.timelineStart = frameTime(39, {
    numerator: 60000,
    denominator: 1001,
  });
  expect(() => check(offGrid)).toThrow(/project frame/);
  expect(
    validateProject({
      ...base,
      transitions: [{ ...dissolve, id: 'mix', kind: 'wipe' }],
    }).success,
  ).toBe(false);
});
