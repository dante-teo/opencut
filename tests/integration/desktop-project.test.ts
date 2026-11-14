import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addTrack, createProject } from '@opencut/core';
import {
  controlDesktopProject,
  updateProjectFile,
  writeProjectFile,
} from '@opencut/core/node';
import { reviewEndpoint } from '../../packages/core/src/session-transport.js';
import { ProjectSession } from '../../apps/desktop/src/main/project-session.js';

let directory: string;
const sessions: ProjectSession[] = [];
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
  };
  const session = new ProjectSession(dialogs);
  sessions.push(session);
  return { session, dialogs };
}
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-desktop-project-')),
  );
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  await rm(directory, { recursive: true, force: true });
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
      'Expected a media asset ID',
    );
  await expect(session.previewAsset('/etc/passwd')).rejects.toThrow(
    'not in the current project',
  );
  await expect(session.previewAsset('audio')).rejects.toThrow(
    'Media file is missing',
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

it('keeps the current document after canceled, missing, malformed or unsupported opens', async () => {
  const { session, dialogs } = setup();
  const saved = join(directory, 'valid.json');
  await writeProjectFile(createProject(input), saved);
  dialogs.open.mockResolvedValueOnce(saved);
  await session.run('open');
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
});

it('loads an older backup only on explicit reopen and follows its next commit', async () => {
  const { session, dialogs } = setup();
  const path = join(directory, 'review.json');
  const backup = join(directory, 'backup.json');
  const project = createProject(input);
  await writeProjectFile(project, path);
  await writeProjectFile(project, backup);
  const add = (name: string) =>
    updateProjectFile(path, async (current) => ({
      project: addTrack(current, { name, type: 'video' }).project,
      result: undefined,
    }));
  dialogs.open.mockResolvedValue(path);
  const opened = await session.run('open');
  if (!opened.ok || !opened.state) throw new Error('Expected an open project');
  await add('Initial edit');
  const scope = { projectId: project.metadata.id, expectedRevision: 1 };
  await vi.waitFor(() => expect(session.matchesRevision(scope)).toBe(true));
  await rename(backup, path);
  expect(session.matchesRevision(scope)).toBe(true);
  const reopened = await session.run('open');
  expect(reopened).toMatchObject({ ok: true, state: { project, path } });
  if (!reopened.ok || !reopened.state)
    throw new Error('Expected a reopened project');
  expect(reopened.state.view).toBeGreaterThan(opened.state.view);
  await add('New edit');
  await vi.waitFor(async () =>
    expect(await session.run('current')).toMatchObject({
      ok: true,
      state: {
        view: reopened.state!.view,
        project: { tracks: [{ name: 'New edit' }] },
      },
    }),
  );
});

it.skipIf(process.platform === 'win32')(
  'opens and watches a project when its review socket cannot start',
  async () => {
    const path = join(directory, 'socket-unavailable.json');
    const project = createProject(input);
    await writeProjectFile(project, path);
    const address = await reviewEndpoint(path);
    await mkdir(address); // The server cannot unlink a directory in place of its socket.
    const session = new ProjectSession(
      { open: async () => path },
      undefined,
      async () => 'ready',
    );
    sessions.push(session);
    try {
      expect(await session.run('open')).toMatchObject({
        ok: true,
        state: { path },
      });
      await updateProjectFile(path, async (current) => ({
        project: addTrack(current, { name: 'Headless', type: 'video' }).project,
        result: undefined,
      }));
      await vi.waitFor(() =>
        expect(
          session.matchesRevision({
            projectId: project.metadata.id,
            expectedRevision: 1,
          }),
        ).toBe(true),
      );
    } finally {
      await rmdir(address);
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'claims the review socket on reopen after the other viewer closes',
  async () => {
    const path = join(directory, 'shared.json');
    await writeProjectFile(createProject(input), path);
    const dialogs = { open: async () => path };
    const first = new ProjectSession(dialogs, undefined, async () => 'first');
    const second = new ProjectSession(dialogs, undefined, async () => 'second');
    sessions.push(first, second);
    expect(await first.run('open')).toMatchObject({ ok: true });
    expect(await second.run('open')).toMatchObject({ ok: true });
    await expect(
      controlDesktopProject(path, { action: 'status' }),
    ).resolves.toBe('first');
    await first.dispose();
    await expect(
      controlDesktopProject(path, { action: 'status' }),
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    expect(await second.run('open')).toMatchObject({ ok: true });
    await expect(
      controlDesktopProject(path, { action: 'status' }),
    ).resolves.toBe('second');
  },
);

it('rejects snapshot outputs requested by a previous view at the same revision', async () => {
  const path = join(directory, 'project.json');
  const replacement = join(directory, 'replacement.json');
  const project = createProject(input);
  await writeProjectFile(project, path);
  await writeProjectFile(
    { ...project, metadata: { ...project.metadata, name: 'Replacement' } },
    replacement,
  );
  const pick = vi.fn(async () => null);
  const session = new ProjectSession({
    open: async () => path,
    saveProjectCopy: pick,
    savePreviewFrame: pick,
    exportSubtitles: pick,
  });
  sessions.push(session);
  const original = await session.run('open');
  if (!original.ok || !original.state)
    throw new Error('Expected an open project');
  const scope = {
    view: original.state.view,
    projectId: project.metadata.id,
    expectedRevision: 0,
  };
  await rename(replacement, path);
  const reopened = await session.run('open');
  if (!reopened.ok || !reopened.state)
    throw new Error('Expected a reopened project');
  expect(() => session.captureExport(scope)).toThrow('Project changed');
  expect(
    session.captureExport({ ...scope, view: reopened.state.view }).project
      .metadata.name,
  ).toBe('Replacement');
  for (const [action, options] of [
    ['copyProject', { bundle: true }],
    ['exportFrame', { at: 0 }],
    ['exportSubtitles', { format: 'srt' }],
  ] as const) {
    expect(await session.run(action, { ...scope, ...options })).toMatchObject({
      ok: false,
    });
  }
  expect(pick).not.toHaveBeenCalled();
});
