import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProject, serializeProject, addTrack } from '@opencut/core';
import {
  readProjectFile,
  writeProjectFile,
  updateProjectFile,
} from '@opencut/core/node';
import { ProjectSession } from '../../apps/desktop/src/main/project-session.js';

let directory: string;
const input = {
  name: 'Desktop project',
  settings: {
    width: 1080,
    height: 1920,
    frameRate: { numerator: 30000, denominator: 1001 },
  },
};
function setup() {
  const dialogs = {
    open: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    save: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    unsaved: vi
      .fn<() => Promise<'save' | 'discard' | 'cancel'>>()
      .mockResolvedValue('cancel'),
  };
  return { session: new ProjectSession(dialogs), dialogs };
}
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-desktop-project-')),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('creates with core validation, saves exclusively and reloads through the public core', async () => {
  const { session, dialogs } = setup();
  const path = join(directory, '日本語 #%.opencut.json');
  expect(await session.run('current')).toEqual({
    ok: true,
    state: null,
    canceled: false,
  });
  const created = await session.run('create', input);
  expect(created).toMatchObject({
    ok: true,
    state: { dirty: true, path: null, project: { settings: input.settings } },
  });
  expect(session.needsCloseGuard).toBe(true);
  dialogs.save.mockResolvedValue(path);
  expect(await session.run('save')).toMatchObject({
    ok: true,
    state: { dirty: false, path },
  });
  expect(await readProjectFile(path)).toMatchObject({
    metadata: { name: input.name },
    settings: input.settings,
  });
  const saved = await readFile(path, 'utf8');
  await session.run('save');
  expect(await readFile(path, 'utf8')).toBe(saved);
  expect(session.needsCloseGuard).toBe(false);
});

it('rejects malformed IPC inputs without changing the session', async () => {
  const { session } = setup();
  for (const value of [
    null,
    [],
    {},
    { ...input, path: '/tmp/anything' },
    { ...input, settings: { ...input.settings, width: 0 } },
    {
      ...input,
      settings: {
        ...input.settings,
        frameRate: { numerator: 30, denominator: 0 },
      },
    },
  ]) {
    expect(await session.run('create', value)).toMatchObject({ ok: false });
  }
  expect(await session.run('current')).toMatchObject({ state: null });
  expect(await session.run('save')).toMatchObject({
    ok: false,
    error: expect.stringContaining('Create or open'),
  });
});

it('authorizes only current video IDs and rechecks local media before preview', async () => {
  const { session, dialogs } = setup();
  await expect(session.previewAsset('video')).rejects.toThrow('Open a project');
  const project = createProject(input);
  project.assets = [
    {
      id: 'video',
      name: 'Video',
      file: { type: 'relative', path: 'source.mp4' },
      mediaTypes: ['video'],
    },
    {
      id: 'audio',
      name: 'Audio',
      file: { type: 'relative', path: 'source.wav' },
      mediaTypes: ['audio'],
    },
  ];
  const path = join(directory, 'preview.json');
  await writeProjectFile(project, path);
  await writeFile(join(directory, 'source.mp4'), 'Synthetic video placeholder');
  dialogs.open.mockResolvedValue(path);
  await session.run('open');
  for (const value of [undefined, null, {}, 1])
    await expect(session.previewAsset(value)).rejects.toThrow(
      'Expected a video asset ID',
    );
  await expect(session.previewAsset('/etc/passwd')).rejects.toThrow(
    'not in the current project',
  );
  await expect(session.previewAsset('audio')).rejects.toThrow(
    'Select a video asset',
  );
  expect(await session.previewAsset('video')).toMatchObject({
    path: join(directory, 'source.mp4'),
    asset: { id: 'video' },
  });
  await rm(join(directory, 'source.mp4'));
  await expect(session.previewAsset('video')).rejects.toThrow(
    'Media file is missing',
  );
  await session.run('close');
  await expect(session.previewAsset('video')).rejects.toThrow('Open a project');
});

it('preserves unsaved work on cancel, save cancellation, existing destination and failed write', async () => {
  const { session, dialogs } = setup();
  await session.run('create', input);
  const original = await session.run('current');
  expect(await session.run('close')).toMatchObject({ canceled: true });
  expect(
    await session.run('create', { ...input, name: 'Replacement' }),
  ).toMatchObject({ canceled: true });
  dialogs.unsaved.mockResolvedValue('save');
  expect(await session.run('close')).toMatchObject({ canceled: true });
  const path = join(directory, 'existing.json');
  await writeFile(path, 'precious');
  dialogs.save.mockResolvedValue(path);
  expect(await session.run('close')).toMatchObject({
    ok: false,
    error: expect.stringContaining('Cannot create'),
  });
  expect(await readFile(path, 'utf8')).toBe('precious');
  dialogs.save.mockResolvedValue(join(directory, 'missing', 'new.json'));
  expect(await session.run('save')).toMatchObject({ ok: false });
  expect(await session.run('current')).toEqual(original);
});

