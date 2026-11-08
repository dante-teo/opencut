import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type Page,
  type ElectronApplication,
} from '@playwright/test';
import {
  createProject,
  deserializeProject,
  frameTime,
  projectRevision,
  type Project,
} from '@opencut/core';
import { writeProjectFile } from '@opencut/core/node';
import { launchDesktop, chooseVideo } from './helpers.js';

const root = resolve('tests/fixtures/generated');
const rate = { numerator: 30000, denominator: 1001 };
const command = process.platform === 'darwin' ? 'Meta' : 'Control';
async function fixture(offGrid = false) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't20-'));
  const path = join(directory, 'project.json');
  const project = createProject({
    name: 'T20 clip properties',
    settings: { width: 1920, height: 1080, frameRate: rate },
  });
  project.assets = [
    {
      id: 'asset',
      name: 'Offline video',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'missing.mp4' },
      duration: frameTime(300, rate),
    },
  ];
  project.tracks = [{ id: 'v1', name: 'Video', type: 'video' }];
  project.clips = [
    {
      id: 'c1',
      assetId: 'asset',
      trackId: 'v1',
      timelineStart: frameTime(30, rate),
      sourceIn: frameTime(30, rate),
      sourceOut: frameTime(90, rate),
    },
    {
      id: 'c2',
      assetId: 'asset',
      trackId: 'v1',
      timelineStart: frameTime(180, rate),
      sourceIn: frameTime(0, rate),
      sourceOut: frameTime(60, rate),
    },
  ];
  if (offGrid) project.clips[0]!.sourceIn = { numerator: 1, denominator: 1000 };
  await writeProjectFile(project, path);
  return { directory, path, project };
}
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
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  }, path);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open project', exact: true }),
  ).toBeEnabled();
}
async function current(page: Page): Promise<Project> {
  return page.evaluate(async () => {
    const reply = await window.opencut.getProject();
    if (!reply.ok || !reply.state) throw new Error('No project');
    return reply.state.project;
  });
}
async function property(page: Page, name: string, value: string) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(value);
  await input.press('Enter');
  await expect(page.locator('.workspace')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}
const clip = (page: Page) =>
  page.getByRole('button', { name: 'Inspect clip c1', exact: true });
const select = (page: Page) =>
  clip(page).locator(':scope > rect').first().click();
const blur = (page: Page) => page.locator('h1').click();

async function pendingProperty(application: ElectronApplication, page: Page) {
  await application.evaluate(({ app, ipcMain }) => {
    const channel = 'project:edit';
    // Gate one real handler; keep the production preload, validation and history.
    const handler = (
      ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
      }
    )._invokeHandlers.get(channel);
    if (!handler) throw new Error('Missing project edit handler');
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
      await new Promise<void>((resolve) => {
        (app as import('node:events').EventEmitter).once(
          't20:test-release-edit',
          resolve,
        );
      });
      return handler(event, ...args);
    });
  });
  const opacity = page.getByRole('spinbutton', {
    name: 'Opacity',
    exact: true,
  });
  await opacity.fill('0.6');
  await opacity.press('Enter');
  await expect
    .poll(() =>
      application.evaluate(({ app }) =>
        app.listenerCount('t20:test-release-edit'),
      ),
    )
    .toBe(1);
}
const releaseEdit = (application: ElectronApplication) =>
  application.evaluate(({ app }) => app.emit('t20:test-release-edit'));

