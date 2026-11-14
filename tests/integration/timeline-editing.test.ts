import { describe, expect, it } from 'vitest';
import {
  clipTimelineEnd,
  createProject,
  executeTransaction,
  frameTime,
  projectRevision,
  projectSnapshot,
  serializeProject,
  setClipAudio,
  setClipSpeed,
  splitClip,
  type Project,
} from '@opencut/core';
import {
  proposeEdit,
  createTimelinePreview,
  type GestureKind,
} from '../../apps/desktop/src/renderer/timeline-editing.js';

const rate = { numerator: 30000, denominator: 1001 };
function fixture(): Project {
  const project = createProject({
    name: 'Editing',
    settings: { width: 1920, height: 1080, frameRate: rate },
  });
  project.assets = [
    {
      id: 'video',
      name: 'Video',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'missing.mp4' },
      duration: frameTime(600, rate),
    },
  ];
  project.tracks = [
    { id: 'v1', name: 'Video', type: 'video' },
    { id: 'v2', name: 'Overlay', type: 'video' },
    { id: 'a1', name: 'Audio', type: 'audio' },
  ];
  project.clips = [
    {
      id: 'clip',
      assetId: 'video',
      trackId: 'v1',
      timelineStart: frameTime(60, rate),
      sourceIn: frameTime(30, rate),
      sourceOut: frameTime(120, rate),
    },
    {
      id: 'later',
      assetId: 'video',
      trackId: 'v1',
      timelineStart: frameTime(240, rate),
      sourceIn: frameTime(0, rate),
      sourceOut: frameTime(90, rate),
    },
  ];
  return project;
}
const propose = (
  project: Project,
  kind: GestureKind,
  delta: bigint,
  track = 'v1',
  zoom = 80,
  threshold = 0,
  playhead = 180,
) =>
  proposeEdit(
    project,
    project.clips[0]!,
    kind,
    delta,
    track,
    frameTime(playhead, rate),
    zoom,
    threshold,
  );

