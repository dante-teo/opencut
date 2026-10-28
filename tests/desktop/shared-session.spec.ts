import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import { writeProjectFile } from '@opencut/core/node';
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

for (const location of ['another file', 'the same path'] as const) {
  test(`opens an older backup at ${location} and edits the restored revision`, async () => {
    const root = resolve('tests/fixtures/generated');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 't22-backup-'));
    const path = join(directory, 'current.json');
    const backupPath =
      location === 'another file' ? join(directory, 'backup.json') : path;
    const older = executeTransaction(
      createProject({ name: 'T22 shared project' }),
      {
        expectedRevision: 0,
        operations: [
          { type: 'track.add', id: 'v1', mediaType: 'video', name: 'Original' },
        ],
      },
    ).project;
    const newer = executeTransaction(older, {
      expectedRevision: 1,
      operations: [
        { type: 'track.add', id: 'v2', mediaType: 'video', name: 'Newer' },
      ],
    }).project;
    await writeProjectFile(newer, path);
    if (backupPath !== path) await writeProjectFile(older, backupPath);
    const { application, page } = await launchDesktop();
    try {
      await open(application, page, path);
      await expect(page.locator('.timeline-row[data-track-id]')).toHaveCount(2);
      if (backupPath === path) await writeFile(path, serializeProject(older));
      await open(application, page, backupPath);
      await expect(page.locator('.timeline-row[data-track-id]')).toHaveCount(1);
      expect((await cli('edit', 'history', backupPath)).revision).toBe(1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.locator('.timeline-row[data-track-id]')).toHaveCount(0);
      const saved = deserializeProject(await readFile(backupPath, 'utf8'));
      expect(projectRevision(saved)).toBe(2);
      expect(saved.tracks).toEqual([]);
      if (backupPath !== path)
        expect(await readFile(path, 'utf8')).toBe(serializeProject(newer));
    } finally {
      await application.close();
    }
  });
}

test('CLI edits preserve timeline zoom, both scroll axes, and snapping preferences', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't22-viewport-'));
  const path = join(directory, 'project.json');
  const project = createProject({ name: 'T22 shared project' });
  project.assets = [
    {
      id: 'asset',
      name: 'Offline',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'missing.mp4' },
    },
  ];
  project.tracks = Array.from({ length: 12 }, (_, index) => ({
    id: `v${index}`,
    type: 'video',
    name: `Video ${index}`,
  }));
  project.clips = [
    {
      id: 'c1',
      assetId: 'asset',
      trackId: 'v0',
      timelineStart: frameTime(900, project.settings.frameRate),
      sourceIn: frameTime(0, project.settings.frameRate),
      sourceOut: frameTime(900, project.settings.frameRate),
    },
  ];
  await writeProjectFile(project, path);
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    const zoom = page.getByLabel('Timeline zoom', { exact: true });
    const snap = page.getByLabel('Snap', { exact: true });
    const threshold = page.getByLabel('Snap threshold pixels', { exact: true });
    await zoom.selectOption('320');
    await snap.uncheck();
    await threshold.fill('13');
    const scroller = page.locator('.timeline-scroll');
    await scroller.evaluate((element) => {
      element.scrollLeft = 500;
      element.scrollTop = 128;
    });
    const scroll = () =>
      scroller.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      }));
    await expect.poll(scroll).toEqual({ left: 500, top: 128 });
    // Hold a real Save reply so a pushed CLI revision arrives before that
    // older reply. It must preserve both the newer content and navigation.
    await application.evaluate(({ app, ipcMain }) => {
      const channel = 'project:save';
      const handler = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
        }
      )._invokeHandlers.get(channel);
      if (!handler) throw new Error('Missing save handler');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
        const reply = await handler(event, ...args);
        await new Promise<void>((resolve) =>
          (app as import('node:events').EventEmitter).once(
            't22:release-save',
            resolve,
          ),
        );
        return reply;
      });
    });
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect
      .poll(() =>
        application.evaluate(({ app }) =>
          app.listenerCount('t22:release-save'),
        ),
      )
      .toBe(1);
    await cli(
      'track',
      'add',
      path,
      '--type',
      'video',
      '--name',
      'From CLI',
      '--expected-revision',
      '0',
    );
    await expect(
      page.getByText('Timeline (13 tracks · 1 clips)', { exact: true }),
    ).toBeVisible();
    await expect(zoom).toHaveValue('320');
    await expect(snap).not.toBeChecked();
    await expect(threshold).toHaveValue('13');
    await expect.poll(scroll).toEqual({ left: 500, top: 128 });
    await application.evaluate(({ app }) => app.emit('t22:release-save'));
    await expect(page.locator('.workspace')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(
      page.getByText('Timeline (13 tracks · 1 clips)', { exact: true }),
    ).toBeVisible();
    await cli('edit', 'undo', path, '--expected-revision', '1');
    await expect(
      page.getByText('Timeline (12 tracks · 1 clips)', { exact: true }),
    ).toBeVisible();
    await expect(zoom).toHaveValue('320');
    await expect(snap).not.toBeChecked();
    await expect(threshold).toHaveValue('13');
    await expect.poll(scroll).toEqual({ left: 500, top: 128 });
  } finally {
    await application.evaluate(({ app }) => app.emit('t22:release-save'));
    await application.close();
  }
});

