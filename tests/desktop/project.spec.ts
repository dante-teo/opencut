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
      page.getByRole('heading', { name: 'Media library', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Timeline (2 tracks · 2 clips)',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('.asset-list')).toContainText('missing');
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
    await expect(page.getByRole('heading', { name: /camera/i })).toBeVisible();
    await expect(
      page.getByText('00:00:00:01 → 00:00:01:00', { exact: true }),
    ).toBeVisible();
    const before = await readFile(path, 'utf8');
    await openProject(application, page, join(directory, 'missing.json'));
    await expect(
      page.getByRole('heading', { name: 'Demo', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Cannot read project');
    expect(await readFile(path, 'utf8')).toBe(before);
  } finally {
    await application.close();
  }
});
