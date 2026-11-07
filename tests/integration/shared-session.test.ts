import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  addTrack,
  createProject,
  getEditHistory,
  projectRevision,
  undoEdit,
} from '@opencut/core';
import {
  acquireProjectWriter,
  readProjectFile,
  updateProjectFile,
  writeProjectFile,
} from '@opencut/core/node';
import { ProjectSession } from '../../apps/desktop/src/main/project-session.js';
import { requestSession } from '../../packages/core/src/session-transport.js';

let directory: string;
let path: string;
const children: ChildProcess[] = [];
const sessions: ProjectSession[] = [];
const cli = (...args: string[]) =>
  promisify(execFile)(process.execPath, [
    resolve('apps/cli/dist/index.js'),
    ...args,
    '--json',
  ]);
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'opencut-session-')));
  path = join(directory, 'project.json');
  await writeProjectFile(createProject({ name: 'Shared' }), path);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }
  await rm(directory, { recursive: true, force: true });
});
async function launch(mode?: string) {
  const child = fork(
    resolve('tests/integration/session-worker.ts'),
    [path, ...(mode ? [mode] : [])],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.push(child);
  const [reply] = await once(child, 'message');
  expect(reply).toMatchObject({ ok: true });
  return child;
}
function add(name: string, expectedRevision?: number) {
  return updateProjectFile(
    path,
    async (project) => ({
      project: addTrack(project, { name, type: 'video' }).project,
      result: name,
    }),
    { expectedRevision },
  );
}

it('routes unchanged CLI commands, queries and undo/redo through another process and persists history', async () => {
  const child = await launch();
  await cli('track', 'add', path, '--name', 'From CLI', '--type', 'video');
  expect(
    JSON.parse((await cli('timeline', 'list', path)).stdout).tracks,
  ).toHaveLength(1);
  expect(getEditHistory(await readProjectFile(path)).revision).toBe(1);
  await cli('edit', 'undo', path, '--expected-revision', '1');
  expect((await readProjectFile(path)).tracks).toHaveLength(0);
  await cli('edit', 'redo', path, '--expected-revision', '2');
  const ended = once(child, 'exit');
  child.send('close');
  await ended;
  await add('Offline', 3);
  expect(getEditHistory(await readProjectFile(path))).toMatchObject({
    revision: 4,
    undo: [expect.anything(), expect.anything()],
  });
});

it('rejects a prepared stale operation and never drops a successful concurrent edit', async () => {
  await launch();
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = updateProjectFile(path, async (project) => {
    ready();
    await gate;
    return {
      project: addTrack(project, { name: 'Stale', type: 'video' }).project,
      result: null,
    };
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  await started;
  await add('Winner', 0);
  release();
  await rejected;
  expect(
    (await readProjectFile(path)).tracks.map((track) => track.name),
  ).toEqual(['Winner']);
  const outcomes = await Promise.allSettled([add('A', 1), add('B', 1)]);
  expect(
    outcomes.filter((outcome) => outcome.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(projectRevision(await readProjectFile(path))).toBe(2);
});

it('does not submit an aborted edit to the active project session', async () => {
  await launch();
  const before = await readFile(path, 'utf8');
  const controller = new AbortController();
  const reason = new Error('Cancelled before session submission');
  await expect(
    updateProjectFile(
      path,
      async (project) => {
        const changed = addTrack(project, { name: 'Cancelled', type: 'video' });
        controller.abort(reason);
        return { project: changed.project, result: undefined };
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(reason);
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(projectRevision(await readProjectFile(path))).toBe(0);
});

it('notifies the GUI session, shares GUI undo, and keeps dry-run bytes/history unchanged', async () => {
  const events: number[] = [];
  const session = new ProjectSession(
    {
      open: async () => path,
      save: async () => null,
      unsaved: async () => 'discard',
    },
    undefined,
    (state) => events.push(projectRevision(state!.project)),
  );
  sessions.push(session);
  expect(await session.run('open')).toMatchObject({ ok: true });
  await add('Shared');
  expect(events).toEqual([1]);
  const project = await readProjectFile(path);
  expect(
    await session.run('undo', {
      projectId: project.metadata.id,
      expectedRevision: 1,
    }),
  ).toMatchObject({ ok: true, state: { dirty: false } });
  expect(getEditHistory(await readProjectFile(path))).toMatchObject({
    revision: 2,
    redo: [expect.anything()],
  });
  const before = await readFile(path, 'utf8');
  await cli('edit', 'redo', path, '--dry-run', '--expected-revision', '2');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(events).toEqual([1]);
  const error = await cli(
    'edit',
    'undo',
    path,
    '--expected-revision',
    '0',
  ).catch((error: { stderr: string }) => JSON.parse(error.stderr));
  expect(error).toMatchObject({
    ok: false,
    error: { code: 'REVISION_CONFLICT' },
  });
});

it('recovers ownership and durable history after SIGKILL, including a stale socket', async () => {
  const child = await launch();
  await add('Before crash');
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
  await add('After crash', 1);
  await updateProjectFile(
    path,
    async (project) => ({ project: undoEdit(project), result: null }),
    { history: 'restore' },
  );
  expect(
    (await readProjectFile(path)).tracks.map((track) => track.name),
  ).toEqual(['Before crash']);
  await launch();
  expect(projectRevision(await readProjectFile(path))).toBe(3);
});

it('does not silently fall back when the session dies after preparing an edit', async () => {
  const child = await launch();
  await expect(
    updateProjectFile(path, async (project) => {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
      return {
        project: addTrack(project, { name: 'Never committed', type: 'video' })
          .project,
        result: null,
      };
    }),
  ).rejects.toMatchObject({ code: 'SESSION_DISCONNECTED' });
  expect(projectRevision(await readProjectFile(path))).toBe(0);
});

it('reports a lost commit reply without replaying a durably accepted edit', async () => {
  const child = await launch('crash-after-commit');
  const exited = once(child, 'exit');
  await expect(add('Accepted before lost reply', 0)).rejects.toMatchObject({
    code: 'SESSION_DISCONNECTED',
  });
  // Socket closure can precede process exit and release of the OS writer lock.
  await exited;
  const current = await readProjectFile(path);
  expect(projectRevision(current)).toBe(1);
  expect(current.tracks.map((track) => track.name)).toEqual([
    'Accepted before lost reply',
  ]);
  await expect(add('Blind retry', 0)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
});

it('releases a crashed standalone writer without publishing its incomplete transaction', async () => {
  const child = await launch('pending');
  const before = await readFile(path, 'utf8');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  expect(await readFile(path, 'utf8')).toBe(before);
  await add('Recovered', 0);
  expect(projectRevision(await readProjectFile(path))).toBe(1);
});

it('rejects invalid protocol messages and stale session identities without writing', async () => {
  await launch();
  const before = await readFile(path, 'utf8');
  await expect(
    requestSession(path, { version: 99, type: 'read' }),
  ).rejects.toThrow();
  await expect(
    requestSession(path, {
      version: 1,
      type: 'update',
      sessionId: 'previous-session',
      base: 'wrong',
      json: before,
      options: {},
    }),
  ).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  await expect(
    requestSession(path, { version: 1, type: 'read', path: '/etc/passwd' }),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(projectRevision(await readProjectFile(path))).toBe(0);
});

it('keeps OS ownership after failed same-process acquisitions and refuses a second GUI', async () => {
  const writer = await acquireProjectWriter(path);
  try {
    await expect(acquireProjectWriter(path)).rejects.toMatchObject({
      code: 'PROJECT_LOCKED',
    });
    await expect(
      cli('track', 'add', path, '--name', 'Blocked', '--type', 'video'),
    ).rejects.toMatchObject({ code: 1 });
    // Read-only commands do not need ownership, including when no endpoint exists yet.
    expect(
      JSON.parse((await cli('edit', 'history', path)).stdout).revision,
    ).toBe(0);
  } finally {
    await writer.close();
  }
  await launch();
  const session = new ProjectSession({
    open: async () => path,
    save: async () => null,
    unsaved: async () => 'discard',
  });
  sessions.push(session);
  expect(await session.run('open')).toMatchObject({
    ok: false,
    error: expect.stringContaining('locked'),
  });
});

it('canonicalizes directory aliases and rejects symlinked ownership sidecars', async () => {
  const alias = join(directory, 'alias');
  await symlink(directory, alias);
  await launch();
  await cli(
    'track',
    'add',
    join(alias, 'project.json'),
    '--name',
    'Alias',
    '--type',
    'audio',
  );
  expect(projectRevision(await readProjectFile(path))).toBe(1);
  const other = join(directory, 'other.json');
  await writeProjectFile(createProject({ name: 'Other' }), other);
  await symlink(path, `${other}.opencut-lock`);
  await expect(acquireProjectWriter(other)).rejects.toMatchObject({
    code: 'SESSION_SECURITY',
  });
});