it('can save before switching and discard before closing', async () => {
  const { session, dialogs } = setup();
  await session.run('create', input);
  dialogs.unsaved.mockResolvedValue('save');
  dialogs.save.mockResolvedValue(join(directory, 'first.json'));
  expect(
    await session.run('create', { ...input, name: 'Second' }),
  ).toMatchObject({
    state: { project: { metadata: { name: 'Second' } }, dirty: true },
  });
  expect(
    (await readProjectFile(join(directory, 'first.json'))).metadata.name,
  ).toBe(input.name);
  dialogs.unsaved.mockResolvedValue('discard');
  expect(await session.run('close')).toMatchObject({ state: null });
});

it('keeps the current document after canceled, missing, malformed or unsupported opens', async () => {
  const { session, dialogs } = setup();
  await session.run('create', input);
  const original = await session.run('current');
  expect(await session.run('open')).toMatchObject({ canceled: true });
  dialogs.open.mockResolvedValue(join(directory, 'missing.json'));
  expect(await session.run('open')).toMatchObject({
    ok: false,
    error: expect.stringContaining('Cannot read project'),
  });
  const path = join(directory, 'bad.json');
  dialogs.open.mockResolvedValue(path);
  for (const json of ['{bad', '{"schemaVersion":99}', '{}']) {
    await writeFile(path, json);
    expect(await session.run('open')).toMatchObject({ ok: false });
  }
  expect(await session.run('current')).toEqual(original);
  expect(dialogs.unsaved).not.toHaveBeenCalled();
});

it('opens offline assets and preserves history; refuses stale saves after CLI changes', async () => {
  const { session, dialogs } = setup();
  const path = join(directory, 'cli.json');
  const project = createProject({ name: 'CLI project' });
  project.assets.push({
    id: 'offline',
    name: 'Offline video',
    file: { type: 'relative', path: 'missing.mp4' },
    mediaTypes: ['video'],
  });
  await writeProjectFile(project, path);
  await updateProjectFile(path, async (current) => ({
    project: addTrack(current, { id: 'video', name: 'Video', type: 'video' })
      .project,
    result: null,
  }));
  const original = await readFile(path, 'utf8');
  dialogs.open.mockResolvedValue(path);
  expect(await session.run('open')).toMatchObject({
    state: {
      dirty: false,
      media: [{ assetId: 'offline', status: 'missing' }],
      project: { tracks: [{ id: 'video' }], editing: { revision: 1 } },
    },
  });
  expect(await session.run('save')).toMatchObject({ ok: true });
  expect(await readFile(path, 'utf8')).toBe(original);
  const external = await readProjectFile(path);
  external.metadata.name = 'External same-revision edit';
  await writeFile(path, serializeProject(external));
  expect(await session.run('save')).toMatchObject({
    ok: false,
    error: expect.stringContaining('changed on disk'),
  });
  expect((await readProjectFile(path)).metadata.name).toBe(
    'External same-revision edit',
  );
  await writeFile(path, original);
  await session.run('open');
  await updateProjectFile(path, async (current) => ({
    project: addTrack(current, { id: 'audio', name: 'Audio', type: 'audio' })
      .project,
    result: null,
  }));
  expect(await session.run('save')).toMatchObject({ ok: false });
  expect((await readProjectFile(path)).tracks).toHaveLength(2);
});

it('canonicalizes directory aliases and refuses project symlink updates', async () => {
  const { session, dialogs } = setup();
  const alias = join(directory, 'alias');
  await symlink(directory, alias, 'dir');
  await session.run('create', input);
  dialogs.save.mockResolvedValue(join(alias, 'new.json'));
  expect(await session.run('save')).toMatchObject({
    state: { path: join(directory, 'new.json') },
  });
  const link = join(directory, 'link.json');
  await symlink(join(directory, 'new.json'), link);
  dialogs.open.mockResolvedValue(link);
  expect(await session.run('open')).toMatchObject({ ok: true });
  expect(await session.run('save')).toMatchObject({
    ok: false,
    error: expect.stringContaining('symlinks'),
  });
});

it('serializes native dialogs and protects work while a save is pending', async () => {
  const { session, dialogs } = setup();
  await session.run('create', input);
  let finish!: (path: string | null) => void;
  dialogs.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = session.run('save');
  expect(session.needsCloseGuard).toBe(true);
  expect(await session.run('close')).toMatchObject({
    ok: false,
    error: expect.stringContaining('in progress'),
  });
  finish(null);
  expect(await pending).toMatchObject({ canceled: true });
  expect(await session.run('current')).toMatchObject({
    state: { dirty: true },
  });
});
