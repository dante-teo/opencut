import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, serializeProject } from './project.js';
import {
  executeTransaction,
  getEditHistory,
  projectSnapshot,
  redoEdit,
  undoEdit,
} from './editing.js';
import {
  readProjectFile,
  updateProjectFile,
  writeProjectFile,
} from './project-files.js';
import { addTrack } from './timeline.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'opencut-edit-')),
  );
  path = join(directory, 'project.json');
  await writeProjectFile(createProject({ name: 'Transactions' }), path);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const apply = (expectedRevision = 0, dryRun = false, invalid = false) =>
  updateProjectFile(
    path,
    async (project) => {
      const applied = executeTransaction(project, {
        expectedRevision,
        operations: [
          { type: 'track.add', id: 'v1', name: 'Video', mediaType: 'video' },
          ...(invalid
            ? [{ type: 'track.remove' as const, id: 'missing' }]
            : []),
        ],
      });
      return {
        project: applied.project,
        result: getEditHistory(applied.project),
      };
    },
    { expectedRevision, dryRun, history: 'restore' },
  );

describe('atomic editing persistence', () => {
  it('saves content and history together and restores them across every file reload', async () => {
    const original = await readProjectFile(path);
    await apply();
    const first = await readProjectFile(path);
    expect(getEditHistory(first)).toMatchObject({
      revision: 1,
      undo: [{ label: 'edit apply' }],
      redo: [],
    });
    await updateProjectFile(
      path,
      async (project) => ({ project: undoEdit(project, 1), result: undefined }),
      { history: 'restore' },
    );
    expect(projectSnapshot(await readProjectFile(path))).toEqual(original);
    await updateProjectFile(
      path,
      async (project) => ({ project: redoEdit(project, 2), result: undefined }),
      { history: 'restore' },
    );
    expect(projectSnapshot(await readProjectFile(path))).toEqual(
      projectSnapshot(first),
    );
    expect(await fs.readdir(directory)).toEqual(['project.json']);
  });

  it('leaves bytes, timestamps, history and owned artifacts unchanged on dry-run or validation failure', async () => {
    const before = await fs.readFile(path, 'utf8');
    const modified = (await fs.stat(path)).mtimeMs;
    expect((await apply(0, true)).revision).toBe(1);
    await expect(apply(0, false, true)).rejects.toThrow('Operation 2');
    await expect(apply(0, true, true)).rejects.toThrow('Operation 2');
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.stat(path)).mtimeMs).toBe(modified);
    expect(await fs.readdir(directory)).toEqual(['project.json']);
  });

  it('records individual adapter mutations, including callbacks that mutate the input', async () => {
    const before = await readProjectFile(path);
    await updateProjectFile(
      path,
      async (project) => {
        project.metadata.name = 'Changed in place';
        return { project, result: undefined };
      },
      { label: 'Rename', expectedRevision: 0 },
    );
    const after = await readProjectFile(path);
    expect(after.editing!.undo[0]!.before).toEqual(before);
    expect(projectSnapshot(undoEdit(after))).toEqual(before);
  });

  it('rejects stale commits and dry-runs before invoking callbacks', async () => {
    await apply();
    const bytes = await fs.readFile(path, 'utf8');
    const update = vi.fn(
      async (project: Awaited<ReturnType<typeof readProjectFile>>) => ({
        project,
        result: undefined,
      }),
    );
    for (const dryRun of [false, true])
      await expect(
        updateProjectFile(path, update, { expectedRevision: 0, dryRun }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(update).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  });

  it('rejects a stale project returned by a callback even without an explicit revision option', async () => {
    const stale = await readProjectFile(path);
    await apply();
    const bytes = await fs.readFile(path, 'utf8');
    await expect(
      updateProjectFile(path, async () => ({
        project: stale,
        result: undefined,
      })),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  });

  it('rejects a stale already-managed history result without an explicit revision option', async () => {
    await apply();
    const cachedUndo = undoEdit(await readProjectFile(path));
    await updateProjectFile(path, async (project) => ({
      project: addTrack(project, {
        id: 'second',
        name: 'Second',
        type: 'audio',
      }).project,
      result: undefined,
    }));
    const bytes = await fs.readFile(path, 'utf8');
    await expect(
      updateProjectFile(
        path,
        async () => ({ project: cachedUndo, result: undefined }),
        { history: 'restore' },
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  });

  it('serializes simultaneous writers and rejects a stale retry without losing the first edit', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = updateProjectFile(
      path,
      async (project) => {
        entered();
        await gate;
        return {
          project: addTrack(project, {
            id: 'first',
            name: 'First',
            type: 'video',
          }).project,
          result: undefined,
        };
      },
      { expectedRevision: 0 },
    );
    await ready;
    try {
      await expect(apply()).rejects.toThrow('locked');
    } finally {
      release();
    }
    await writer;
    await expect(apply()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(
      (await readProjectFile(path)).tracks.map((track) => track.id),
    ).toEqual(['first']);
    expect(await fs.readdir(directory)).toEqual(['project.json']);
  });

  it('detects an outside replacement during an edit and retains the newer file', async () => {
    const newer = createProject({ name: 'Newer outside writer' });
    const bytes = serializeProject(newer);
    await expect(
      updateProjectFile(path, async (project) => {
        await fs.writeFile(join(directory, 'new.json'), bytes);
        await fs.rename(join(directory, 'new.json'), path);
        return {
          project: addTrack(project, { name: 'Stale', type: 'video' }).project,
          result: undefined,
        };
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect(await fs.readdir(directory)).toEqual(['project.json']);
  });

  it('retains both state and history and cleans artifacts when atomic publication fails', async () => {
    await apply();
    const bytes = await fs.readFile(path, 'utf8');
    vi.mocked(fs.rename).mockRejectedValueOnce(
      new Error('Injected rename failure'),
    );
    await expect(
      updateProjectFile(
        path,
        async (project) => ({ project: undoEdit(project), result: undefined }),
        { history: 'restore' },
      ),
    ).rejects.toThrow('Injected rename failure');
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect(await fs.readdir(directory)).toEqual(['project.json']);
  });
});

it('preserves multiple session transactions atomically and rejects regressed revisions, identity changes and broken history', async () => {
  const baseline = await readProjectFile(path);
  const first = executeTransaction(baseline, {
    expectedRevision: 0,
    operations: [
      { type: 'track.add', id: 'v1', name: 'Video', mediaType: 'video' },
    ],
  }).project;
  const second = executeTransaction(first, {
    expectedRevision: 1,
    operations: [
      { type: 'track.add', id: 'a1', name: 'Audio', mediaType: 'audio' },
    ],
  }).project;
  const bytes = await fs.readFile(path, 'utf8');
  const regressed = structuredClone(second);
  regressed.editing!.revision = 0;
  const changedId = structuredClone(second);
  changedId.metadata.id = 'other-project';
  const broken = structuredClone(second);
  broken.editing!.undo[1]!.before.metadata.name = 'Broken chain';
  for (const project of [regressed, changedId, broken]) {
    await expect(
      updateProjectFile(path, async () => ({ project, result: null }), {
        expectedRevision: 0,
        history: 'preserve',
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  }
  vi.mocked(fs.rename).mockRejectedValueOnce(
    new Error('Synthetic save failure'),
  );
  await expect(
    updateProjectFile(path, async () => ({ project: second, result: null }), {
      expectedRevision: 0,
      history: 'preserve',
    }),
  ).rejects.toThrow('Synthetic save failure');
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  await updateProjectFile(
    path,
    async () => ({ project: second, result: null }),
    { expectedRevision: 0, history: 'preserve' },
  );
  expect(await readProjectFile(path)).toEqual(second);
  expect(getEditHistory(await readProjectFile(path)).undo).toHaveLength(2);
  expect(await fs.readdir(directory)).toEqual(['project.json']);
});
