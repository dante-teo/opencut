import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createProject } from '@opencut/core';
import { importMediaAsset, writeProjectFile } from '@opencut/core/node';
import { launchDesktop } from './helpers.js';

const fixture = resolve('tests/fixtures/generated/video-medium.mp4');
const available = await access(fixture).then(
  () => true,
  () => false,
);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function openProject(
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
    page.getByRole('heading', { name: 'Preview integration', exact: true }),
  ).toBeVisible();
}
async function urlStatus(application: ElectronApplication, url: string) {
  return application.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url, { headers: { Range: 'bytes=0-15' } });
    await response.arrayBuffer();
    return response.status;
  }, url);
}
async function setupProject(directory: string) {
  const path = join(directory, 'project.json');
  await writeProjectFile(
    createProject({
      name: 'Preview integration',
      settings: {
        width: 1080,
        height: 1920,
        frameRate: { numerator: 24, denominator: 1 },
      },
    }),
    path,
  );
  await importMediaAsset(path, fixture);
  await importMediaAsset(
    path,
    resolve('tests/fixtures/generated/video-short.mp4'),
  );
  await importMediaAsset(
    path,
    resolve('tests/fixtures/generated/audio-tone.wav'),
  );
  return path;
}

test('imported source transport, project timing, scoped shortcuts and lifecycle', async () => {
  test.skip(!available, 'Generate the existing synthetic fixture set first.');
  const directory = await mkdtemp(resolve('tests/fixtures/generated/t16-'));
  const path = await setupProject(directory);
  const original = await readFile(path, 'utf8');
  const sourceHash = hash(await readFile(fixture));
  // Imported metadata and project-rate stepping do not require ffprobe at preview time.
  const { application, page } = await launchDesktop({
    PATH: '/opencut/no-optional-tools',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await openProject(application, page, path);
    const select = (name: string) =>
      page
        .locator('.asset-list')
        .getByRole('button', { name: new RegExp(name) })
        .click();
    await select('video-medium');
    const player = page.getByRole('region', { name: 'Video preview player' });
    const play = page.getByRole('button', { name: 'Play', exact: true });
    await expect(play).toBeEnabled();
    // The source and transport must fit together in the default desktop viewport.
    const viewport = (await page.locator('.source-viewer').boundingBox())!;
    for (const control of [page.locator('video'), play]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(viewport.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        viewport.y + viewport.height,
      );
    }
    await expect(player).toContainText('Project 24/1 fps');
    const slider = page.getByRole('slider', { name: 'Seek', exact: true });
    await expect(slider).toHaveAttribute('max', '71');
    await slider.fill('24');
    await expect(page.getByTestId('position')).toContainText('Frame 24 ');
    await expect(page.getByTestId('timecode')).toContainText('00:00:01:00');
    await player.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('position')).toContainText('Frame 25 ');
    await page.keyboard.press('.');
    await expect(page.getByTestId('position')).toContainText('Frame 26 ');
    await page.keyboard.press(',');
    await expect(page.getByTestId('position')).toContainText('Frame 25 ');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('position')).toContainText('Frame 0 ');
    await page.keyboard.press('ArrowLeft');
    await expect(play).toBeEnabled();
    await expect(page.getByTestId('position')).toContainText('Frame 0 ');
    await page.keyboard.press('Space');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.2);
    await page.keyboard.press('k');
    await expect(play).toBeEnabled();
    await page.keyboard.press('End');
    await expect(page.getByTestId('position')).toContainText('Frame 71 ');
    await page.keyboard.press('ArrowRight');
    await expect(play).toBeEnabled();
    await slider.fill('24');
    await expect(page.getByTestId('position')).toContainText('Frame 24 ');
    await expect(slider).toBeEnabled();
    await slider.press('ArrowLeft');
    await expect(page.getByTestId('position')).toContainText('Frame 23 ');
    await play.click();
    await page
      .getByRole('tab', { name: 'Project viewer', exact: true })
      .click();
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.paused),
      )
      .toBe(true);
    await page
      .getByRole('tab', { name: 'Source preview', exact: true })
      .click();
    const oldVideo = (await page.locator('video').elementHandle())!;
    const oldURL = (await page.locator('video').getAttribute('src'))!;
    await page.locator('.preview-details > summary').click();
    await page
      .getByRole('button', { name: 'Run performance validation' })
      .click();
    await expect(player).toHaveAttribute('aria-busy', 'true');
    await select('video-short');
    await expect(play).toBeEnabled();
    await expect(player).toContainText('video-short.mp4');
    await expect(page.getByTestId('position')).toContainText('Frame 0 ');
    expect(
      await oldVideo.evaluate((v: HTMLVideoElement) => ({
        paused: v.paused,
        src: v.getAttribute('src'),
        state: v.readyState,
      })),
    ).toEqual({ paused: true, src: null, state: 0 });
    expect(await urlStatus(application, oldURL)).toBe(403);
    const currentURL = (await page.locator('video').getAttribute('src'))!;
    await page.evaluate((url) => window.opencut.releasePreview(url), oldURL);
    expect(await urlStatus(application, currentURL)).toBe(206);
    expect(
      await page
        .locator('.source-viewer')
        .evaluate((element) => element.scrollTop),
    ).toBe(0);
    const denied = await page.evaluate(async () => {
      try {
        await window.opencut.previewAsset('/etc/passwd');
        return false;
      } catch {
        return true;
      }
    });
    expect(denied).toBe(true);
    await expect(page.locator('video')).toHaveCSS('object-fit', 'contain');
    await page.screenshot({ path: 'test-results/t16-library-preview.png' });
    await page
      .getByRole('button', { name: 'Close project', exact: true })
      .click();
    await expect(page.locator('video')).toHaveCount(0);
    expect(await urlStatus(application, currentURL)).toBe(403);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(hash(await readFile(fixture))).toBe(sourceHash);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing, non-video and corrupt assets fail gracefully and allow recovery', async () => {
  test.skip(!available, 'Generate the existing synthetic fixture set first.');
  const directory = await mkdtemp(resolve('tests/fixtures/generated/t16-'));
  const path = await setupProject(directory);
  const damaged = join(directory, 'damaged.mp4');
  await copyFile(fixture, damaged);
  await importMediaAsset(path, damaged);
  const { application, page } = await launchDesktop();
  try {
    await openProject(application, page, path);
    await rm(damaged);
    const damagedButton = page
      .locator('.asset-list')
      .getByRole('button', { name: /damaged/ });
    await damagedButton.click();
    await expect(page.getByRole('alert')).toContainText(
      'Media file is missing',
    );
    await expect(page.locator('video')).toHaveCount(0);
    await writeFile(
      damaged,
      'This is a deliberately corrupted synthetic test copy.',
    );
    await damagedButton.click();
    await expect(page.getByRole('alert')).toContainText('Unable to decode');
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeDisabled();
    await page
      .locator('.asset-list')
      .getByRole('button', { name: /audio-tone/ })
      .click();
    await expect(page.locator('audio')).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);
    // Rapid selection requests must leave only the last selected source authorized.
    await page
      .locator('.asset-list button')
      .evaluateAll((buttons: HTMLButtonElement[]) => {
        for (let i = 0; i < 6; i++) buttons[i % 2]!.click();
        buttons[0]!.click();
      });
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    await expect(page.locator('.player h2')).toHaveText('video-medium.mp4');
    expect(
      await urlStatus(
        application,
        (await page.locator('video').getAttribute('src'))!,
      ),
    ).toBe(206);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
