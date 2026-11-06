import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { launchDesktop } from './helpers.js';

let directory: string;
test.beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-desktop-e2e-')),
  );
});
test.afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function saveDialog(
  application: ElectronApplication,
  path: string | null,
) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () =>
      path === null
        ? { canceled: true, filePath: '' }
        : { canceled: false, filePath: path };
  }, path);
}
async function openProject(
  application: ElectronApplication,
  page: Page,
  path: string | null,
) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: path === null,
      filePaths: path ? [path] : [],
    });
  }, path);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open project', exact: true }),
  ).toBeEnabled();
}
async function unsavedDialog(
  application: ElectronApplication,
  response: number,
) {
  await application.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = async () => ({ response, checkboxChecked: false });
  }, response);
}
async function createProject(page: Page, name = 'Desktop portrait') {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByLabel('Width', { exact: true }).fill('1080');
  await page.getByLabel('Height', { exact: true }).fill('1920');
  await page.getByLabel('Frame rate', { exact: true }).fill('30000/1001');
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
const cli = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [resolve('apps/cli/dist/index.js'), ...args],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

test('creates and saves in Electron, reads through CLI, and opens a CLI-created project', async () => {
  const { application, page } = await launchDesktop();
  try {
    await expect(
      page.getByRole('button', { name: 'Start creating' }),
    ).toBeVisible();
    await createProject(page);
    await expect(
      page.getByText('Unsaved changes', { exact: false }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('complementary', { name: 'Inspector' })
        .getByText('30000/1001 fps', { exact: true }),
    ).toBeVisible();
    await saveDialog(application, null);
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Save project', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText('Unsaved changes', { exact: false }),
    ).toBeVisible();
    const path = join(directory, 'portrait #1%.opencut.json');
    await writeFile(path, 'Keep this file');
    await saveDialog(application, path);
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Cannot create project file',
    );
    expect(await readFile(path, 'utf8')).toBe('Keep this file');
    const savedPath = join(directory, 'portrait.json');
    await saveDialog(application, savedPath);
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    const info = cli('project', 'info', savedPath, '--json');
    expect(info.metadata.name).toBe('Desktop portrait');
    expect(info.settings).toEqual({
      width: 1080,
      height: 1920,
      frameRate: { numerator: 30000, denominator: 1001 },
    });
    expect(cli('project', 'validate', savedPath, '--json').valid).toBe(true);
    await page
      .getByRole('button', { name: 'Close project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'No project' }),
    ).toBeVisible();
    const cliPath = join(directory, 'cli.json');
    cli(
      'project',
      'create',
      cliPath,
      '--name',
      'From CLI',
      '--width',
      '1280',
      '--height',
      '720',
      '--fps',
      '24',
      '--json',
    );
    await openProject(application, page, cliPath);
    await expect(
      page.getByRole('heading', { name: 'From CLI', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('complementary', { name: 'Inspector' })
        .getByText('1280 × 720', { exact: true }),
    ).toBeVisible();
    const original = await readFile(cliPath, 'utf8');
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    expect(await readFile(cliPath, 'utf8')).toBe(original);
    await page.screenshot({
      path: 'test-results/desktop-project.png',
      fullPage: true,
    });
  } finally {
    await unsavedDialog(application, 1);
    await application.close();
  }
});

test('shows offline assets and exact track/clip data; failed opens preserve the current project', async () => {
  const { application, page } = await launchDesktop();
  try {
    const documentation = await readFile(
      resolve('docs/PROJECT_FORMAT.md'),
      'utf8',
    );
    const json = /```json\n([\s\S]*?)\n```/.exec(documentation)?.[1];
    expect(json).toBeDefined();
    const path = join(directory, 'populated.json');
    await writeFile(path, json! + '\n');
    await openProject(application, page, path);
    await expect(
      page.getByRole('heading', { name: 'Demo', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Media assets (2)', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Timeline (2 tracks · 2 clips)',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('.asset-list')).toContainText(
      'Media file is missing',
    );
    const library = await page
      .getByRole('complementary', { name: 'Media library' })
      .boundingBox();
    const viewer = await page
      .getByRole('region', { name: 'Viewer', exact: true })
      .boundingBox();
    const inspector = await page
      .getByRole('complementary', { name: 'Inspector' })
      .boundingBox();
    const timeline = await page
      .getByRole('region', { name: 'Timeline', exact: true })
      .boundingBox();
    expect(library!.x + library!.width).toBeLessThanOrEqual(viewer!.x);
    expect(viewer!.x + viewer!.width).toBeLessThanOrEqual(inspector!.x);
    expect(timeline!.y).toBeGreaterThanOrEqual(viewer!.y + viewer!.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight,
      ),
    ).toBe(true);
    await expect(page.locator('.timeline-clip')).toHaveCount(2);
    const camera = page.getByRole('button', {
      name: 'Inspect clip clip-camera',
    });
    const music = page.getByRole('button', { name: 'Inspect clip clip-music' });
    expect(
      Number(
        await camera.locator(':scope > rect').first().getAttribute('width'),
      ),
    ).toBeLessThan(
      Number(
        await music.locator(':scope > rect').first().getAttribute('width'),
      ),
    );
    await camera.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Clip details' }),
    ).toBeVisible();
    await expect(
      page.getByText('00:00:00:01 → 00:00:01:00', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(JSON.parse(json!));
    await openProject(application, page, join(directory, 'missing.json'));
    await expect(page.getByRole('alert')).toContainText(
      'Cannot read project file',
    );
    await expect(
      page.getByRole('heading', { name: 'Demo', exact: true }),
    ).toBeVisible();
    const bad = join(directory, 'bad.json');
    for (const data of ['{bad', '{"schemaVersion":99}', '{}']) {
      await writeFile(bad, data);
      await openProject(application, page, bad);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Demo', exact: true }),
      ).toBeVisible();
    }
    await openProject(application, page, null);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({
      path: 'test-results/desktop-project-populated.png',
      fullPage: true,
    });
    const changed = JSON.parse(await readFile(path, 'utf8'));
    changed.metadata.name = 'External edit';
    await writeFile(path, JSON.stringify(changed));
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('changed on disk');
    expect(JSON.parse(await readFile(path, 'utf8')).metadata.name).toBe(
      'External edit',
    );
  } finally {
    await application.close();
  }
});

test('native close and quit preserve unsaved work after Cancel or canceled Save', async () => {
  const { application, page } = await launchDesktop();
  try {
    await createProject(page);
    await unsavedDialog(application, 2);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.close(),
    );
    await expect(
      page.getByRole('heading', { name: 'Desktop portrait', exact: true }),
    ).toBeVisible();
    // Wait for the native-close operation to finish, including its IPC busy guard.
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.opencut.getProject()).ok),
      )
      .toBe(true);
    await unsavedDialog(application, 0);
    await saveDialog(application, null);
    await application.evaluate(({ app }) => app.quit());
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.opencut.getProject()).ok),
      )
      .toBe(true);
    await expect(
      page.getByText('Unsaved changes', { exact: false }),
    ).toBeVisible();
    const path = join(directory, 'saved-before-switch.json');
    await saveDialog(application, path);
    await page
      .getByRole('button', { name: 'Close project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'No project' }),
    ).toBeVisible();
    expect(cli('project', 'info', path, '--json').metadata.name).toBe(
      'Desktop portrait',
    );
    await createProject(page, 'Discard on close');
    await unsavedDialog(application, 1);
    const closed = page.waitForEvent('close');
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.close(),
    );
    await closed;
    if (process.platform === 'darwin') {
      const next = application.waitForEvent('window');
      await application.evaluate(({ app }) => app.emit('activate'));
      const reopened = await next;
      await expect(
        reopened.getByRole('heading', { name: 'No project' }),
      ).toBeVisible();
    }
  } finally {
    await application.close();
  }
});

