import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  symlink,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { probeMedia } from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import {
  createProject,
  getEditHistory,
  projectRevision,
  undoEdit,
  redoEdit,
} from '@opencut/core';
import {
  prepareMediaAsset,
  readProjectFile,
  updateProjectFile,
  writeProjectFile,
} from '@opencut/core/node';
vi.mock('@opencut/media', async (original) => ({
  ...(await original<typeof import('@opencut/media')>()),
  probeMedia: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'opencut-library-')));
  vi.mocked(probeMedia).mockImplementation(async (path) => {
    if (path.endsWith('.txt')) throw new Error('Invalid synthetic media');
    return {
      path,
      video: {
        width: 100,
        height: 100,
        codec: 'h264',
        frameRate: 30,
        frameRateRatio: '30/1',
      },
      audio: null,
      formatName: 'mp4',
      durationSeconds: 2,
      hasAudio: false,
    } as MediaMetadata;
  });
  await writeFile(join(directory, 'one.mp4'), 'original one');
  await writeFile(join(directory, 'two.mp4'), 'original two');
  await writeFile(join(directory, 'bad.txt'), 'not media');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function importBatch(
  path: string,
  files: string[],
  expectedRevision: number,
) {
  return updateProjectFile(
    path,
    async (project) => {
      for (const file of files)
        project = (await prepareMediaAsset(project, path, file)).project;
      return { project, result: undefined };
    },
    { expectedRevision, label: 'Import media' },
  );
}

it('publishes an atomic media batch, deduplicates aliases and preserves undo/redo after reopening', async () => {
  const path = join(directory, 'project.json');
  const one = join(directory, 'one.mp4');
  const two = join(directory, 'two.mp4');
  const alias = join(directory, 'alias.mp4');
  await writeProjectFile(createProject({ name: 'Library' }), path);
  await symlink(one, alias);
  await importBatch(path, [one, two, alias], 0);
  const imported = await readProjectFile(path);
  expect(imported.assets).toHaveLength(2);
  expect(getEditHistory(imported)).toMatchObject({
    revision: 1,
    undo: [expect.anything()],
  });
  await updateProjectFile(
    path,
    async (project) => ({ project: undoEdit(project), result: null }),
    { expectedRevision: 1, history: 'restore' },
  );
  expect((await readProjectFile(path)).assets).toHaveLength(0);
  await updateProjectFile(
    path,
    async (project) => ({ project: redoEdit(project), result: null }),
    { expectedRevision: 2, history: 'restore' },
  );
  expect((await readProjectFile(path)).assets).toEqual(imported.assets);
  expect(await readFile(one, 'utf8')).toBe('original one');
  expect(await readFile(two, 'utf8')).toBe('original two');
});

it('keeps project bytes when any source in a batch fails or the base revision is stale', async () => {
  const path = join(directory, 'project.json');
  await writeProjectFile(createProject({ name: 'Library' }), path);
  const before = await readFile(path);
  await expect(
    importBatch(
      path,
      [join(directory, 'one.mp4'), join(directory, 'bad.txt')],
      0,
    ),
  ).rejects.toThrow();
  await expect(
    importBatch(path, [join(directory, 'one.mp4')], 1),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await readFile(path)).toEqual(before);
  expect(projectRevision(await readProjectFile(path))).toBe(0);
});
