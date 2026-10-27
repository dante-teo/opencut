import { describe, expect, it, vi } from 'vitest';
import {
  createProject,
  deserializeProject,
  serializeProject,
  validateProject,
} from './project.js';
import {
  commitEdit,
  executeTransaction,
  previewTransaction,
  getEditHistory,
  parseEditTransaction,
  projectRevision,
  projectSnapshot,
  redoEdit,
  undoEdit,
} from './editing.js';
import type { EditOperation } from './editing.js';
import { addTrack } from './timeline.js';

function project() {
  const value = createProject({
    name: 'Offline edits',
    createdAt: '2020-01-01T00:00:00.000Z',
    settings: {
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30000, denominator: 1001 },
    },
  });
  value.assets.push({
    id: 'asset',
    name: 'Offline',
    file: { type: 'relative', path: 'missing.mp4' },
    mediaTypes: ['video', 'audio'],
  });
  return value;
}
const operations: EditOperation[] = [
  { type: 'track.add', id: 'v1', name: 'Video', mediaType: 'video' },
  {
    type: 'clip.add',
    id: 'c1',
    assetId: 'asset',
    trackId: 'v1',
    at: 0,
    in: 0,
    out: 90,
  },
  { type: 'clip.split', id: 'c1', at: 30, rightId: 'right' },
  { type: 'clip.move', id: 'right', at: 60 },
  { type: 'clip.trim', id: 'right', in: 45, out: 60 },
];
const apply = (value = project(), edits = operations) =>
  executeTransaction(value, {
    expectedRevision: projectRevision(value),
    operations: edits,
    label: 'Sequence',
  }).project;