test('project IPC rejects untrusted windows and malformed creation requests', async () => {
  const { application, page } = await launchDesktop();
  try {
    const invalid = await page.evaluate(() =>
      window.opencut.createProject({
        name: 'Bad',
        settings: {
          width: 0,
          height: 720,
          frameRate: { numerator: 30, denominator: 1 },
        },
      }),
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: expect.stringContaining('/settings/width'),
    });
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
            .executeJavaScript(`Promise.all(['getProject', 'createProject', 'openProject', 'saveProject', 'closeProject', 'editTimeline', 'undoProject', 'redoProject', 'importMedia', 'removeAsset', 'addAssetClip', 'assetThumbnail', 'chooseExportOutput', 'getExport', 'startExport', 'cancelExport'].map(async method => {
          try { await window.opencut[method]({ name: 'Untrusted' }); return 'allowed'; }
          catch (error) { return error.message; }
        }))`)) as string[];
        } finally {
          other.destroy();
        }
      },
      resolve('apps/desktop/dist/preload/index.cjs'),
    );
    expect(rejected).toHaveLength(16);
    for (const message of rejected)
      expect(message).toContain('Untrusted IPC sender');
  } finally {
    await application.close();
  }
});

test('shows a loading state and rejects competing project actions while the native picker is open', async () => {
  const { application, page } = await launchDesktop();
  try {
    await createProject(page);
    await application.evaluate(({ app, dialog }) => {
      dialog.showOpenDialog = async () => {
        await new Promise<void>((resolve) => {
          (app as import('node:events').EventEmitter).once(
            't15:test-release-selection',
            resolve,
          );
        });
        return { canceled: true, filePaths: [] };
      };
    });
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(
      page.getByText('Opening project…', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'New project', exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => window.opencut.closeProject()),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('in progress'),
    });
    await application.evaluate(({ app }) =>
      app.emit('t15:test-release-selection'),
    );
    await expect(
      page.getByRole('button', { name: 'Open project', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();
  } finally {
    await unsavedDialog(application, 1);
    await application.close();
  }
});

test('saves an unsaved project before quitting the application', async () => {
  const { application, page } = await launchDesktop();
  try {
    await createProject(page, 'Save before quit');
    const path = join(directory, 'quit.json');
    await unsavedDialog(application, 0);
    await saveDialog(application, path);
    const closed = application.waitForEvent('close');
    await application.evaluate(({ app }) => app.quit());
    await closed;
    expect(cli('project', 'info', path, '--json').metadata.name).toBe(
      'Save before quit',
    );
  } finally {
    await application.close();
  }
});
