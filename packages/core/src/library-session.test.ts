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
import { projectRevision } from '@opencut/core';
import { readProjectFile } from '@opencut/core/node';
import { ProjectSession } from '../../../apps/desktop/src/main/project-session.js';
import type {
  ImportProgress,
  ProjectReply,
} from '../../../apps/desktop/src/bridge.js';
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
function state(reply: ProjectReply) {
  if (!reply.ok || !reply.state) throw new Error(JSON.stringify(reply));
  return reply.state;
}
it('imports unsaved batches atomically, reports progress, deduplicates aliases, saves and reopens shared history', async () => {
  const progress: ImportProgress[] = [];
  const path = join(directory, 'saved.json');
  const dialogs = {
    open: async () => path,
    save: async () => path,
    unsaved: async () => 'discard' as const,
    importMedia: vi.fn(async () => [
      join(directory, 'one.mp4'),
      join(directory, 'two.mp4'),
    ]),
  };
  const session = new ProjectSession(dialogs, (value) => progress.push(value));
  const created = state(
    await session.run('create', {
      name: 'Library',
      settings: {
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
      },
    }),
  );
  const request = {
    projectId: created.project.metadata.id,
    expectedRevision: 0,
  };
  const imported = state(await session.run('import', request));
  expect(imported.project.assets).toHaveLength(2);
  expect(
    imported.project.assets.every((asset) => asset.file.type === 'absolute'),
  ).toBe(true);
  expect(progress.map((item) => item.completed)).toEqual([0, 1, 1, 2]);
  expect(projectRevision(imported.project)).toBe(1);
  await symlink(join(directory, 'one.mp4'), join(directory, 'alias.mp4'));
  expect(
    await session.run('import', {
      ...request,
      expectedRevision: 1,
      paths: [join(directory, 'alias.mp4'), join(directory, 'one.mp4')],
    }),
  ).toMatchObject({
    ok: true,
    notice: '0 imported, 2 already in library.',
    state: { project: { editing: { revision: 1 } } },
  });
  expect(
    state(await session.run('undo', { ...request, expectedRevision: 1 }))
      .project.assets,
  ).toEqual([]);
  const restored = state(
    await session.run('redo', { ...request, expectedRevision: 2 }),
  );
  expect(restored.media).toHaveLength(2);
  expect(await session.run('save')).toMatchObject({ ok: true });
  expect((await readProjectFile(path)).assets).toEqual(imported.project.assets);
  await session.run('close');
  await session.run('open');
  const assetId = restored.project.assets[0]!.id;
  const added = state(
    await session.run('addAssetClip', {
      ...request,
      expectedRevision: 3,
      assetId,
      mediaType: 'video',
      at: 30,
    }),
  );
  expect(added.project.tracks).toHaveLength(1);
  expect(added.project.clips).toHaveLength(1);
  expect(
    await session.run('removeAsset', {
      ...request,
      expectedRevision: 4,
      assetId,
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining('referenced') });
  const unused = restored.project.assets[1]!.id;
  expect(
    await session.run('removeAsset', {
      ...request,
      expectedRevision: 4,
      assetId: unused,
    }),
  ).toMatchObject({ ok: true });
  await session.run('save');
  expect((await readProjectFile(path)).assets).toHaveLength(1);
  expect(await readFile(join(directory, 'one.mp4'), 'utf8')).toBe(
    'original one',
  );
  expect(await readFile(join(directory, 'two.mp4'), 'utf8')).toBe(
    'original two',
  );
});
it('retains exact state on failed batches and rejects stale, malformed and competing requests', async () => {
  const session = new ProjectSession({
    open: async () => null,
    save: async () => null,
    unsaved: async () => 'cancel',
  });
  const created = state(
    await session.run('create', {
      name: 'Atomic',
      settings: {
        width: 100,
        height: 100,
        frameRate: { numerator: 30, denominator: 1 },
      },
    }),
  );
  const request = {
    projectId: created.project.metadata.id,
    expectedRevision: 0,
  };
  const before = await session.run('current');
  expect(
    await session.run('import', {
      ...request,
      paths: [join(directory, 'one.mp4'), join(directory, 'bad.txt')],
    }),
  ).toMatchObject({ ok: false, error: 'Invalid synthetic media' });
  expect(await session.run('current')).toEqual(before);
  for (const input of [
    { ...request, paths: ['relative.mp4'] },
    { ...request, paths: [] },
    { ...request, expectedRevision: 4, paths: [join(directory, 'one.mp4')] },
    { ...request, projectId: 'other', paths: [join(directory, 'one.mp4')] },
    { ...request, unexpected: true },
  ])
    expect(await session.run('import', input)).toMatchObject({ ok: false });
  let finish!: (value: MediaMetadata) => void;
  const metadata = await probeMedia(join(directory, 'one.mp4'));
  vi.mocked(probeMedia).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = session.run('import', {
    ...request,
    paths: [join(directory, 'one.mp4')],
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(await session.run('close')).toMatchObject({
    ok: false,
    error: expect.stringContaining('in progress'),
  });
  finish(metadata);
  expect(await pending).toMatchObject({ ok: true });
});

it.each(['available', 'missing'] as const)(
  'refreshes unsaved asset availability through undo/redo when the source is %s',
  async (status) => {
    const session = new ProjectSession({
      open: async () => null,
      save: async () => null,
      unsaved: async () => 'discard',
    });
    const created = state(
      await session.run('create', {
        name: 'Unsaved library',
        settings: {
          width: 100,
          height: 100,
          frameRate: { numerator: 30, denominator: 1 },
        },
      }),
    );
    const request = { projectId: created.project.metadata.id };
    const source = join(directory, 'one.mp4');
    const imported = state(
      await session.run('import', {
        ...request,
        expectedRevision: 0,
        paths: [source],
      }),
    );
    const assetId = imported.project.assets[0]!.id;
    expect(imported.path).toBeNull();
    expect(imported.media).toMatchObject([{ assetId, status: 'available' }]);
    const removed = state(
      await session.run('removeAsset', {
        ...request,
        expectedRevision: 1,
        assetId,
      }),
    );
    expect(removed.project.assets).toEqual([]);
    expect(removed.media).toEqual([]);
    if (status === 'missing') await rm(source);
    for (const expectedRevision of [2, 4]) {
      const restored = state(
        await session.run('undo', { ...request, expectedRevision }),
      );
      expect(restored.path).toBeNull();
      expect(restored.project.assets).toEqual(imported.project.assets);
      expect(restored.media).toMatchObject([{ assetId, path: source, status }]);
      const redone = state(
        await session.run('redo', {
          ...request,
          expectedRevision: expectedRevision + 1,
        }),
      );
      expect(redone.project.assets).toEqual([]);
      expect(redone.media).toEqual([]);
    }
  },
);
