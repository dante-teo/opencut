import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { chooseVideo, launchDesktop } from './helpers.js';

const fixture = resolve('tests/fixtures/generated/video-medium.mp4');
const available = await access(fixture).then(
  () => true,
  () => false,
);

test('preview picker, range serving, transport, presented stepping and revocation', async () => {
  test.skip(
    !available,
    'Run pnpm fixtures:generate to enable playback integration coverage.',
  );
  const { application, page } = await launchDesktop();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await chooseVideo(application, page, null);
    await expect(page.locator('video')).toHaveCount(0);
    await chooseVideo(application, page, fixture);
    const url = await page.locator('video').getAttribute('src');
    expect(url).toMatch(/^opencut:\/\/media\/[\da-f-]+$/);
    // Use main's network API so CSP remains media-only, with no renderer fetch privilege.
    const response = await application.evaluate(async ({ net }, url) => {
      const result = await net.fetch(url!, {
        headers: { Range: 'bytes=0-31' },
      });
      return {
        status: result.status,
        range: result.headers.get('content-range'),
        bytes: [...new Uint8Array(await result.arrayBuffer())],
      };
    }, url);
    expect(response.status).toBe(206);
    expect(response.range).toMatch(/^bytes 0-31\//);
    expect(response.bytes).toEqual([
      ...(await readFile(fixture)).subarray(0, 32),
    ]);
    expect(
      await application.evaluate(
        async ({ net }) =>
          (await net.fetch('opencut://media/not-granted')).status,
      ),
    ).toBe(403);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(0.2);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('slider', { name: 'Seek', exact: true }).fill('30');
    await expect(page.getByTestId('position')).toContainText('Frame 30 ');
    await page.getByRole('button', { name: 'Next frame' }).click();
    await expect(page.getByTestId('position')).toContainText('Frame 31 ');
    await page.getByRole('button', { name: 'Previous frame' }).click();
    await expect(page.getByTestId('position')).toContainText('Frame 30 ');
    // Endpoint clamping and repeated same-frame requests must also settle.
    await page.getByRole('slider', { name: 'Seek', exact: true }).fill('89');
    await expect(page.getByTestId('position')).toContainText('Frame 89 ');
    await page.getByRole('button', { name: 'Next frame' }).click();
    await expect(page.getByRole('button', { name: 'Next frame' })).toBeEnabled({
      timeout: 7000,
    });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await chooseVideo(application, page, fixture);
    expect(
      await application.evaluate(
        async ({ net }, url) => (await net.fetch(url!)).status,
        url,
      ),
    ).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});

test('browser playback and seeking work when optional ffprobe is unavailable', async () => {
  test.skip(
    !available,
    'Run pnpm fixtures:generate to enable playback integration coverage.',
  );
  const { application, page } = await launchDesktop({
    PATH: '/opencut/no-optional-tools',
  });
  try {
    await chooseVideo(application, page, fixture);
    await expect(page.getByRole('note')).toContainText('Metadata unavailable');
    await expect(
      page.getByRole('button', { name: 'Next frame' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(0.1);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('slider', { name: 'Seek', exact: true }).fill('1');
    await expect(page.getByTestId('position')).toContainText(
      'Presented 1.000000 s',
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await application.close();
  }
});

test('preview IPC rejects another window even at the trusted application URL', async () => {
  const { application } = await launchDesktop();
  try {
    const rejected = await application.evaluate(
      async ({ BrowserWindow }, preload) => {
        const other = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          await other.loadURL('opencut://app/index.html');
          return (await other.webContents
            .executeJavaScript(`Promise.all(['openPreview', 'getPreviewMetrics', 'previewAsset', 'releasePreview', 'timelinePreview', 'mediaCache', 'timelineFrame'].map(async method => {
          try { await window.opencut[method](); return 'allowed'; }
          catch (error) { return error.message; }
        }))`)) as string[];
        } finally {
          other.destroy();
        }
      },
      resolve('apps/desktop/dist/preload/index.cjs'),
    );
    expect(rejected).toHaveLength(7);
    for (const message of rejected)
      expect(message).toContain('Untrusted IPC sender');
  } finally {
    await application.close();
  }
});

test('seek dragging commits the final pointer position and releases interaction locks', async () => {
  test.skip(
    !available,
    'Run pnpm fixtures:generate to enable playback integration coverage.',
  );
  const { application, page } = await launchDesktop();
  try {
    await chooseVideo(application, page, fixture);
    // Keep physical desktop pointer events from interrupting the CDP drag.
    // Playwright still exercises the real range input and its default behavior.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setIgnoreMouseEvents(true);
    });
    const slider = page.getByRole('slider', { name: 'Seek', exact: true });
    const open = page.getByRole('button', { name: 'Open video', exact: true });
    await slider.fill('6');
    await expect(page.getByTestId('position')).toContainText('Frame 6 ');
    await expect(open).toBeEnabled();
    await slider.scrollIntoViewIfNeeded();
    const bounds = (await slider.boundingBox())!;
    const y = bounds.y + bounds.height / 2;
    const xFor = (fraction: number) =>
      bounds.x + 8 + (bounds.width - 16) * fraction;
    await page.mouse.move(xFor(6 / 89), y);
    await page.mouse.down();
    await page.mouse.move(xFor(0.8), y, { steps: 30 });
    const target = Number(await slider.inputValue());
    expect(target).toBeGreaterThan(65);
    await expect(slider).toBeEnabled();
    await expect(open).toBeDisabled();
    await page.mouse.up();
    await expect(page.getByTestId('position')).toContainText(
      `Frame ${target} `,
    );
    await expect(open).toBeEnabled();

    // Keyboard input retains its immediate seek behavior.
    await slider.press('ArrowLeft');
    await expect(page.getByTestId('position')).toContainText(
      `Frame ${target - 1} `,
    );
    await expect(open).toBeEnabled();

    // Releasing outside the input still commits and releases the import lock.
    await page.mouse.move(xFor((target - 1) / 89), y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + 40, y + 40, { steps: 20 });
    await page.mouse.up();
    await expect(page.getByTestId('position')).toContainText('Frame 89 ');
    await expect(open).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await page.mouse.up();
    await application.close();
  }
});

test('pending import excludes validation and the replacement player can validate normally', async () => {
  test.skip(
    !available,
    'Run pnpm fixtures:generate to enable playback integration coverage.',
  );
  const { application, page } = await launchDesktop();
  try {
    await chooseVideo(application, page, fixture);
    // Gate the picker IPC to hold the renderer's import state, which spans both
    // native selection and ffprobe. No fixed timing or subprocess patch is needed.
    await application.evaluate(({ app, dialog }, path) => {
      dialog.showOpenDialog = () =>
        new Promise((resolveSelection) => {
          (app as import('node:events').EventEmitter).once(
            't04:test-release-selection',
            () => resolveSelection({ canceled: false, filePaths: [path] }),
          );
        });
    }, resolve('tests/fixtures/generated/video-long.mp4'));
    const open = page.getByRole('button', { name: 'Open video', exact: true });
    await page.locator('.preview-details > summary').click();
    const validation = page.getByRole('button', {
      name: 'Run performance validation',
    });
    const slider = page.getByRole('slider', { name: 'Seek', exact: true });
    await open.click();
    await expect
      .poll(() =>
        application.evaluate(({ app }) =>
          app.listenerCount('t04:test-release-selection'),
        ),
      )
      .toBe(1);
    await expect(validation).toBeDisabled();
    await expect(slider).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Next frame' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Previous frame' }),
    ).toBeDisabled();
    await validation.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('.player')).toHaveAttribute('aria-busy', 'false');
    await application.evaluate(({ app }) =>
      app.emit('t04:test-release-selection'),
    );
    await expect(
      page.getByRole('heading', { name: 'video-long.mp4' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    await expect(open).toBeEnabled();
    await expect(page.locator('.player')).toHaveAttribute('aria-busy', 'false');
    await page.locator('.preview-details > summary').click();
    await validation.click();
    await expect(open).toBeDisabled();
    await expect(slider).toBeDisabled();
    await open.evaluate((button: HTMLButtonElement) => button.click());
    const output = page.getByTestId('benchmark-result');
    await expect(output).toBeAttached({ timeout: 20000 });
    expect(
      JSON.parse((await output.textContent())!) as { seek: { count: number } },
    ).toHaveProperty('seek.count', 30);
    await expect(open).toBeEnabled();
    await expect(
      page.getByRole('heading', { name: 'video-long.mp4' }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await application.close();
  }
});