describe('shared-core GUI edit proposals', () => {
  it('maps both drag edges to exact source times at a fractional speed', () => {
    const project = setClipSpeed(fixture(), 'clip', {
      numerator: 3,
      denominator: 2,
    }).project;
    const left = propose(project, 'left', 1n);
    expect(left.error).toBeNull();
    expect(left.clip.timelineStart).toEqual(frameTime(61, rate));
    expect(left.clip.sourceIn).toEqual(
      frameTime(63, { numerator: 60000, denominator: 1001 }),
    );
    expect(clipTimelineEnd(left.clip)).toEqual(
      clipTimelineEnd(project.clips[0]!),
    );
    const right = propose(project, 'right', -1n);
    expect(right.error).toBeNull();
    expect(right.clip.sourceOut).toEqual(
      frameTime(237, { numerator: 60000, denominator: 1001 }),
    );
    expect(clipTimelineEnd(right.clip)).toEqual(frameTime(119, rate));
  });

  it('preserves a split fade when the handle cannot extend or moves only vertically', () => {
    const project = fixture();
    const faded = setClipAudio(project, 'clip', {
      fadeIn: frameTime(24, rate),
    }).project;
    const split = splitClip(
      faded,
      'clip',
      frameTime(72, rate),
      'right',
    ).project;
    expect(split.clips[0]!.fadeIn).toEqual({
      duration: frameTime(12, rate),
      to: 0.5,
    });
    for (const delta of [0n, 1n]) {
      const result = propose(split, 'fadeIn', delta);
      expect(result).toMatchObject({
        operations: [],
        clip: split.clips[0],
        error: null,
      });
    }
    const shorter = propose(split, 'fadeIn', -1n);
    expect(shorter.operations).toEqual([
      { type: 'clip.audio', id: 'clip', fadeIn: 11 },
    ]);
    expect(shorter.clip.fadeIn).toEqual({ duration: frameTime(11, rate) });
  });

  it('rejects a text left trim that would round an off-grid right edge', () => {
    const project = fixture();
    const clip = {
      id: 'title',
      trackId: 'v1',
      timelineStart: frameTime(60, rate),
      sourceIn: frameTime(0, rate),
      sourceOut: { numerator: 61, denominator: 60 },
      text: { content: 'Title' },
    };
    project.clips[0] = clip;
    const proposal = propose(project, 'left', 1n);
    expect(proposal.error).toMatch(/align the text clip end/i);
    expect(proposal.operations).toEqual([]);
    expect(clipTimelineEnd(proposal.clip)).toEqual(clipTimelineEnd(clip));
  });
  it('extends a text clip to the left without a media source bound', () => {
    const project = fixture();
    project.clips[0] = {
      id: 'title',
      trackId: 'v1',
      timelineStart: frameTime(60, rate),
      sourceIn: frameTime(0, rate),
      sourceOut: frameTime(90, rate),
      text: { content: 'Title\n字幕' },
    };
    const next = propose(project, 'left', -15n);
    expect(next.error).toBeNull();
    expect(next.clip.timelineStart).toEqual(frameTime(45, rate));
    expect(clipTimelineEnd(next.clip)).toEqual(frameTime(150, rate));
    expect(next.clip.text).toEqual(project.clips[0].text);
    expect(next.operations).toEqual([
      { type: 'text.set', id: 'title', at: 45, duration: 105 },
    ]);
  });
  it('moves clips between compatible tracks, validates overlap/type rules and preserves the original', () => {
    const project = fixture();
    const before = serializeProject(project);
    const next = propose(project, 'move', 30n, 'v2');
    expect(next.error).toBeNull();
    expect(next.clip).toMatchObject({
      trackId: 'v2',
      timelineStart: frameTime(90, rate),
    });
    expect(next.clip.sourceIn).toEqual(project.clips[0]!.sourceIn);
    expect(propose(project, 'move', 200n).error).toBeTruthy();
    expect(propose(project, 'move', 0n, 'a1').error).toBeTruthy();
    expect(propose(project, 'move', 0n, '').error).toBeTruthy();
    expect(propose(project, 'move', -100n).clip.timelineStart).toEqual(
      frameTime(0, rate),
    );
    expect(serializeProject(project)).toBe(before);
  });
  it('pins the opposite edge on a left trim and makes the compound edit one undo entry', () => {
    const project = fixture();
    const next = propose(project, 'left', 15n);
    expect(next.error).toBeNull();
    expect(next.clip.timelineStart).toEqual(frameTime(75, rate));
    expect(next.clip.sourceIn).toEqual(frameTime(45, rate));
    expect(clipTimelineEnd(next.clip)).toEqual(
      clipTimelineEnd(project.clips[0]!),
    );
    expect(next.operations.map((operation) => operation.type)).toEqual([
      'clip.trim',
      'clip.move',
    ]);
    const committed = executeTransaction(project, {
      expectedRevision: projectRevision(project),
      operations: next.operations,
    }).project;
    expect(committed.editing?.undo).toHaveLength(1);
    const extended = propose(project, 'left', -15n);
    expect(extended.error).toBeNull();
    expect(extended.clip.sourceIn).toEqual(frameTime(15, rate));
    expect(clipTimelineEnd(extended.clip)).toEqual(
      clipTimelineEnd(project.clips[0]!),
    );
    expect(propose(project, 'left', -31n).error).toBeTruthy();
    expect(propose(project, 'left', 90n).error).toBeTruthy();
  });
  it('trims right, rejects zero length, overlaps and source overflow', () => {
    const project = fixture();
    const next = propose(project, 'right', -30n);
    expect(next.error).toBeNull();
    expect(next.clip.sourceOut).toEqual(frameTime(90, rate));
    expect(next.clip.timelineStart).toEqual(project.clips[0]!.timelineStart);
    expect(propose(project, 'right', -90n).error).toBeTruthy();
    expect(propose(project, 'right', 100n).error).toBeTruthy();
    expect(propose(project, 'right', 600n, 'v2').error).toBeTruthy();
  });
  it('uses a fixed pixel radius at each zoom and snaps either moving edge, trim edges and playhead', () => {
    const project = fixture();
    for (const zoom of [40, 80, 160, 320]) {
      const inside = BigInt(
        Math.floor((6 * rate.numerator) / (zoom * rate.denominator)),
      );
      const outside = BigInt(
        Math.ceil((12 * rate.numerator) / (zoom * rate.denominator)),
      );
      const snapped = propose(project, 'move', 120n - inside, 'v2', zoom, 8);
      expect(snapped.clip.timelineStart).toEqual(frameTime(180, rate));
      expect(snapped.snap).toEqual(frameTime(180, rate));
      const unsnapped = propose(project, 'move', 120n - outside, 'v2', zoom, 8);
      expect(unsnapped.snap).toBeNull();
      expect(unsnapped.clip.timelineStart).toEqual(
        frameTime(180 - Number(outside), rate),
      );
    }
    const endSnap = propose(project, 'move', 88n, 'v1', 80, 8, 1000);
    expect(clipTimelineEnd(endSnap.clip)).toEqual(frameTime(240, rate));
    expect(
      propose(project, 'right', 88n, 'v1', 80, 8, 1000).clip.sourceOut,
    ).toEqual(frameTime(210, rate));
    expect(
      propose(project, 'left', 28n, 'v1', 80, 8, 90).clip.timelineStart,
    ).toEqual(frameTime(90, rate));
    expect(propose(project, 'move', 118n, 'v2', 80, 0).snap).toBeNull();
  });
  it('does not chain nearby snap candidates beyond the configured radius', () => {
    const project = fixture();
    project.clips.push({
      ...project.clips[1]!,
      id: 'near',
      trackId: 'v2',
      timelineStart: frameTime(184, rate),
    });
    expect(propose(project, 'move', 118n, 'v2', 80, 8).snap).toEqual(
      frameTime(180, rate),
    );
  });
  it('ignores distant unrepresentable snap targets and refuses edge trims that would shift an off-grid opposite edge', () => {
    const project = fixture();
    project.clips.push({
      ...project.clips[1]!,
      id: 'far',
      trackId: 'v2',
      timelineStart: {
        numerator: Number.MAX_SAFE_INTEGER - 100,
        denominator: 1,
      },
      sourceOut: { numerator: 3, denominator: 1 },
    });
    expect(propose(project, 'move', 10n).error).toBeNull();
    project.clips[0]!.sourceIn = { numerator: 1, denominator: 100 };
    const before = serializeProject(project);
    expect(propose(project, 'left', 1n).error).toContain('project frames');
    expect(serializeProject(project)).toBe(before);
  });
  it('previews a history-heavy project without traversing history and commits with full history validation', () => {
    const project = fixture();
    project.clips = Array.from({ length: 300 }, (_, n) => ({
      ...project.clips[0]!,
      id: n === 0 ? 'clip' : `clip-${n}`,
      timelineStart: frameTime(60 + n * 180, rate),
    }));
    const before = projectSnapshot(project);
    const after = projectSnapshot(project);
    after.clips[0]!.timelineStart = frameTime(61, rate);
    project.editing = {
      revision: 30,
      undo: Array.from({ length: 30 }, (_, n) => ({
        id: `history-${n}`,
        label: 'Move',
        committedAt: project.metadata.createdAt,
        before: n % 2 ? after : before,
        after: n % 2 ? before : after,
      })),
      redo: [],
    };
    let historyReads = 0;
    Object.defineProperty(project.editing.undo[0]!, 'before', {
      enumerable: true,
      get: () => {
        historyReads++;
        return before;
      },
    });
    const preview = createTimelinePreview(project);
    expect('editing' in preview).toBe(false);
    expect(preview.clips[0]).not.toBe(project.clips[0]);
    let proposal = propose(preview, 'move', 1n, 'v2');
    for (let frame = 2n; frame <= 10n; frame++) {
      proposal = propose(preview, 'move', frame, 'v2');
      expect(proposal.error).toBeNull();
    }
    expect(historyReads).toBe(0);
    expect(project.editing.undo).toHaveLength(30);
    expect(project.clips[0]!.timelineStart).toEqual(frameTime(60, rate));
    const transaction = {
      expectedRevision: 30,
      operations: proposal.operations,
    };
    const committed = executeTransaction(project, transaction).project;
    expect(historyReads).toBeGreaterThan(0);
    expect(committed.clips[0]).toEqual(proposal.clip);
    expect(committed.editing?.undo).toHaveLength(31);
    expect(projectRevision(committed)).toBe(31);
    project.editing.undo[1]!.before = {
      ...after,
      metadata: { ...after.metadata, name: 'Broken chain' },
    };
    expect(() => executeTransaction(project, transaction)).toThrow('history');
    const invalid = {
      ...project,
      clips: [{ ...project.clips[0]!, sourceOut: frameTime(900, rate) }],
    };
    expect(() => createTimelinePreview(invalid)).toThrow();
  });
});

it('snaps any selected edge to a marker using the same pixel threshold at each zoom', () => {
  const project = fixture();
  project.markers = [{ id: 'marker', frame: 350, name: 'Beat' }];
  const group = (zoom: number) =>
    proposeEdit(
      project,
      project.clips[0]!,
      'move',
      22n,
      'v1',
      frameTime(0, rate),
      zoom,
      8,
      ['clip', 'later'],
    );
  const near = group(80);
  expect(near.error).toBeNull();
  expect(near.snap).toEqual(frameTime(350, rate));
  expect(near.clips?.map((clip) => clip.timelineStart)).toEqual([
    frameTime(80, rate),
    frameTime(260, rate),
  ]);
  const far = group(320);
  expect(far.error).toBeNull();
  expect(far.snap).toBeNull();
  expect(far.clips?.map((clip) => clip.timelineStart)).toEqual([
    frameTime(82, rate),
    frameTime(262, rate),
  ]);
});
