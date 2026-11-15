import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { renderVideo } from '@opencut/sdk';
import { launchDesktop } from './helpers.js';
import { assertSimilarExports } from '../integration/conformance-support.js';
import { fixtureDirectory, videoExample } from '../fixture-paths.js';

test('reviews consecutive definition builds and keeps the last playable revision on error', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(fixtureDirectory, 't46-desktop-'));
  const path = join(directory, 'review.video.ts');
  const helper = join(directory, 'review-title.ts');
  const source = (
    await readFile('examples/video/review.video.ts', 'utf8')
  ).replace('../../tests/fixtures/generated', '..');
  await copyFile('examples/video/review-title.ts', helper);
  await writeFile(path, source);
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, path);
    await expect(
      page.getByRole('button', { name: 'Open a project' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    const status = workspace.getByRole('status', {
      name: 'Compilation status',
    });
    await expect(status).toContainText('Preview ready', { timeout: 25_000 });
    const movie = workspace.getByLabel('Compiled timeline preview');
    const initialURL = await movie.getAttribute('src');
    await expect
      .poll(() => movie.evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThan(1);
    await movie.evaluate(async (video: HTMLVideoElement) => video.play());
    await expect
      .poll(() =>
        movie.evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(0.1);
    await movie.evaluate((video: HTMLVideoElement) => {
      video.pause();
      video.currentTime = 0;
    });
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 0 / 47',
    );
    await workspace.getByRole('button', { name: 'Next frame' }).click();
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 1 / 47',
    );
    await expect(
      workspace.getByRole('button', { name: 'Inspect clip first' }),
    ).toBeVisible();

    await writeFile(path, 'export default {');
    await expect(workspace.getByRole('alert')).toContainText('Cannot load');
    await expect(status).toContainText('Showing last valid revision');
    await expect(movie).toHaveAttribute('src', initialURL!);
    await expect(
      workspace.getByRole('heading', { name: 'OpenCut review' }),
    ).toBeVisible();

    await writeFile(
      path,
      source.replace('name: title', "name: 'Obsolete'") +
        '\nawait new Promise((done) => setTimeout(done, 1500));\n',
    );
    await expect(status).toContainText('Compiling');
    await writeFile(
      path,
      source.replace('name: title', "name: title + ' edited'"),
    );
    await expect(
      workspace.getByRole('heading', { name: 'OpenCut review edited' }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(movie).toHaveAttribute('src', initialURL!);
    const secondURL = await movie.getAttribute('src');
    await writeFile(helper, "export const title = 'Helper changed';\n");
    await expect(
      workspace.getByRole('heading', { name: 'Helper changed edited' }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(movie).not.toHaveAttribute('src', secondURL!);
    const output = join(directory, 'review.mp4');
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, output);
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'review.mp4',
    );
    const direct = join(directory, 'foreground.mp4');
    await renderVideo(path, direct);
    await assertSimilarExports(output, direct, {
      width: 320,
      height: 180,
      frameCount: 48,
      fps: 24,
    });
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByRole('alert')).toContainText(
      'Refusing to overwrite',
    );
    await workspace.getByRole('button', { name: 'Close definition' }).click();
    await expect(page.getByLabel('Review workspace')).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('previews and exports a recipe-backed definition', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 't48-desktop-'));
  const path = videoExample('recipes.video.ts');
  const output = join(directory, 'desktop.mp4');
  const { application, page } = await launchDesktop({
    XDG_CACHE_HOME: directory,
  });
  try {
    await application.evaluate(
      ({ dialog }, { path, output }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      },
      { path, output },
    );
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    await expect(
      workspace.getByRole('status', { name: 'Compilation status' }),
    ).toContainText('Preview ready', { timeout: 20_000 });
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 0 / 23',
    );
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'desktop.mp4',
    );
    const direct = join(directory, 'foreground.mp4');
    await renderVideo(path, direct, {
      processing: { cacheDirectory: join(directory, 'opencut', 'recipes-v1') },
    });
    await assertSimilarExports(output, direct, {
      width: 160,
      height: 90,
      frameCount: 24,
      fps: 24,
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