describe('headless editing transactions', () => {
  it('reuses every T08 operation against evolving state and commits once without mutating input', () => {
    const original = project();
    const before = serializeProject(original);
    const result = executeTransaction(original, {
      expectedRevision: 0,
      operations,
    });
    expect(serializeProject(original)).toBe(before);
    expect(result.results).toHaveLength(5);
    expect(result.project.clips).toHaveLength(2);
    expect(result.project.clips[1]).toMatchObject({
      id: 'right',
      timelineStart: { numerator: 1001, denominator: 500 },
      sourceIn: { numerator: 3003, denominator: 2000 },
    });
    expect(projectRevision(result.project)).toBe(1);
    expect(getEditHistory(result.project).undo).toHaveLength(1);
    const empty = apply(result.project, [
      { type: 'clip.remove', id: 'c1' },
      { type: 'clip.remove', id: 'right' },
      { type: 'track.remove', id: 'v1' },
    ]);
    expect(empty.tracks).toEqual([]);
    expect(empty.clips).toEqual([]);
    expect(getEditHistory(empty).undo).toHaveLength(2);
  });

  it('rolls back on a later invalid edit, including an intermediate overlap', () => {
    const original = project();
    const before = serializeProject(original);
    expect(() =>
      apply(original, [...operations, { type: 'track.remove', id: 'v1' }]),
    ).toThrow('Operation 6 (track.remove)');
    expect(() =>
      apply(original, [
        ...operations.slice(0, 2),
        {
          type: 'clip.add',
          id: 'overlap',
          assetId: 'asset',
          trackId: 'v1',
          at: 1,
          in: 0,
          out: 5,
        },
        { type: 'clip.remove', id: 'overlap' },
      ]),
    ).toThrow('overlaps');
    expect(serializeProject(original)).toBe(before);
  });

  it('persists exact snapshots and repeatedly restores IDs, ordering, rational forms and timestamps', () => {
    const original = project();
    const first = apply(original);
    const second = apply(first, [
      { type: 'track.add', name: 'Music', mediaType: 'audio' },
    ]);
    let current = deserializeProject(serializeProject(second));
    current = undoEdit(current, 2);
    expect(projectSnapshot(current)).toEqual(projectSnapshot(first));
    current = undoEdit(deserializeProject(serializeProject(current)), 3);
    expect(projectSnapshot(current)).toEqual(original);
    current = redoEdit(deserializeProject(serializeProject(current)), 4);
    expect(projectSnapshot(current)).toEqual(projectSnapshot(first));
    current = redoEdit(current, 5);
    expect(projectSnapshot(current)).toEqual(projectSnapshot(second));
    expect(projectRevision(current)).toBe(6);
    expect(() => redoEdit(current)).toThrow('Nothing to redo');
    expect(() => undoEdit(original)).toThrow('Nothing to undo');
  });

  it('invalidates redo only on changed edits and retains no-op history and revisions', () => {
    const first = apply();
    const second = apply(first, [{ type: 'clip.remove', id: 'right' }]);
    const undone = undoEdit(second);
    const noOp = apply(undone, [{ type: 'clip.move', id: 'c1', at: 0 }]);
    expect(noOp).toEqual(undone);
    expect(getEditHistory(noOp).redo).toHaveLength(1);
    const branch = apply(noOp, [
      { type: 'track.add', name: 'Branch', mediaType: 'audio' },
    ]);
    expect(getEditHistory(branch).redo).toEqual([]);
    expect(() => redoEdit(branch)).toThrow('Nothing to redo');
    expect(projectSnapshot(undoEdit(branch))).toEqual(projectSnapshot(undone));
  });

  it.each<{ name: string; edits: EditOperation[] }>([
    {
      name: 'adding then removing a track',
      edits: [
        {
          type: 'track.add',
          id: 'temporary',
          name: 'Temporary',
          mediaType: 'video',
        },
        { type: 'track.remove', id: 'temporary' },
      ],
    },
    {
      name: 'moving a clip away and back',
      edits: [
        { type: 'clip.move', id: 'c1', at: 10 },
        { type: 'clip.move', id: 'c1', at: 0 },
      ],
    },
    {
      name: 'trimming a clip and restoring its range',
      edits: [
        { type: 'clip.trim', id: 'c1', out: 20 },
        { type: 'clip.trim', id: 'c1', out: 30 },
      ],
    },
  ])('preserves revision, timestamps and redo after $name', ({ edits }) => {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2030-01-01T00:00:00.000Z'));
    try {
      const first = apply();
      const second = apply(first, [
        { type: 'track.add', name: 'Music', mediaType: 'audio' },
      ]);
      const undone = undoEdit(second);
      const saved = serializeProject(undone);
      clock.mockReturnValue(Date.parse('2031-01-01T00:00:00.000Z'));
      const result = executeTransaction(undone, {
        expectedRevision: projectRevision(undone),
        operations: edits,
      });
      expect(result.results).toHaveLength(edits.length);
      expect(serializeProject(result.project)).toBe(saved);
      expect(serializeProject(undone)).toBe(saved);
      expect(projectSnapshot(redoEdit(result.project))).toEqual(
        projectSnapshot(second),
      );

      const changed = apply(result.project, [
        { type: 'track.add', name: 'New edit', mediaType: 'video' },
      ]);
      expect(changed.metadata.updatedAt).toBe('2031-01-01T00:00:00.000Z');
      expect(projectRevision(changed)).toBe(projectRevision(undone) + 1);
      expect(getEditHistory(changed).redo).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects stale revisions even after undo returns the old content', () => {
    const original = project();
    const first = apply(original);
    expect(() =>
      executeTransaction(first, { expectedRevision: 0, operations }),
    ).toThrow('expected 0, found 1');
    const undone = undoEdit(first);
    expect(projectSnapshot(undone)).toEqual(original);
    expect(() =>
      executeTransaction(undone, { expectedRevision: 0, operations }),
    ).toThrow('expected 0, found 2');
    expect(() => undoEdit(first, 0)).toThrow('revision conflict');
    expect(() => redoEdit(undone, 1)).toThrow('revision conflict');
  });

  it.each([
    {},
    { expectedRevision: 0, operations: [] },
    { expectedRevision: 0, operations: [{ type: 'unknown' }] },
    { expectedRevision: 0, operations, extra: true },
    { expectedRevision: -1, operations },
    {
      expectedRevision: 0,
      operations: [{ type: 'clip.move', id: 'c1', at: 0.5 }],
    },
    {
      expectedRevision: 0,
      operations: [
        { type: 'track.add', name: 'V', mediaType: 'video', extra: true },
      ],
    },
  ])('validates strict transaction JSON: %j', (value) => {
    expect(() => parseEditTransaction(value)).toThrow('Invalid transaction');
  });

  it('guards corrupt history, semantically invalid snapshots and external content edits', () => {
    const first = apply();
    const altered = structuredClone(first);
    altered.metadata.name = 'External edit';
    expect(() => undoEdit(altered)).toThrow('differs from its editing history');
    expect(() =>
      commitEdit(
        altered,
        addTrack(altered, { name: 'New', type: 'video' }).project,
      ),
    ).toThrow('history');
    const broken = apply(first, [{ type: 'clip.remove', id: 'right' }]);
    broken.editing!.undo[1]!.before.metadata.name = 'Broken';
    expect(() => getEditHistory(broken)).toThrow('inconsistent');
    first.editing!.undo[0]!.after.clips[0]!.trackId = 'absent';
    expect(validateProject(first).success).toBe(false);
    expect(() => deserializeProject(JSON.stringify(first))).toThrow(
      '/editing/undo/0/after/clips/0/trackId',
    );
  });

  it('prevents revision overflow and cross-project snapshots', () => {
    const original = project();
    original.editing = {
      revision: Number.MAX_SAFE_INTEGER,
      undo: [],
      redo: [],
    };
    expect(() => apply(original)).toThrow('revision is exhausted');
    const first = apply();
    first.editing!.undo[0]!.before.metadata.id = 'different-project';
    expect(validateProject(first).success).toBe(false);
  });
});

it('previews the same commands without committing revision/history or mutating the input', () => {
  const original = project();
  const before = serializeProject(original);
  const preview = previewTransaction(original, {
    expectedRevision: 0,
    operations,
  });
  const committed = executeTransaction(original, {
    expectedRevision: 0,
    operations,
  });
  expect(preview.project.clips).toEqual(committed.project.clips);
  expect(preview.project.tracks).toEqual(committed.project.tracks);
  expect(preview.project.editing).toBeUndefined();
  expect(serializeProject(original)).toBe(before);
  expect(() =>
    previewTransaction(original, {
      expectedRevision: 0,
      operations: [...operations, { type: 'clip.move', id: 'missing', at: 10 }],
    }),
  ).toThrow('does not exist');
  expect(serializeProject(original)).toBe(before);
});
