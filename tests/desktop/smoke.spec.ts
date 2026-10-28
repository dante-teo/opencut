import { expect, test } from '@playwright/test';
import { launchDesktop } from './helpers.js';

test('built desktop displays React through the sandboxed bridge', async () => {
  const { application, page } = await launchDesktop();
  try {
    // Let nativeTheme drive Chromium instead of Playwright default light emulation.
    await page.emulateMedia({ colorScheme: null });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(
      page.getByRole('button', { name: 'Start creating' }),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(
      'OpenCut is running · v0.1.0',
    );
    expect(await page.evaluate(() => Object.keys(window.opencut))).toEqual([
      'onProjectChanged',
      'importMedia',
      'importDroppedMedia',
      'onImportProgress',
      'removeAsset',
      'addAssetClip',
      'assetThumbnail',
      'editTimeline',
      'undoProject',
      'redoProject',
      'getProject',
      'createProject',
      'openProject',
      'saveProject',
      'closeProject',
      'getApplicationInfo',
      'openPreview',
      'previewAsset',
      'releasePreview',
      'getPreviewMetrics',
    ]);
    expect(
      await page.evaluate(() =>
        ['require', 'process'].filter((key) => key in window),
      ),
    ).toEqual([]);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const rendererSandboxes = await application.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .filter((metric) => metric.type === 'Tab')
          .map((metric) => metric.sandboxed),
      );
      expect(rendererSandboxes.length).toBeGreaterThan(0);
      expect(rendererSandboxes.every((sandboxed) => sandboxed === true)).toBe(
        true,
      );
    }
    const windowState = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Missing desktop window');
      return {
        fullscreen: window.isFullScreen(),
        resizable: window.isResizable(),
        height: window.getBounds().height,
        contentHeight: window.getContentBounds().height,
      };
    });
    expect(windowState.fullscreen).toBe(false);
    expect(windowState.resizable).toBe(true);
    if (process.platform === 'darwin') {
      expect(windowState.contentHeight).toBe(windowState.height);
    }
    expect(
      await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    ).toBe('system');
    const header = page.locator('header');
    const headerBounds = await header.boundingBox();
    expect(headerBounds?.y).toBe(0);
    expect(headerBounds?.width).toBe(
      await page.evaluate(() => window.innerWidth),
    );
    await expect(header).toHaveCSS('-webkit-app-region', 'drag');
    await expect(header.locator('span').last()).toHaveCSS(
      '-webkit-app-region',
      'drag',
    );

    for (const theme of ['light', 'dark', 'light'] as const) {
      await application.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
      }, theme);
      const background =
        theme === 'dark' ? 'rgb(17, 16, 21)' : 'rgb(243, 242, 247)';
      const foreground =
        theme === 'dark' ? 'rgb(238, 235, 245)' : 'rgb(41, 38, 55)';
      await expect(page.locator('html')).toHaveCSS(
        'background-color',
        background,
      );
      await expect(page.locator('html')).toHaveCSS('color', foreground);
      await expect
        .poll(() =>
          application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]
              ?.getBackgroundColor()
              .toLowerCase()
              .slice(-6),
          ),
        )
        .toBe(theme === 'dark' ? '111015' : 'f3f2f7');
      await page.screenshot({
        path: 'test-results/desktop-' + theme + '.png',
        animations: 'disabled',
      });
    }
    await application.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system';
    });
    await page.screenshot({ path: 'test-results/desktop.png' });
    if (process.platform === 'darwin') {
      await test.step('reopens the macOS window with its core bridge intact', async () => {
        const closed = page.waitForEvent('close');
        await application.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.close();
        });
        await closed;
        const nextWindow = application.waitForEvent('window');
        await application.evaluate(({ app }) => app.emit('activate'));
        const reopened = await nextWindow;
        reopened.on('pageerror', (error) => errors.push(error.message));
        await expect(reopened.getByRole('status')).toHaveText(
          'OpenCut is running · v0.1.0',
        );
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});

test('studio panels stay reachable at compact, default and large window sizes', async () => {
  const { application, page } = await launchDesktop();
  try {
    for (const [width, height] of [
      [640, 480],
      [1080, 720],
      [1440, 900],
    ]) {
      await application.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(
            size.width!,
            size.height!,
          );
        },
        { width, height },
      );
      await expect(
        page.getByRole('button', { name: 'Start creating' }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const timelineBounds = await page
        .locator('.timeline-panel')
        .boundingBox();
      const workspaceBounds = await page.locator('.workspace').boundingBox();
      expect(
        workspaceBounds!.y + workspaceBounds!.height,
      ).toBeGreaterThanOrEqual(timelineBounds!.y + timelineBounds!.height);
      const panels = page.locator('.editor-panels');
      await panels.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect(
        page.getByRole('heading', { name: 'Inspector', exact: true }),
      ).toBeInViewport();
      await panels.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await expect(
        page.getByRole('searchbox', { name: 'Search media' }),
      ).toBeInViewport();
      await page.screenshot({
        path: `test-results/studio-${width}.png`,
        animations: 'disabled',
      });
    }
    await page.getByRole('button', { name: 'Start creating' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Project name', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  } finally {
    await application.close();
  }
});
