import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './helpers.js';

test('reviews consecutive definition builds and keeps the last playable revision on error', async () => {
  test.setTimeout(60_000);
  const fixtures = resolve('tests/fixtures/generated');
  const directory = await mkdtemp(join(fixtures, 't46-desktop-'));
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
    await workspace.getByRole('button', { name: 'Close definition' }).click();
    await expect(page.getByLabel('Project workspace')).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
