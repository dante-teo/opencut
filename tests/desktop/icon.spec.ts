import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './helpers.js';

test('built app loads its branded icon and applies it to the macOS Dock on reopening', async () => {
  const { application, page } = await launchDesktop();
  try {
    await expect(page.locator('.mark img')).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('.mark img')
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    const source = await page.locator('.mark img').getAttribute('src');
    expect(source).toMatch(/assets\/opencut-icon-.*\.png/);
    if (process.platform === 'darwin') {
      const matches = await application.evaluate(
        ({ app, BrowserWindow, nativeImage }, path) => {
          const expected = nativeImage
            .createFromPath(path)
            .toPNG()
            .toString('base64');
          const dock = app.dock!;
          const setIcon = dock.setIcon.bind(dock);
          return new Promise<boolean>((resolve) => {
            dock.setIcon = (image) => {
              setIcon(image);
              dock.setIcon = setIcon;
              const actual =
                typeof image === 'string'
                  ? nativeImage.createFromPath(image)
                  : image;
              resolve(
                !actual.isEmpty() &&
                  actual.toPNG().toString('base64') === expected,
              );
            };
            const window = BrowserWindow.getAllWindows()[0]!;
            window.once('closed', () => app.emit('activate'));
            window.close();
          });
        },
        resolve('apps/desktop/resources/opencut-icon.png'),
      );
      expect(matches).toBe(true);
    }
  } finally {
    await application.close();
  }
});
