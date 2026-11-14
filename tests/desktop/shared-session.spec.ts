import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  createProject,
  deserializeProject,
  frameTime,
  projectRevision,
  executeTransaction,
  serializeProject,
} from '@opencut/core';
import { controlDesktopProject, writeProjectFile } from '@opencut/core/node';
import { openProject } from '@opencut/sdk';
import { launchDesktop } from './helpers.js';

const cli = async (...args: string[]) =>
  JSON.parse(
    (
      await promisify(execFile)(process.execPath, [
        resolve('apps/cli/dist/index.js'),
        ...args,
        '--json',
      ])
    ).stdout,
  );
async function open(
  application: ElectronApplication,
  page: Page,
  path: string,
) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'T22 shared project', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}

test('enforces track locks on standalone CLI edits with and without Electron', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't39-lock-'));
  const path = join(directory, 'project.json');
  const batch = join(directory, 'unlock.json');
  const original = createProject({ name: 'T22 shared project' });
  original.assets.push({
    id: 'asset',
    name: 'Offline video',
    mediaTypes: ['video'],
    file: { type: 'relative', path: 'source.mp4' },
  });
  const locked = executeTransaction(original, {
    expectedRevision: 0,
    operations: [
      { type: 'track.add', id: 'v', mediaType: 'video', name: 'Video' },
      {
        type: 'clip.add',
        id: 'c',
        assetId: 'asset',
        trackId: 'v',
        at: 0,
        in: 0,
        out: 30,
      },
      { type: 'track.lock', id: 'v', locked: true },
    ],
  }).project;
  const move = ['clip', 'move', path, 'c', '--at', '12'];
  const expectLocked = async () => {
    await expect(cli(...move)).rejects.toHaveProperty(
      'stderr',
      expect.stringMatching(/locked track/i),
    );
    expect(await readFile(path, 'utf8')).toBe(serializeProject(locked));
  };
  try {
    await writeProjectFile(locked, path);
    await expectLocked();
    const { application, page } = await launchDesktop();
    try {
      await open(application, page, path);
      await expectLocked();
      await expect(cli(...move, '--dry-run')).rejects.toHaveProperty(
        'stderr',
        expect.stringMatching(/locked track/i),
      );
      expect((await cli('edit', 'history', path)).revision).toBe(1);
      await writeFile(
        batch,
        JSON.stringify({
          expectedRevision: 1,
          operations: [
            { type: 'track.lock', id: 'v', locked: false },
            { type: 'clip.move', id: 'c', at: 12 },
          ],
        }),
      );
      await cli('edit', 'apply', path, batch);
      const saved = deserializeProject(await readFile(path, 'utf8'));
      expect(saved.clips[0]?.timelineStart).toEqual(
        frameTime(12, original.settings.frameRate),
      );
      expect(projectRevision(saved)).toBe(2);
    } finally {
      await application.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a locked freeze before creating output in CLI and SDK while Electron can inspect it', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't39-freeze-lock-'));
  const path = join(directory, 'project.json');
  const source = join(directory, 'source.mp4');
  const cliOutput = join(directory, 'cli.png');
  const sdkOutput = join(directory, 'sdk.png');
  const original = createProject({ name: 'T22 shared project' });
  original.assets.push({
    id: 'asset',
    name: 'Source video',
    mediaTypes: ['video'],
    file: { type: 'relative', path: 'source.mp4' },
  });
  const locked = executeTransaction(original, {
    expectedRevision: 0,
    operations: [
      { type: 'track.add', id: 'v', mediaType: 'video', name: 'Video' },
      {
        type: 'clip.add',
        id: 'c',
        assetId: 'asset',
        trackId: 'v',
        at: 0,
        in: 0,
        out: 30,
      },
      { type: 'track.lock', id: 'v', locked: true },
    ],
  }).project;
  try {
    await promisify(execFile)('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=s=64x48:r=30:d=1',
      '-c:v',
      'libx264',
      source,
    ]);
    await writeProjectFile(locked, path);
    await expect(
      cli(
        'project',
        'freeze',
        path,
        'c',
        '--at',
        '12',
        '--frames',
        '3',
        '--output',
        cliOutput,
      ),
    ).rejects.toHaveProperty('stderr', expect.stringMatching(/locked/i));
    const editor = await openProject(path);
    await expect(
      editor.project.freezeFrame('c', 12, 3, sdkOutput),
    ).rejects.toThrow('locked');
    expect(editor.project.inspect().clips).toEqual(locked.clips);
    const { application, page } = await launchDesktop({
      OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
    });
    try {
      await open(application, page, path);
      await page
        .getByRole('button', { name: 'Inspect clip c', exact: true })
        .click();
      await controlDesktopProject(path, { action: 'seek', frame: 12 });
      await expect(
        page.getByRole('slider', { name: 'Timeline playhead' }),
      ).toHaveAttribute('aria-valuenow', '12');
      await expect(
        page.getByRole('button', { name: 'Freeze at playhead' }),
      ).toHaveCount(0);
      expect((await cli('edit', 'history', path)).revision).toBe(1);
    } finally {
      await application.close();
    }
    for (const output of [cliOutput, sdkOutput])
      await expect(readFile(output)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await readFile(path, 'utf8')).toBe(serializeProject(locked));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
