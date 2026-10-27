import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop } from './helpers.js';
const root = resolve('tests/fixtures/generated');
const files = ['video-medium.mp4', 'audio-tone.wav', 'still.png'].map((name) =>
  join(root, name),
);
const available = await Promise.all(
  files.map((file) =>
    access(file).then(
      () => true,
      () => false,
    ),
  ),
);
async function picker(application: ElectronApplication, paths: string[]) {
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);
}
const cli = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [resolve('apps/cli/dist/index.js'), ...args, '--json'],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};
test('imports multiple sources, drops disk-backed Files and library assets, previews, protects and persists through CLI', async () => {
  test.setTimeout(90000);
  test.skip(available.includes(false), 'Generate synthetic fixtures first.');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't19-'));
  const path = join(directory, 'project.json');
  const hashes = await Promise.all(
    files.map(async (file) =>
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ),
  );
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    }, path);
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page.getByLabel('Project name', { exact: true }).fill('T19 library');
    await page.getByLabel('Frame rate', { exact: true }).fill('30000/1001');
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await picker(application, files.slice(0, 2));
    await page
      .getByRole('button', { name: 'Import media', exact: true })
      .click();
    await expect(
      page.getByText('2 imported, 0 already in library.'),
    ).toBeVisible();
    const restoredVideo = page
      .locator('.asset-list')
      .getByRole('button', { name: /video-medium/ });
    await restoredVideo.click();
    await page
      .getByRole('button', { name: 'Remove asset', exact: true })
      .click();
    await expect(restoredVideo).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(restoredVideo).toHaveAttribute('draggable', 'true');
    // Disk-backed File objects exercise webUtils in the sandboxed preload, as Finder does.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'external-files';
      input.hidden = true;
      document.body.append(input);
    });
    await page.locator('#external-files').setInputFiles(files[2]!);
    await page.locator('[aria-label="Media library"]').evaluate((element) => {
      const input =
        document.querySelector<HTMLInputElement>('#external-files')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(input.files![0]!);
      element.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
    });
    await expect(
      page.getByRole('heading', { name: 'Media assets (3)' }),
    ).toBeVisible();
    await picker(application, files);
    await page
      .getByRole('button', { name: 'Import media', exact: true })
      .click();
    await expect(
      page.getByText('0 imported, 3 already in library.'),
    ).toBeVisible();
    const asset = (name: string) =>
      page
        .locator('.asset-list')
        .getByRole('button', { name: new RegExp(name) });
    await page
      .getByRole('searchbox', { name: 'Search media' })
      .fill('VIDEO-MEDIUM');
    await expect(page.locator('.asset-list > li')).toHaveCount(1);
    await page.getByLabel('Filter media type').selectOption('image');
    await expect(
      page.getByText('No matching media', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('.asset-list > li')).toHaveCount(3);
    await page.getByLabel('Filter media type').selectOption('image');
    await expect(page.locator('.asset-list > li')).toHaveCount(1);
    await expect(asset('still.png')).toBeVisible();
    await page.getByLabel('Filter media type').selectOption('all');
    await asset('video-medium').click();
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    await asset('video-medium').dragTo(
      page.getByRole('region', { name: 'New video track drop target' }),
    );
    await expect(
      page.getByRole('heading', { name: 'Timeline (1 tracks · 1 clips)' }),
    ).toBeVisible();
    await asset('audio-tone').click();
    await expect(page.locator('audio')).toHaveAttribute(
      'src',
      /opencut:\/\/media/,
    );
    await asset('audio-tone').dragTo(
      page.getByRole('region', { name: 'New audio track drop target' }),
    );
    await expect(
      page.getByRole('heading', { name: 'Timeline (2 tracks · 2 clips)' }),
    ).toBeVisible();
    await asset('still.png').click();
    await expect(page.locator('.simple-source-preview img')).toBeVisible();
    await asset('still.png').dragTo(
      page.getByLabel('Scrollable timeline', { exact: true }),
      { targetPosition: { x: 460, y: 62 } },
    );
    await expect(
      page.getByRole('heading', { name: 'Timeline (2 tracks · 3 clips)' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove asset', exact: true }),
    ).toBeDisabled();
    const before = await page.evaluate(() => window.opencut.getProject());
    if (!before.ok || !before.state) throw new Error('Missing project');
    const still = before.state.project.clips[2]!;
    expect(still.timelineStart).toEqual({
      numerator: 119119,
      denominator: 30000,
    });
    expect(still.sourceOut).toEqual({ numerator: 1001, denominator: 200 });
    await asset('audio-tone').dragTo(
      page.getByLabel('Scrollable timeline', { exact: true }),
      { targetPosition: { x: 460, y: 62 } },
    );
    await expect(page.getByRole('alert')).toContainText('cannot be placed');
    expect(await page.evaluate(() => window.opencut.getProject())).toEqual(
      before,
    );
    await asset('video-medium').dragTo(
      page.getByLabel('Scrollable timeline', { exact: true }),
      { targetPosition: { x: 180, y: 62 } },
    );
    await expect(page.getByRole('alert')).toContainText('overlaps');
    expect(await page.evaluate(() => window.opencut.getProject())).toEqual(
      before,
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Timeline (2 tracks · 2 clips)' }),
    ).toBeVisible();
    await asset('still.png').click();
    await page
      .getByRole('button', { name: 'Remove asset', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Media assets (2)' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    expect(cli('media', 'list', path).assets).toHaveLength(3);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.clips).toHaveLength(2);
    expect(saved.clips[0].sourceOut).toEqual({
      numerator: 89089,
      denominator: 30000,
    });
    expect(cli('project', 'validate', path).valid).toBe(true);
    expect(
      cli('timeline', 'list', path).tracks.flatMap(
        (track: { clips: unknown[] }) => track.clips,
      ),
    ).toHaveLength(2);
    await page
      .getByRole('button', { name: 'Close project', exact: true })
      .click();
    await picker(application, [path]);
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Timeline (2 tracks · 2 clips)' }),
    ).toBeVisible();
    const reopened = await page.evaluate(() => window.opencut.getProject());
    expect(reopened.ok && reopened.state?.project.clips).toEqual(saved.clips);
    // A valid new source followed by an invalid file must leave no partial library edit.
    await picker(application, [join(root, 'video-long.mp4'), path]);
    await page
      .getByRole('button', { name: 'Import media', exact: true })
      .click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await page.evaluate(() => window.opencut.getProject())).toEqual(
      reopened,
    );
    expect(
      await Promise.all(
        files.map(async (file) =>
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ),
      ),
    ).toEqual(hashes);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