test('preserves a pending field draft across an unrelated property commit and still synchronizes undo/redo', async () => {
  const { directory, path } = await fixture();
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    await select(page);
    await pendingProperty(application, page);
    const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
    await x.fill('18.25');
    await releaseEdit(application);
    await expect(page.locator('.workspace')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect(x).toHaveValue('18.25');
    await expect(x).toBeFocused();
    expect((await current(page)).clips[0]!.visual).toEqual({ opacity: 0.6 });
    await x.press('Enter');
    await expect
      .poll(async () => (await current(page)).clips[0]!.visual?.x)
      .toBe(18.25);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(x).toHaveValue('0');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(x).toHaveValue('18.25');
  } finally {
    await releaseEdit(application);
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('T34 preserves subtitle cue and style drafts when applying either form', async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't34-drafts-'));
  const path = join(directory, 'project.json');
  const project = createProject({ name: 'T34 subtitle drafts' });
  project.subtitles = {
    style: { fontSize: 32 },
    cues: [
      {
        id: 'cue',
        text: 'Saved caption',
        start: { numerator: 0, denominator: 1 },
        end: { numerator: 2, denominator: 1 },
      },
    ],
  };
  await writeProjectFile(project, path);
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    const cue = page.getByRole('button', {
      name: 'Inspect subtitle cue',
      exact: true,
    });
    await cue.focus();
    await cue.press('Enter');
    const text = page.getByRole('textbox', {
      name: 'Subtitle text',
      exact: true,
    });
    const start = page.getByRole('textbox', {
      name: 'Start seconds',
      exact: true,
    });
    const duration = page.getByRole('textbox', {
      name: 'Duration seconds',
      exact: true,
    });
    const size = page.getByRole('spinbutton', {
      name: 'Subtitle size',
      exact: true,
    });
    const applyCue = page.getByRole('button', {
      name: 'Apply subtitle',
      exact: true,
    });
    const applyStyle = page.getByRole('button', {
      name: 'Apply subtitle style',
      exact: true,
    });

    await text.fill('Draft caption\n字幕');
    await start.fill('0.25');
    await duration.fill('1.5');
    await size.fill('40');
    await applyStyle.click();
    await expect
      .poll(async () => (await current(page)).subtitles?.style.fontSize)
      .toBe(40);
    await expect(applyCue).toBeEnabled();
    expect((await current(page)).subtitles?.cues).toEqual(
      project.subtitles.cues,
    );
    await expect(text).toHaveValue('Draft caption\n字幕');
    await expect(start).toHaveValue('0.25');
    await expect(duration).toHaveValue('1.5');

    await size.fill('48');
    await applyCue.click();
    await expect
      .poll(async () => (await current(page)).subtitles?.cues[0])
      .toMatchObject({
        text: 'Draft caption\n字幕',
        start: { numerator: 1, denominator: 4 },
        end: { numerator: 7, denominator: 4 },
      });
    expect((await current(page)).subtitles?.style.fontSize).toBe(40);
    await expect(size).toHaveValue('48');
    await applyStyle.click();
    await expect
      .poll(async () => (await current(page)).subtitles?.style.fontSize)
      .toBe(48);
    expect(deserializeProject(await readFile(path, 'utf8')).subtitles).toEqual(
      (await current(page)).subtitles,
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const method of ['picker', 'drop'] as const) {
  test(`imports from ${method} queued behind a property commit using the accepted revision`, async () => {
    const video = join(root, 'video-short.mp4');
    test.skip(
      !(await access(video).then(
        () => true,
        () => false,
      )),
      'Generate synthetic fixtures first.',
    );
    const { directory, path } = await fixture();
    const { application, page } = await launchDesktop();
    try {
      await open(application, page, path);
      await select(page);
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
      }, video);
      await pendingProperty(application, page);
      if (method === 'picker') {
        await page
          .getByRole('button', { name: 'Import media', exact: true })
          .click();
      } else {
        await page.evaluate(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.id = 'queued-import-file';
          input.hidden = true;
          document.body.append(input);
        });
        await page.locator('#queued-import-file').setInputFiles(video);
        await page
          .getByLabel('Media library', { exact: true })
          .evaluate((element) => {
            const input = document.querySelector<HTMLInputElement>(
              '#queued-import-file',
            )!;
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(input.files![0]!);
            element.dispatchEvent(
              new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer,
              }),
            );
          });
      }
      expect(projectRevision(await current(page))).toBe(0);
      await releaseEdit(application);
      await expect(
        page.getByText('1 imported, 0 already in library.', { exact: true }),
      ).toBeVisible();
      const imported = await current(page);
      expect(projectRevision(imported)).toBe(2);
      expect(imported.assets.map((asset) => asset.name)).toContain(
        'video-short.mp4',
      );
      expect(imported.editing?.undo).toHaveLength(2);
      expect(imported.clips[0]!.visual).toEqual({ opacity: 0.6 });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect
        .poll(async () => (await current(page)).assets.length)
        .toBe(1);
      expect((await current(page)).clips[0]!.visual).toEqual({ opacity: 0.6 });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect
        .poll(async () => (await current(page)).clips[0]!.visual)
        .toBeUndefined();
    } finally {
      await releaseEdit(application);
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('edits exact properties, rejects invalid values, coalesces sliders and preserves CLI state and history after reopen', async () => {
  const { directory, path } = await fixture();
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    await expect(
      page.getByRole('button', { name: 'Undo', exact: true }),
    ).toBeDisabled();
    await select(page);
    for (const [name, value] of [
      ['Timeline position', '30'],
      ['Duration', '60'],
      ['Source in', '30'],
      ['Source out', '90'],
      ['Volume', '1'],
      ['Position X', '0'],
      ['Scale', '1'],
      ['Opacity', '1'],
    ])
      await expect(
        page.getByRole('spinbutton', { name: name!, exact: true }),
      ).toHaveValue(value!);
    await property(page, 'Timeline position', '45');
    await expect(
      page.getByRole('spinbutton', { name: 'Timeline position', exact: true }),
    ).toBeFocused();
    await property(page, 'Duration', '75');
    await property(page, 'Source in', '15');
    await property(page, 'Source out', '100');
    await property(page, 'Volume', '0.4');
    await page.getByRole('checkbox', { name: 'Mute', exact: true }).check();
    await expect
      .poll(async () => (await current(page)).clips[0]!.muted)
      .toBe(true);
    await property(page, 'Position X', '-12.5');
    await property(page, 'Position Y', '24');
    await property(page, 'Scale', '1.5');
    await property(page, 'Opacity', '0.6');
    expect((await current(page)).clips[0]).toMatchObject({
      timelineStart: frameTime(45, rate),
      sourceIn: frameTime(15, rate),
      sourceOut: frameTime(100, rate),
      volume: 0.4,
      muted: true,
      visual: { x: -12.5, y: 24, scale: 1.5, opacity: 0.6 },
    });
    const before = await current(page);
    for (const [name, value] of [
      ['Timeline position', '-1'],
      ['Duration', '1.5'],
      ['Volume', '2'],
      ['Opacity', ''],
      ['Scale', '0'],
    ]) {
      await property(page, name!, value!);
      await expect(
        page.getByRole('spinbutton', { name: name!, exact: true }),
      ).toHaveAttribute('aria-invalid', 'true');
      expect(await current(page)).toEqual(before);
      await page
        .getByRole('spinbutton', { name: name!, exact: true })
        .press('Escape');
    }
    for (const [name, value] of [
      ['Timeline position', '150'],
      ['Source out', '301'],
      ['Source in', '100'],
    ]) {
      await property(page, name!, value!);
      await expect(
        page.locator('.project-feedback [role="alert"]'),
      ).toBeVisible();
      expect(await current(page)).toEqual(before);
    }
    // A held numeric adjustment stays a draft until committed.
    const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
    await x.focus();
    await page.keyboard.down('ArrowUp');
    await page.keyboard.up('ArrowUp');
    expect(projectRevision(await current(page))).toBe(projectRevision(before));
    await x.press('Escape');
    const slider = page.getByRole('slider', {
      name: 'Volume slider',
      exact: true,
    });
    await slider.scrollIntoViewIfNeeded();
    const bounds = (await slider.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width * 0.4,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.8,
      bounds.y + bounds.height / 2,
      { steps: 8 },
    );
    expect(projectRevision(await current(page))).toBe(projectRevision(before));
    await page.mouse.up();
    await expect
      .poll(async () => projectRevision(await current(page)))
      .toBe(projectRevision(before) + 1);
    await blur(page);
    await page.keyboard.press(`${command}+z`);
    await expect(
      page.getByRole('spinbutton', { name: 'Volume', exact: true }),
    ).toHaveValue('0.4');
    await page.keyboard.press(`${command}+Shift+z`);
    await expect
      .poll(async () => projectRevision(await current(page)))
      .toBe(projectRevision(before) + 3);
    // Clicking Save while a numeric draft has focus must include that edit.
    await x.fill('18.25');
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    const saved = deserializeProject(await readFile(path, 'utf8'));
    expect(saved.clips[0]!.visual!.x).toBe(18.25);
    expect(saved).toEqual(await current(page));
    const result = spawnSync(
      process.execPath,
      [resolve('apps/cli/dist/index.js'), 'timeline', 'list', path, '--json'],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).tracks[0].clips[0]).toMatchObject({
      id: 'c1',
      volume: saved.clips[0]!.volume,
      muted: true,
      visual: saved.clips[0]!.visual,
    });
    await open(application, page, path);
    expect(await current(page)).toEqual(saved);
    await select(page);
    await expect(
      page.getByRole('spinbutton', { name: 'Position X', exact: true }),
    ).toHaveValue('18.25');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('spinbutton', { name: 'Position X', exact: true }),
    ).toHaveValue('-12.5');
    await page.screenshot({ path: 'test-results/t20-properties.png' });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('routes shortcuts by focus and restores selection across delete, undo and redo', async () => {
  const { directory, path } = await fixture();
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    await select(page);
    const position = page.getByRole('spinbutton', {
      name: 'Timeline position',
      exact: true,
    });
    await position.focus();
    for (const key of [
      's',
      'Space',
      'Backspace',
      'Delete',
      `${command}+z`,
      `${command}+Shift+z`,
      `${command}+s`,
    ])
      await page.keyboard.press(key);
    expect(projectRevision(await current(page))).toBe(0);
    await position.press('Escape');
    const search = page.getByRole('searchbox', {
      name: 'Search media',
      exact: true,
    });
    await search.fill('s');
    await search.press('Backspace');
    expect((await current(page)).clips).toHaveLength(2);
    await blur(page);
    await page.keyboard.press('ArrowRight');
    const ruler = page.getByRole('slider', {
      name: 'Timeline playhead',
      exact: true,
    });
    await expect(ruler).toHaveAttribute('aria-valuenow', '1');
    await ruler.focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight');
    await blur(page);
    await page.keyboard.press('s');
    await expect.poll(async () => (await current(page)).clips.length).toBe(3);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await current(page)).clips.length).toBe(2);
    await expect(clip(page)).toHaveCount(0);
    await page.keyboard.press(`${command}+z`);
    await expect(clip(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('spinbutton', { name: 'Duration', exact: true }),
    ).toHaveValue('30');
    await page.keyboard.press(`${command}+Shift+z`);
    await expect(clip(page)).toHaveCount(0);
    await page.keyboard.press(`${command}+z`);
    await page.keyboard.press(`${command}+s`);
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    expect(deserializeProject(await readFile(path, 'utf8'))).toEqual(
      await current(page),
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves off-grid timing while editing other properties without silent rounding', async () => {
  const { directory, path } = await fixture(true);
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    await select(page);
    await expect(
      page.getByRole('spinbutton', { name: 'Source in', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('spinbutton', { name: 'Duration', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText('1/1000 s → 3003/1000 s', { exact: true }),
    ).toBeVisible();
    await property(page, 'Volume', '0.5');
    expect((await current(page)).clips[0]!.sourceIn).toEqual({
      numerator: 1,
      denominator: 1000,
    });
    await blur(page);
    await page.keyboard.press(`${command}+s`);
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    expect(
      deserializeProject(await readFile(path, 'utf8')).clips[0]!.sourceIn,
    ).toEqual({ numerator: 1, denominator: 1000 });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Space and frame shortcuts operate the active source outside the player without stealing native control keys', async () => {
  const video = join(root, 'video-medium.mp4');
  test.skip(
    !(await access(video).then(
      () => true,
      () => false,
    )),
    'Generate synthetic fixtures first.',
  );
  const { application, page } = await launchDesktop();
  try {
    await chooseVideo(application, page, video);
    await blur(page);
    await page.keyboard.press('Space');
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(0.2);
    await page.keyboard.press('Space');
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    const time = await page
      .locator('video')
      .evaluate((video: HTMLVideoElement) => video.currentTime);
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(time);
    // A new currentTime is observable before presentation settles. Wait until
    // the first step completes before requesting the opposite step.
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    const frame = await page
      .locator('video')
      .evaluate((video: HTMLVideoElement) => video.currentTime);
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeLessThan(frame);
    // currentTime changes before seek presentation settles; disabled controls cannot take focus.
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Play', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(
      page.getByRole('button', { name: 'Pause', exact: true }),
    ).toBeEnabled();
  } finally {
    await application.close();
  }
});
