import { expect, it } from 'vitest';
import {
  addTransition,
  createProject,
  deserializeProject,
  evaluateTimeline,
  createPlaybackTimelineEvaluator,
  evaluateTimelineFrame,
  executeTransaction,
  frameTime,
  planProjectRender,
  projectRevision,
  redoEdit,
  serializeProject,
  undoEdit,
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
const add = {
  type: 'transition.add',
  id: 'mix',
  transition: dissolve,
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
  const { project } = addTransition(base, dissolve, 'mix');
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

it('preserves exact subtitle timing when an unrelated transition exists', () => {
  const { project } = executeTransaction(fixture(), {
    expectedRevision: 0,
    operations: [
      {
        type: 'subtitle.add',
        id: 'caption',
        text: 'Caption',
        start: { numerator: 101, denominator: 1000 },
        end: { numerator: 200, denominator: 1000 },
      },
    ],
  });
  const { project: withFade } = addTransition(project, {
    kind: 'fade-out',
    clipId: 'right',
    frames: 6,
  });
  const time = { numerator: 105, denominator: 1000 };
  const exact = evaluateTimeline(project, time).visualClips;
  expect(exact.some((clip) => clip.kind === 'text' && clip.subtitle)).toBe(
    true,
  );
  expect(evaluateTimeline(withFade, time).visualClips).toEqual(exact);
  expect(
    createPlaybackTimelineEvaluator(withFade)(time).visualClips.some(
      (clip) => clip.kind === 'text' && clip.subtitle,
    ),
  ).toBe(false);
});

it('preserves transition ownership across a split and round-trips edits through history', () => {
  const base = fixture();
  const { project } = executeTransaction(base, {
    expectedRevision: 0,
    operations: [
      add,
      {
        type: 'transition.add',
        id: 'exit',
        transition: { kind: 'fade-out', clipId: 'right', frames: 6 },
      },
      { type: 'clip.split', id: 'left', at: 10, rightId: 'left-end' },
      { type: 'clip.split', id: 'right', at: 40, rightId: 'right-end' },
      { type: 'transition.set', id: 'mix', frames: 11 },
    ],
  });
  const saved = deserializeProject(serializeProject(project));
  expect(saved.transitions).toEqual([
    { ...dissolve, id: 'mix', from: 'left-end', frames: 11 },
    { id: 'exit', kind: 'fade-out', clipId: 'right-end', frames: 6 },
  ]);
  const undone = undoEdit(saved);
  expect(undone.transitions).toBeUndefined();
  expect(redoEdit(undone).transitions).toEqual(saved.transitions);
  const removed = executeTransaction(saved, {
    expectedRevision: projectRevision(saved),
    operations: [
      { type: 'clip.remove', id: 'left-end' },
      { type: 'transition.remove', id: 'exit' },
    ],
  }).project;
  expect(removed.transitions).toBeUndefined();
  expect(undoEdit(removed).transitions).toEqual(saved.transitions);
});

it('rejects missing handles, off-grid cuts, conflicts, and unknown types without mutating the project', () => {
  const base = fixture();
  const { project } = executeTransaction(base, {
    expectedRevision: 0,
    operations: [add],
  });
  const before = serializeProject(project);
  expect(() =>
    executeTransaction(project, {
      expectedRevision: projectRevision(project),
      operations: [{ type: 'transition.set', id: 'mix', frames: 40 }],
    }),
  ).toThrow();
  expect(() =>
    executeTransaction(project, {
      expectedRevision: projectRevision(project),
      operations: [
        {
          type: 'transition.add',
          transition: { kind: 'fade-out', clipId: 'left', frames: 6 },
        },
      ],
    }),
  ).toThrow(/overlap/);
  expect(() =>
    executeTransaction(project, {
      expectedRevision: projectRevision(project),
      operations: [{ type: 'clip.split', id: 'left', at: 18 }],
    }),
  ).toThrow(/clip boundary/);
  expect(() =>
    executeTransaction(project, {
      expectedRevision: projectRevision(project),
      operations: [
        {
          type: 'clip.speed',
          id: 'left',
          speed: { numerator: 1, denominator: 1 },
        },
      ],
    }),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);

  const outgoing = fixture();
  outgoing.assets[0]!.duration = at(52);
  expect(() => addTransition(outgoing, dissolve)).toThrow(
    /insufficient source/,
  );
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
  expect(() => addTransition(shortStream, dissolve)).toThrow(
    /insufficient source/,
  );
  const incoming = fixture();
  incoming.clips[1]!.sourceIn = at(1);
  expect(() => addTransition(incoming, dissolve)).toThrow(
    /before its in point/,
  );
  const offGrid = fixture();
  offGrid.clips[0]!.sourceOut = at(47);
  offGrid.clips[1]!.timelineStart = frameTime(39, {
    numerator: 60000,
    denominator: 1001,
  });
  expect(() => addTransition(offGrid, dissolve)).toThrow(/project frame/);
  expect(
    validateProject({
      ...base,
      transitions: [{ ...dissolve, id: 'mix', kind: 'wipe' }],
    }).success,
  ).toBe(false);
});
