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
      page.getByRole('heading', { name: 'Project viewer' }),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(
      'OpenCut is running · v0.1.0',
    );
    expect(await page.evaluate(() => Object.keys(window.opencut))).toEqual([
      'getProject',
      'createProject',
      'openProject',
      'saveProject',
      'closeProject',
      'getApplicationInfo',
      'openPreview',
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
        theme === 'dark' ? 'rgb(16, 20, 22)' : 'rgb(246, 248, 247)';
      const foreground =
        theme === 'dark' ? 'rgb(239, 244, 242)' : 'rgb(25, 40, 32)';
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
        .toBe(theme === 'dark' ? '101416' : 'f6f8f7');
      await page.screenshot({ path: 'test-results/desktop-' + theme + '.png' });
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