test('synchronizes a real project in both directions, shares history, and recovers after Electron is killed', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't22-'));
  const path = join(directory, 'project.opencut.json');
  // A real generated PNG, retained with the project for manual inspection.
  await writeFile(
    join(directory, 'red.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const project = createProject({ name: 'T22 shared project' });
  project.assets = [
    {
      id: 'image',
      name: 'Generated image',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'red.png' },
    },
  ];
  project.tracks = [{ id: 'v1', type: 'video', name: 'Video' }];
  project.clips = [
    {
      id: 'c1',
      assetId: 'image',
      trackId: 'v1',
      timelineStart: frameTime(0, project.settings.frameRate),
      sourceIn: frameTime(0, project.settings.frameRate),
      sourceOut: frameTime(90, project.settings.frameRate),
    },
  ];
  await writeProjectFile(project, path);
  let { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    await cli(
      'clip',
      'split',
      path,
      'c1',
      '--at',
      '30',
      '--expected-revision',
      '0',
    );
    await expect(
      page.getByRole('button', { name: /^Inspect clip / }),
    ).toHaveCount(2);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^Inspect clip / }),
    ).toHaveCount(1);
    expect((await cli('edit', 'history', path)).revision).toBe(2);
    await cli('edit', 'redo', path, '--expected-revision', '2');
    await expect(
      page.getByRole('button', { name: /^Inspect clip / }),
    ).toHaveCount(2);
    const clip = page.getByRole('button', {
      name: 'Inspect clip c1',
      exact: true,
    });
    await clip.locator(':scope > rect').first().click();
    const volume = page.getByRole('spinbutton', {
      name: 'Volume',
      exact: true,
    });
    await volume.fill('0.4');
    await volume.press('Enter');
    await expect
      .poll(async () => (await cli('edit', 'history', path)).revision)
      .toBe(4);
    const timeline = await cli('timeline', 'list', path);
    expect(timeline.tracks[0].clips[0].volume).toBe(0.4);
    await page.screenshot({ path: join(directory, 'synchronized.png') });
    const beforeCrash = deserializeProject(await readFile(path, 'utf8'));
    const child = application.process();
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await cli(
      'edit',
      'undo',
      path,
      '--expected-revision',
      String(projectRevision(beforeCrash)),
    );
    expect((await cli('edit', 'history', path)).revision).toBe(5);
    ({ application, page } = await launchDesktop());
    await open(application, page, path);
    await expect(
      page.getByRole('button', { name: /^Inspect clip / }),
    ).toHaveCount(2);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect
      .poll(async () => (await cli('edit', 'history', path)).revision)
      .toBe(6);
    await page
      .getByRole('button', { name: 'Close project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'No project' }),
    ).toBeVisible();
    await cli(
      'track',
      'add',
      path,
      '--type',
      'audio',
      '--name',
      'After close',
      '--expected-revision',
      '6',
    );
    expect((await cli('edit', 'history', path)).revision).toBe(7);
    console.log(`T22 verified project: ${path}`);
  } finally {
    await application.close();
  }
});
