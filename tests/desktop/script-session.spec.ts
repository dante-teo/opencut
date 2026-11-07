import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { createProject, frameTime } from '@opencut/core';
import { writeProjectFile } from '@opencut/core/node';
import { openProject } from '@opencut/sdk';
import { launchDesktop } from './helpers.js';

test('T30 scripts share atomic history with an open Electron project and reject a stale edit', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't30-session-'));
  const path = join(directory, 'project.json');
  const script = join(directory, 'split.mts');
  const ready = join(directory, 'ready');
  const release = join(directory, 'release');
  await writeFile(
    join(directory, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const project = createProject({ name: 'T30 script session' });
  project.assets = [
    {
      id: 'image',
      name: 'Generated image',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'image.png' },
    },
  ];
  project.tracks = [{ id: 'video', type: 'video', name: 'Video' }];
  project.clips = [
    {
      id: 'left',
      assetId: 'image',
      trackId: 'video',
      timelineStart: frameTime(0, project.settings.frameRate),
      sourceIn: frameTime(0, project.settings.frameRate),
      sourceOut: frameTime(90, project.settings.frameRate),
    },
  ];
  await writeProjectFile(project, path);
  await writeFile(
    script,
    `
    import type { OpenCutScript } from '@opencut/sdk';
    import { access, writeFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    const run: OpenCutScript = async ({project, args, signal}) => {
      const [action, ready, release] = args;
      if (action === 'redo') return project.redo();
      project.apply(
        {type:'clip.split', id:'left', at:30, rightId:'right'},
        {type:'clip.trim', id:'right', out:60}
      );
      if (ready && release) {
        await writeFile(ready, '');
        while (!(await access(release).then(() => true, () => false)))
          await setTimeout(20, undefined, {signal});
      }
      return project.inspect().clips.map(({id}) => id);
    };
    export default run;
  `,
  );
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        resolve('apps/cli/dist/index.js'),
        'run',
        script,
        '--project',
        path,
        '--json',
        ...args,
      ],
      { timeout: 10_000 },
    );
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, path);
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'T30 script session' }),
    ).toBeVisible();
    expect(
      (await (await openProject(path)).project.checkMedia())[0]?.status,
    ).toBe('available');
    const right = page.getByRole('button', {
      name: 'Inspect clip right',
      exact: true,
    });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    const dry = JSON.parse((await run('--dry-run')).stdout);
    expect(dry).toMatchObject({
      dryRun: true,
      revision: 1,
      result: ['left', 'right'],
    });
    await expect(right).toHaveCount(0);
    expect(
      JSON.parse((await run('--expected-revision', '0')).stdout),
    ).toMatchObject({ revision: 1 });
    await expect(right).toBeVisible();
    expect((await openProject(path)).project.history().undo).toHaveLength(1);
    await undo.click();
    await expect(right).toHaveCount(0);
    expect(
      JSON.parse((await run('--expected-revision', '2', '--', 'redo')).stdout),
    ).toMatchObject({ revision: 3 });
    await expect(right).toBeVisible();
    await undo.click();
    await expect(right).toHaveCount(0);

    const result = run(
      '--expected-revision',
      '4',
      '--',
      'split',
      ready,
      release,
    ).then(
      ({ stdout }) => ({ stdout, stderr: '', code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );
    await expect
      .poll(() =>
        access(ready).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await redo.click();
    await expect(right).toBeVisible();
    const saved = await readFile(path, 'utf8');
    await writeFile(release, '');
    const failed = await result;
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(JSON.parse(failed.stderr.trim().split('\n').at(-1)!)).toMatchObject({
      error: { code: 'REVISION_CONFLICT' },
    });
    expect(await readFile(path, 'utf8')).toBe(saved);
    expect((await openProject(path)).project.inspect().revision).toBe(5);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
