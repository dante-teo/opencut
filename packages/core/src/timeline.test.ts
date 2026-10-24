import { describe, expect, it, vi } from 'vitest';
import {
  addClip,
  addTimes,
  addTrack,
  clipDuration,
  clipTimelineEnd,
  compareTimes,
  createProject,
  deserializeProject,
  frameTime,
  listTimeline,
  moveClip,
  removeClip,
  removeTrack,
  serializeProject,
  splitClip,
  subtractTimes,
  trimClip,
  validateProject,
} from './index.js';
import type { Project, RationalTime } from './index.js';

const rate = { numerator: 30000, denominator: 1001 };
const at = (frame: number) => frameTime(frame, rate);
function example(): Project {
  const project = createProject({
    id: 'project',
    name: 'Timeline',
    createdAt: '2020-01-01T00:00:00.000Z',
    settings: { width: 1920, height: 1080, frameRate: rate },
  });
  project.assets = [
    {
      id: 'av',
      name: 'AV',
      file: { type: 'relative', path: 'offline.mp4' },
      mediaTypes: ['video', 'audio'],
      duration: at(300),
    },
    {
      id: 'audio',
      name: 'Audio',
      file: { type: 'relative', path: 'offline.wav' },
      mediaTypes: ['audio'],
      duration: at(300),
    },
    {
      id: 'unknown',
      name: 'Unknown/image',
      file: { type: 'relative', path: 'offline.png' },
      mediaTypes: ['video'],
    },
  ];
  project.tracks = [
    { id: 'v1', name: 'Video 1', type: 'video' },
    { id: 'v2', name: 'Video 2', type: 'video' },
    { id: 'a1', name: 'Audio 1', type: 'audio' },
  ];
  project.clips = [
    {
      id: 'first',
      assetId: 'av',
      trackId: 'v1',
      timelineStart: at(30),
      sourceIn: at(15),
      sourceOut: at(75),
    },
    {
      id: 'later',
      assetId: 'av',
      trackId: 'v1',
      timelineStart: at(120),
      sourceIn: at(0),
      sourceOut: at(60),
    },
  ];
  return project;
}

function rejected(
  edit: (project: Project) => unknown,
  pattern: string | RegExp,
) {
  const project = example();
  const before = structuredClone(project);
  expect(() => edit(project)).toThrow(pattern);
  expect(project).toEqual(before);
}

