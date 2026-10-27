import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import desktopConfig from '../../apps/desktop/electron.vite.config.js';
import { launchDesktop } from './helpers.js';

const requireDesktop = createRequire(
  new URL('../../apps/desktop/package.json', import.meta.url),
);
const {
  createServer,
}: typeof import('../../apps/desktop/node_modules/vite/dist/node/index.js') =
  await import(requireDesktop.resolve('vite'));
const root = resolve('tests/fixtures/generated');
const audioFile = join(root, 'audio-tone.wav');
const imageFile = join(root, 'still.png');
const available = await Promise.all(
  [audioFile, imageFile].map((path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  ),
);

test('development StrictMode preserves audio playback and cleans up replaced sources', async () => {
  test.setTimeout(60000);
  test.skip(available.includes(false), 'Generate synthetic fixtures first.');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't19-dev-'));
  const server = await createServer({
    ...desktopConfig({ command: 'serve', mode: 'development' }).renderer,
    configFile: false,
    root: resolve('apps/desktop/src/renderer'),
    cacheDir: join(directory, 'vite-cache'),
    logLevel: 'error',
  });
  let application: ElectronApplication | undefined;
  try {
    await server.listen();
    const desktop = await launchDesktop({
      ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173',
    });
    application = desktop.application;
    const { page } = desktop;
    // Observe actual StrictMode effect cleanup without replaying hooks in the test.
    await page.addInitScript(() => {
      const removeAttribute = Element.prototype.removeAttribute;
      Element.prototype.removeAttribute = function (name) {
        if (this instanceof HTMLAudioElement && name === 'src')
          this.dataset.sourceCleanups = String(
            Number(this.dataset.sourceCleanups ?? 0) + 1,
          );
        return removeAttribute.call(this, name);
      };
    });
    await page.reload();
    await application.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: paths,
        });
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      },
      [audioFile, imageFile],
    );
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Import media', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Media assets (2)' }),
    ).toBeVisible();
    const audioAsset = page
      .locator('.asset-list')
      .getByRole('button', { name: /audio-tone/ });
    await audioAsset.click();
    const audio = page.locator('audio');
    await expect
      .poll(async () =>
        Number(await audio.getAttribute('data-source-cleanups')),
      )
      .toBeGreaterThan(0);
    await expect(audio).toHaveAttribute('src', /opencut:\/\/media/);
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await audio.evaluate((element: HTMLAudioElement) => element.play());
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.currentTime),
      )
      .toBeGreaterThan(0.05);
    await page
      .getByRole('tab', { name: 'Project viewer', exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(true);
    await page
      .getByRole('tab', { name: 'Source preview', exact: true })
      .click();
    const oldAudio = await audio.elementHandle();
    if (!oldAudio) throw new Error('Missing audio element');
    await page
      .locator('.asset-list')
      .getByRole('button', { name: /still.png/ })
      .click();
    await expect(page.locator('.simple-source-preview img')).toBeVisible();
    expect(await oldAudio.getAttribute('src')).toBeNull();
    expect(
      await oldAudio.evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(true);
    await audioAsset.click();
    await expect(audio).toHaveAttribute('src', /opencut:\/\/media/);
    await audio.evaluate((element: HTMLAudioElement) => element.play());
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.currentTime),
      )
      .toBeGreaterThan(0.05);
  } finally {
    await application?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
