import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  addTrack,
  createProject,
  commitEdit,
  deserializeProject,
  frameTime,
  serializeProject,
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
import {
  requestSession,
  reviewEndpoint,
} from '../../packages/core/src/session-transport.js';

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

it('shares a project with a full-size font repeated in history and reads legacy inline fonts', async () => {
  const font = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  const original = createProject({ name: 'Font history' });
  const { frameRate } = original.settings;
  original.tracks.push({ id: 'titles', name: 'Titles', type: 'video' });
  original.clips.push({
    id: 'title',
    trackId: 'titles',
    timelineStart: frameTime(0, frameRate),
    sourceIn: frameTime(0, frameRate),
    sourceOut: frameTime(30, frameRate),
    text: { content: 'Title', embeddedFont: font },
  });
  let project = deserializeProject(JSON.stringify(original));
  for (let index = 0; index < 13; index++) {
    const next = structuredClone(project);
    next.clips[0]!.text!.content = `Title ${index}`;
    project = commitEdit(project, next, 'Change title');
  }
  const compact = serializeProject(project);
  expect(compact.indexOf(font)).toBe(compact.lastIndexOf(font));
  expect(compact.length).toBeLessThan(3 * 1024 * 1024);
  expect(deserializeProject(compact)).toEqual(project);
  const fontProject = join(directory, 'fonts.json');
  await writeProjectFile(project, fontProject);
  const session = new ProjectSession({
    open: async () => fontProject,
  });
  sessions.push(session);
  expect(await session.run('open')).toMatchObject({ ok: true });
  expect(projectRevision(await readProjectFile(fontProject))).toBe(13);
  await cli(
    'track',
    'add',
    fontProject,
    '--type',
    'audio',
    '--name',
    'Shared audio',
  );
  const updated = await readProjectFile(fontProject);
  expect(projectRevision(updated)).toBe(14);
  expect(undoEdit(updated).clips[0]!.text!.embeddedFont === font).toBe(true);
}, 30_000);

it('persists CLI commands and history independently of the viewer process', async () => {
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

it('finishes the same edit when the viewer dies during the transaction', async () => {
  const child = await launch();
  await updateProjectFile(path, async (project) => {
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    await ended;
    return {
      project: addTrack(project, { name: 'Committed', type: 'video' }).project,
      result: null,
    };
  });
  expect(projectRevision(await readProjectFile(path))).toBe(1);
});

it('publishes increasing revisions and preserves history across CLI undo and redo', async () => {
  const events: number[] = [];
  const viewer = new ProjectSession({ open: async () => path }, (state) => {
    if (state) events.push(projectRevision(state.project));
  });
  sessions.push(viewer);
  await viewer.run('open');
  await add('External', 0);
  await vi.waitFor(() => expect(events.at(-1)).toBe(1));
  const before = await readFile(path, 'utf8');
  await cli('edit', 'undo', path, '--dry-run', '--expected-revision', '1');
  expect(await readFile(path, 'utf8')).toBe(before);
  await cli('edit', 'undo', path, '--expected-revision', '1');
  await cli('edit', 'redo', path, '--expected-revision', '2');
  await vi.waitFor(() => expect(events.at(-1)).toBe(3));
  expect(events).toEqual([...new Set(events)].sort((a, b) => a - b));
});

it('allows exactly one of two headless writers based on the same revision', async () => {
  await launch();
  const outcomes = await Promise.allSettled([add('A', 0), add('B', 0)]);
  expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(
    1,
  );
  await expect(add('Stale', 0)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  expect(projectRevision(await readProjectFile(path))).toBe(1);
});

it('rejects project mutations on the review control socket', async () => {
  await launch();
  await expect(
    requestSession(await reviewEndpoint(path), {
      version: 1,
      type: 'update',
      json: '{}',
    }),
  ).rejects.toThrow();
  expect(projectRevision(await readProjectFile(path))).toBe(0);
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

it('keeps OS ownership after failed same-process acquisitions and allows a second read-only viewer', async () => {
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
  });
  sessions.push(session);
  expect(await session.run('open')).toMatchObject({
    ok: true,
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