describe('shared headless timeline editing', () => {
  it('lists tracks in insertion order, clips by exact start and derived duration/end without modifying data', () => {
    const project = example();
    project.clips.reverse();
    const before = structuredClone(project);
    const result = listTimeline(project);
    expect(result.duration).toEqual(at(180));
    expect(result.frameRate).toEqual(rate);
    expect(result.tracks.map((track) => track.id)).toEqual(['v1', 'v2', 'a1']);
    expect(result.tracks[0]!.clips.map((clip) => clip.id)).toEqual([
      'first',
      'later',
    ]);
    expect(result.tracks[0]!.clips[0]).toEqual({
      ...project.clips[1],
      duration: at(60),
      timelineEnd: at(90),
    });
    expect(result.tracks[1]!.clips).toEqual([]);
    result.tracks[0]!.clips[0]!.sourceIn.numerator = 999;
    expect(project).toEqual(before);
    expect(listTimeline(createProject({ name: 'Empty' })).duration).toEqual(
      at(0),
    );
  });

  it('adds and removes video/audio tracks with unique IDs without touching the input', () => {
    const original = example();
    const before = structuredClone(original);
    const video = addTrack(original, { name: 'New video', type: 'video' });
    const audio = addTrack(video.project, { name: 'New audio', type: 'audio' });
    expect(video.track.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(audio.track.id).not.toBe(video.track.id);
    expect(audio.project.tracks.slice(-2)).toEqual([video.track, audio.track]);
    expect(
      removeTrack(audio.project, video.track.id).project.tracks,
    ).not.toContainEqual(video.track);
    expect(original).toEqual(before);
    expect(video.project.metadata.updatedAt > original.metadata.updatedAt).toBe(
      true,
    );
  });

  it.each(['project', 'av', 'v1', 'first'])(
    'rejects a new ID already used by any entity: %s',
    (id) => {
      rejected(
        (project) =>
          addTrack(project, { id, name: 'Duplicate', type: 'video' }),
        'already in use',
      );
      rejected(
        (project) =>
          addClip(project, {
            id,
            assetId: 'av',
            trackId: 'v2',
            timelineStart: at(0),
            sourceIn: at(0),
            sourceOut: at(10),
          }),
        'already in use',
      );
      rejected(
        (project) => splitClip(project, 'first', at(45), id),
        'already in use',
      );
    },
  );

  it('handles a generated ID collision without reusing it', () => {
    const project = example();
    const collision = '11111111-1111-4111-8111-111111111111';
    const unique = '22222222-2222-4222-8222-222222222222';
    project.assets[0]!.id = collision;
    project.clips.forEach((clip) => {
      clip.assetId = collision;
    });
    const random = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(collision)
      .mockReturnValueOnce(unique);
    try {
      expect(
        addTrack(project, { name: 'Unique', type: 'video' }).track.id,
      ).toBe(unique);
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });

  it('adds clips for AV, audio and unknown-duration/image assets with exact bounds', () => {
    let project = example();
    for (const [assetId, trackId, start] of [
      ['av', 'v1', 90],
      ['audio', 'a1', 30],
      ['unknown', 'v2', 30],
    ] as const) {
      const result = addClip(project, {
        assetId,
        trackId,
        timelineStart: at(start),
        sourceIn: at(0),
        sourceOut: at(30),
      });
      expect(result.clip.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.clip).toMatchObject({
        assetId,
        trackId,
        timelineStart: at(start),
      });
      project = result.project;
    }
    expect(project.clips).toHaveLength(5);
    expect(validateProject(project).success).toBe(true);
  });

  it('moves a clip by time, track or both, preserving ID and source mapping', () => {
    const original = example();
    const before = structuredClone(original);
    const moved = moveClip(original, 'first', { timelineStart: at(60) });
    expect(moved.clip).toEqual({ ...original.clips[0], timelineStart: at(60) });
    const audio = moveClip(moved.project, 'first', { trackId: 'a1' });
    expect(audio.clip).toEqual({ ...moved.clip, trackId: 'a1' });
    const both = moveClip(audio.project, 'first', {
      trackId: 'v2',
      timelineStart: at(0),
    });
    expect(both.clip).toEqual({
      ...moved.clip,
      trackId: 'v2',
      timelineStart: at(0),
    });
    expect(both.project.clips[1]).toEqual(original.clips[1]);
    expect(original).toEqual(before);
  });

  it('trims either or both source points, fixing timeline start and leaving neighbors unchanged', () => {
    const original = example();
    const before = structuredClone(original);
    const trimmed = trimClip(original, 'first', { sourceIn: at(30) });
    expect(trimmed.clip).toEqual({ ...original.clips[0], sourceIn: at(30) });
    const extended = trimClip(trimmed.project, 'first', { sourceOut: at(100) });
    expect(clipTimelineEnd(extended.clip)).toEqual(at(100));
    const both = trimClip(extended.project, 'first', {
      sourceIn: at(0),
      sourceOut: at(90),
    });
    expect(clipTimelineEnd(both.clip)).toEqual(at(120));
    expect(both.clip.timelineStart).toEqual(original.clips[0]!.timelineStart);
    expect(both.project.clips[1]).toEqual(original.clips[1]);
    expect(original).toEqual(before);
  });

  it('accepts no-op moves/trims without rewriting equivalent fractions or timestamps', () => {
    const project = example();
    const start = project.clips[0]!.timelineStart;
    const same = {
      numerator: start.numerator * 2,
      denominator: start.denominator * 2,
    };
    expect(
      moveClip(project, 'first', { trackId: 'v1', timelineStart: same })
        .project,
    ).toEqual(project);
    expect(
      trimClip(project, 'first', { sourceIn: at(15), sourceOut: at(75) })
        .project,
    ).toEqual(project);
  });

  it.each([31, 45, 89])(
    'splits at absolute fractional-rate frame %s without changing source mapping or total duration',
    (frame) => {
      const original = example();
      const before = structuredClone(original);
      const result = splitClip(original, 'first', at(frame));
      expect(result.left.id).toBe('first');
      expect(result.right.id).not.toBe(result.left.id);
      expect(result.right.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.left.sourceOut).toEqual(at(15 + frame - 30));
      expect(result.right.sourceIn).toEqual(result.left.sourceOut);
      expect(result.right.sourceOut).toEqual(original.clips[0]!.sourceOut);
      expect(result.right.timelineStart).toEqual(at(frame));
      expect(clipTimelineEnd(result.left)).toEqual(result.right.timelineStart);
      expect(clipTimelineEnd(result.right)).toEqual(
        clipTimelineEnd(original.clips[0]!),
      );
      expect(
        addTimes(clipDuration(result.left), clipDuration(result.right)),
      ).toEqual(clipDuration(original.clips[0]!));
      for (const clip of [result.left, result.right])
        expect(subtractTimes(clip.timelineStart, clip.sourceIn)).toEqual(
          subtractTimes(
            original.clips[0]!.timelineStart,
            original.clips[0]!.sourceIn,
          ),
        );
      expect(result.project.clips.map((clip) => clip.id)).toEqual([
        'first',
        result.right.id,
        'later',
      ]);
      expect(deserializeProject(serializeProject(result.project))).toEqual(
        result.project,
      );
      expect(original).toEqual(before);
    },
  );

  it('preserves exact sample offsets through a subframe core split', () => {
    const project = example();
    project.clips = [
      {
        id: 'sample',
        assetId: 'audio',
        trackId: 'a1',
        timelineStart: at(1),
        sourceIn: { numerator: 1, denominator: 48000 },
        sourceOut: { numerator: 48001, denominator: 48000 },
      },
    ];
    const atSplit = addTimes(at(1), { numerator: 1, denominator: 48000 });
    const result = splitClip(project, 'sample', atSplit);
    expect(
      compareTimes(result.left.sourceOut, { numerator: 2, denominator: 48000 }),
    ).toBe(0);
    expect(
      addTimes(clipDuration(result.left), clipDuration(result.right)),
    ).toEqual({ numerator: 1, denominator: 1 });
  });

  it('removes only the named clip without shifting neighbors or deleting assets/tracks', () => {
    const original = example();
    const before = structuredClone(original);
    const result = removeClip(original, 'first');
    expect(result.removedClipId).toBe('first');
    expect(result.project.clips).toEqual([original.clips[1]]);
    expect(result.project.assets).toEqual(original.assets);
    expect(result.project.tracks).toEqual(original.tracks);
    expect(original).toEqual(before);
  });

  it.each([0, 30, 90, 91, 1000])(
    'rejects split boundary/outside position %s',
    (frame) => {
      rejected(
        (project) => splitClip(project, 'first', at(frame)),
        'strictly inside',
      );
    },
  );

  it('reports missing entity IDs and populated tracks with actionable errors', () => {
    rejected((project) => removeTrack(project, 'missing'), 'timeline list');
    rejected((project) => removeTrack(project, 'v1'), 'first, later');
    for (const edit of [
      removeClip,
      (project: Project, id: string) =>
        moveClip(project, id, { trackId: 'v2' }),
      (project: Project, id: string) =>
        trimClip(project, id, { sourceOut: at(1) }),
      (project: Project, id: string) => splitClip(project, id, at(1)),
    ])
      rejected((project) => edit(project, 'missing'), 'timeline list');
    rejected((project) => moveClip(project, 'first', {}), 'Specify');
    rejected((project) => trimClip(project, 'first', {}), 'Specify');
  });

  it.each([
    ['unknown asset', { assetId: 'missing' }, 'does not exist'],
    ['unknown track', { trackId: 'missing' }, 'does not exist'],
    ['incompatible media', { assetId: 'audio' }, 'has no video'],
    ['zero duration', { sourceOut: at(0) }, 'strictly later'],
    ['reversed range', { sourceIn: at(31) }, 'strictly later'],
    ['source overrun', { sourceOut: at(301) }, 'known duration'],
    [
      'negative time',
      { timelineStart: { numerator: -1, denominator: 1 } },
      '/timelineStart',
    ],
    [
      'zero denominator',
      { sourceIn: { numerator: 0, denominator: 0 } },
      '/sourceIn',
    ],
    [
      'unsafe numerator',
      { sourceOut: { numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 } },
      '/sourceOut',
    ],
  ])('rejects %s on add without changing input', (_label, changes, message) => {
    rejected(
      (project) =>
        addClip(project, {
          assetId: 'av',
          trackId: 'v2',
          timelineStart: at(0),
          sourceIn: at(0),
          sourceOut: at(30),
          ...changes,
        }),
      message,
    );
  });

  it('rejects incompatible moves, invalid trims and invalid track inputs', () => {
    const project = example();
    const audio = addClip(project, {
      id: 'sound',
      assetId: 'audio',
      trackId: 'a1',
      timelineStart: at(0),
      sourceIn: at(0),
      sourceOut: at(30),
    });
    expect(() => moveClip(audio.project, 'sound', { trackId: 'v2' })).toThrow(
      'has no video',
    );
    rejected(
      (value) => moveClip(value, 'first', { trackId: 'missing' }),
      'does not exist',
    );
    rejected(
      (value) => trimClip(value, 'first', { sourceIn: at(75) }),
      'strictly later',
    );
    rejected(
      (value) => trimClip(value, 'later', { sourceOut: at(301) }),
      'known duration',
    );
    rejected(
      (value) => addTrack(value, { name: ' ', type: 'video' }),
      'Name must not be blank',
    );
  });

  it.each([0, 29, 30, 31, 60, 89])(
    'rejects same-track overlap at frame %s on add',
    (frame) => {
      rejected(
        (project) =>
          addClip(project, {
            assetId: 'av',
            trackId: 'v1',
            timelineStart: at(frame),
            sourceIn: at(0),
            sourceOut: at(60),
          }),
        'overlaps',
      );
    },
  );

  it('rejects overlap from moves and trim extensions, including audio tracks', () => {
    rejected(
      (project) => moveClip(project, 'first', { timelineStart: at(61) }),
      'overlaps',
    );
    rejected(
      (project) => trimClip(project, 'first', { sourceOut: at(106) }),
      'overlaps',
    );
    const project = moveClip(example(), 'first', { trackId: 'a1' }).project;
    expect(() =>
      addClip(project, {
        assetId: 'audio',
        trackId: 'a1',
        timelineStart: at(40),
        sourceIn: at(0),
        sourceOut: at(10),
      }),
    ).toThrow('overlaps');
    const onOtherTrack = moveClip(example(), 'first', {
      trackId: 'v2',
      timelineStart: at(125),
    });
    expect(() =>
      moveClip(onOtherTrack.project, 'first', { trackId: 'v1' }),
    ).toThrow('overlaps');
  });

  it('enforces overlap validation on unsorted, nested and hand-edited documents and at reload', () => {
    const project = example();
    project.clips.push({
      ...project.clips[0]!,
      id: 'nested',
      timelineStart: at(31),
      sourceOut: at(16),
    });
    project.clips.push({
      ...project.clips[0]!,
      id: 'also-nested',
      timelineStart: at(40),
      sourceOut: at(16),
    });
    project.clips.reverse();
    const result = validateProject(project);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid project');
    expect(
      result.error.issues.filter((issue) => issue.code === 'clip_overlap'),
    ).toHaveLength(2);
    expect(() => deserializeProject(JSON.stringify(project))).toThrow(
      'overlaps',
    );
    expect(() => removeClip(project, 'nested')).toThrow('overlaps');
  });

  it('rejects unrepresentable derived timeline boundaries before saving', () => {
    rejected(
      (project) =>
        moveClip(project, 'first', {
          timelineStart: { numerator: Number.MAX_SAFE_INTEGER, denominator: 1 },
        }),
      'safe rational',
    );
  });

  it('does not move timestamps backwards for a future-dated project', () => {
    const project = example();
    project.metadata.updatedAt = '2099-01-01T00:00:00.000Z';
    expect(removeClip(project, 'first').project.metadata.updatedAt).toBe(
      project.metadata.updatedAt,
    );
  });
});

describe('rational editing arithmetic', () => {
  const a: RationalTime = {
    numerator: Number.MAX_SAFE_INTEGER,
    denominator: Number.MAX_SAFE_INTEGER,
  };
  it('reduces fractions exactly, including zero and large intermediate products', () => {
    expect(addTimes(a, a)).toEqual({ numerator: 2, denominator: 1 });
    expect(subtractTimes(a, a)).toEqual({ numerator: 0, denominator: 1 });
    expect(addTimes(at(1), at(2))).toEqual(at(3));
    expect(subtractTimes(at(100), at(1))).toEqual(at(99));
  });
  it('rejects negative, unsafe and malformed results instead of rounding', () => {
    expect(() => subtractTimes(at(0), at(1))).toThrow(RangeError);
    expect(() =>
      addTimes({ numerator: Number.MAX_SAFE_INTEGER, denominator: 1 }, a),
    ).toThrow(RangeError);
    expect(() => addTimes({ numerator: 1, denominator: 0 }, a)).toThrow();
  });
});
