import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, openProject } from '@opencut/sdk';

const root = resolve('tests/fixtures/generated');
const cli = resolve('apps/cli/dist/index.js');
let directory: string;
let path: string;
beforeEach(async () => {
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, 't30-sdk-'));
  path = join(directory, 'project.json');
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

const videoTrack = {
  type: 'track.add',
  id: 'video',
  name: 'Video',
  mediaType: 'video',
} as const;
const offlineAsset = {
  id: 'offline',
  name: 'Offline video',
  mediaTypes: ['video'],
  file: { type: 'relative', path: 'offline.mp4' },
};

async function seedOffline() {
  const editor = await createProject(path, { name: 'Offline' });
  await editor.save();
  const project = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify({ ...project, assets: [offlineAsset] }));
}

describe('public SDK', () => {
  it('stages exact edits and persists one history step, with dry-run and undo/redo', async () => {
    await seedOffline();
    const initial = await readFile(path, 'utf8');
    const editor = await openProject(path, { expectedRevision: 0 });
    const { project } = editor;
    project.apply(videoTrack, {
      type: 'clip.add',
      id: 'left',
      assetId: 'offline',
      trackId: 'video',
      at: 1,
      in: 2,
      out: 12,
    });
    expect(() =>
      project.apply(
        { type: 'clip.move', id: 'left', at: 2 },
        { type: 'clip.trim', id: 'left', out: 1 },
      ),
    ).toThrow('Operation 2 (clip.trim) failed');
    expect(project.inspect().clips[0]?.timelineStart).toEqual({
      numerator: 1,
      denominator: 30,
    });
    project.apply(
      { type: 'clip.trim', id: 'left', out: 10 },
      { type: 'clip.split', id: 'left', at: 5, rightId: 'right' },
      { type: 'clip.move', id: 'right', at: 10 },
      { type: 'clip.audio', id: 'left', volume: 0.4 },
      { type: 'clip.visual', id: 'right', opacity: 0.5 },
    );
    expect(project.inspectTimeline(10).activeClips[0]).toMatchObject({
      id: 'right',
      sourceTime: { numerator: 1, denominator: 5 },
    });
    expect(await project.checkMedia()).toMatchObject([
      { assetId: 'offline', status: 'missing' },
    ]);
    expect(() => project.removeMedia('offline')).toThrow('referenced');
    const inspected = project.inspect();
    inspected.clips.splice(0);
    expect(project.inspect().clips).toHaveLength(2);
    expect(await editor.save({ dryRun: true })).toMatchObject({
      baseRevision: 0,
      revision: 1,
      changed: true,
      dryRun: true,
    });
    expect(await readFile(path, 'utf8')).toBe(initial);
    await editor.save({ label: 'Assemble' });
    expect(project.history().undo).toMatchObject([{ label: 'Assemble' }]);

    const reopened = await openProject(path);
    expect(reopened.project.inspect().clips).toMatchObject([
      { id: 'left', volume: 0.4 },
      { id: 'right', visual: { opacity: 0.5 } },
    ]);
    reopened.project.undo();
    expect(reopened.project.inspect().clips).toEqual([]);
    expect(() => reopened.project.apply(videoTrack)).toThrow('pending undo');
    expect((await reopened.save()).revision).toBe(2);
    reopened.project.redo();
    expect((await reopened.save()).revision).toBe(3);
    expect(reopened.project.inspect().clips).toHaveLength(2);
    reopened.project.apply(
      { type: 'clip.remove', id: 'left' },
      { type: 'clip.remove', id: 'right' },
      { type: 'track.remove', id: 'video' },
    );
    reopened.project.removeMedia('offline');
    await reopened.save();
    expect((await openProject(path)).project.inspect()).toMatchObject({
      assets: [],
      clips: [],
      tracks: [],
      revision: 4,
    });
  });

  it('checks revisions and exact content and keeps redo on net no-op saves', async () => {
    const created = await createProject(path, { name: 'Conflict' });
    created.project.apply(videoTrack);
    await created.save();
    const editor = await openProject(path);
    const stale = await openProject(path);
    editor.project.undo();
    await editor.save();
    stale.project.apply({ ...videoTrack, id: 'second' });
    await expect(stale.save()).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      openProject(path, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const before = await readFile(path, 'utf8');
    editor.project.apply(videoTrack, { type: 'track.remove', id: 'video' });
    expect(await editor.save()).toMatchObject({ changed: false, revision: 2 });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(editor.project.history().redo).toHaveLength(1);
    await writeFile(
      path,
      before.replace('"name": "Conflict"', '"name": "Replaced"'),
    );
    await expect(editor.save()).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
  });

  it('keeps create exclusive, including competing saves and symlinks', async () => {
    const first = await createProject(path, { name: 'First' });
    const second = await createProject(path, { name: 'Second' });
    expect(await first.save({ dryRun: true })).toMatchObject({
      created: true,
      revision: 0,
      dryRun: true,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const results = await Promise.allSettled([first.save(), second.save()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'WRITE_FAILED' } });
    const alias = join(directory, 'alias.json');
    await symlink(join(directory, 'absent.json'), alias);
    await expect(createProject(alias, { name: 'Third' })).rejects.toMatchObject(
      { code: 'WRITE_FAILED' },
    );
  });
});

describe('TypeScript runner', () => {
  async function script(body: string) {
    const file = join(directory, 'script.mts');
    await writeFile(file, body);
    return file;
  }
  const run = (file: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [cli, 'run', file, '--project', path, '--json', ...args],
      { encoding: 'utf8', cwd: directory },
    );

  it('loads async ESM scripts from another working directory, stages creation and emits one result', async () => {
    const file = await script(`
      import type { OpenCutScript } from '@opencut/sdk';
      console.log('loaded');
      const run: OpenCutScript = async ({project, args}) => {
        await Promise.resolve();
        project.apply(${JSON.stringify(videoTrack)});
        console.info('edited');
        return {args, tracks: project.inspect().tracks};
      };
      export default run;
    `);
    const dryRun = run(
      file,
      '--create',
      'Runner',
      '--dry-run',
      '--',
      '--custom',
      'two words',
    );
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      ok: true,
      created: true,
      dryRun: true,
      revision: 1,
      result: { args: ['--custom', 'two words'] },
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = run(file, '--create', 'Runner');
    expect(saved.status, saved.stderr).toBe(0);
    expect(saved.stderr).toBe('loaded\nedited\n');
    expect(JSON.parse(saved.stdout)).toMatchObject({
      scriptVersion: 1,
      created: true,
      changed: true,
      revision: 1,
    });
    expect((await openProject(path)).project.inspect().tracks).toMatchObject([
      { id: 'video' },
    ]);
    expect(run(file, '--create', 'Duplicate').status).toBe(1);
    const undo = await script('export default ({project}) => project.undo();');
    expect(
      JSON.parse(run(undo, '--expected-revision', '1').stdout),
    ).toMatchObject({ result: null, revision: 2 });
    expect((await openProject(path)).project.inspect().tracks).toEqual([]);
  });

  it.each([
    ['throw new Error("bad load");', 'SCRIPT_LOAD_FAILED'],
    ['export default 42;', 'INVALID_SCRIPT'],
    [
      `export default async ({project}) => { project.apply(${JSON.stringify(videoTrack)}); throw new Error("bad callback"); };`,
      'SCRIPT_FAILED',
    ],
    [
      `export default ({project}) => { project.apply(${JSON.stringify(videoTrack)}); return { n: 1n }; };`,
      'INVALID_SCRIPT_RESULT',
    ],
  ])(
    'reports script failures and leaves projects unchanged',
    async (body, code) => {
      await seedOffline();
      const before = await readFile(path, 'utf8');
      const result = run(await script(body));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(await readFile(path, 'utf8')).toBe(before);
      await rm(path);
      expect(
        run(await script(body), '--create', 'Failed creation').status,
      ).toBe(1);
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('validates arguments and blocks SDK outputs during a dry run', async () => {
    const output = join(directory, 'dry.png');
    const file = await script(
      'export default ({project, args}) => project.previewFrame(0, args[0]);',
    );
    const bad = spawnSync(process.execPath, [cli, 'run', file, '--json'], {
      encoding: 'utf8',
    });
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stderr).error.code).toBe('INVALID_ARGUMENTS');
    const result = run(file, '--create', 'Dry', '--dry-run', '--', output);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('DRY_RUN_OUTPUT');
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    const help = execFileSync(process.execPath, [cli, '--json', 'run', '-h'], {
      encoding: 'utf8',
    });
    expect(JSON.parse(help).commands[0]).toMatchObject({
      name: 'run',
      resultSchema: 'run',
    });
  });

  it('cancels a waiting async script before publishing its edits', async () => {
    await seedOffline();
    const before = await readFile(path, 'utf8');
    const file = await script(`
      import { setTimeout } from 'node:timers/promises';
      export default async ({ project, signal }) => {
        project.apply(${JSON.stringify(videoTrack)});
        console.log('ready');
        await setTimeout(5000, undefined, { signal });
      };
    `);
    const child = execFile(process.execPath, [
      cli,
      'run',
      file,
      '--project',
      path,
      '--json',
    ]);
    const finished = once(child, 'close');
    let stderr = '';
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr === 'ready\n') child.kill('SIGTERM');
    });
    expect(await finished).toEqual([143, null]);
    expect(JSON.parse(stderr.trim().split('\n').at(-1)!)).toMatchObject({
      error: { code: 'SCRIPT_CANCELLED' },
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
