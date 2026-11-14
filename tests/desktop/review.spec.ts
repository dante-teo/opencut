import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { controlDesktopProject } from '@opencut/core/node';
import { launchDesktop } from './helpers.js';
import {
  compositionFixture,
  openComposition,
  seekComposition,
} from './t26-fixtures.js';

const cli = (...args: string[]) =>
  promisify(execFile)(process.execPath, [
    resolve('apps/cli/dist/index.js'),
    ...args,
    '--json',
  ]);

test('reviews headless commits, revokes previews and survives an Electron crash', async () => {
  test.setTimeout(120_000);
  const { directory, project } = await compositionFixture();
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  let killed = false;
  try {
    const path = await openComposition(application, page, directory, project);
    const revision = (n: number) =>
      page.getByText('Revision ' + n, { exact: true });
    await expect(revision(0)).toBeVisible();
    const before = await readFile(path);
    const history = (await cli('edit', 'history', path)).stdout;
    await seekComposition(page, 75, ['base', 'pip', 'image']);
    await controlDesktopProject(path, {
      action: 'select',
      kind: 'clip',
      id: 'base',
    });
    await expect(
      page.getByRole('button', { name: 'Inspect clip base', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await controlDesktopProject(path, { action: 'step', direction: 1 });
    await controlDesktopProject(path, { action: 'play' });
    await expect
      .poll(async () => {
        const result = (await controlDesktopProject(path, {
          action: 'status',
        })) as { state: { frame: number } };
        return result.state.frame;
      })
      .toBeGreaterThan(76);
    await controlDesktopProject(path, { action: 'pause' });
    await page.getByLabel('Seek timeline', { exact: true }).fill('75');
    const oldScope = await page.evaluate(async () => {
      const reply = await window.opencut.getProject();
      if (!reply.ok || !reply.state) throw new Error('No project');
      return {
        view: reply.state.view,
        projectId: reply.state.project.metadata.id,
        expectedRevision: 0,
      };
    });
    const oldPreview = await page.evaluate(
      (scope) =>
        window.opencut.renderTimeline({
          ...scope,
          size: 320,
        }),
      oldScope,
    );
    expect(oldPreview?.revision).toBe(0);
    await controlDesktopProject(path, { action: 'render-preview' });
    const movie = page.getByLabel('Rendered timeline preview');
    await expect(movie).toBeVisible({ timeout: 45000 });
    const oldUrl = (await movie.getAttribute('src'))!;
    expect(await readFile(path)).toEqual(before);
    expect((await cli('edit', 'history', path)).stdout).toBe(history);

    const clip = page.getByRole('button', {
      name: 'Inspect clip base',
      exact: true,
    });
    const beforeBounds = await clip
      .locator(':scope > rect')
      .first()
      .boundingBox();
    const { x, y } = beforeBounds!;
    await page.mouse.move(x + 15, y + 20);
    await page.mouse.down();
    await page.mouse.move(x + 65, y + 20, { steps: 5 });
    await page.mouse.up();
    await clip.press('Delete');
    expect(await readFile(path)).toEqual(before);

    await page.evaluate(() => {
      const records: number[] = [];
      window.opencut.onProjectChanged((state) => {
        if (state) records.push(state.project.editing?.revision ?? 0);
      });
      Object.assign(window, { reviewRevisions: records });
    });
    const batch = join(directory, 'change.json');
    await writeFile(
      batch,
      JSON.stringify({
        expectedRevision: 0,
        operations: [{ type: 'clip.visual', id: 'image', opacity: 0 }],
      }),
    );
    await cli('edit', 'apply', path, batch);
    await expect(revision(1)).toBeVisible();
    await expect(movie).toHaveCount(0);
    expect(
      await application.evaluate(
        async ({ net }, url) => (await net.fetch(url)).status,
        oldUrl,
      ),
    ).toBe(403);
    const summary = page.locator('.timeline-diagnostics summary');
    if (!(await page.locator('.timeline-diagnostics[open]').count()))
      await summary.click();
    await seekComposition(page, 75, ['base', 'pip']);
    for (let expected = 1; expected <= 5; expected++)
      await cli(
        'track',
        'add',
        path,
        '--type',
        'audio',
        '--name',
        'Revision track ' + expected,
        '--expected-revision',
        String(expected),
      );
    await expect(revision(6)).toBeVisible();
    await expect(movie).toHaveCount(0);
    const seen = await page.evaluate(
      () =>
        (window as unknown as { reviewRevisions: number[] }).reviewRevisions,
    );
    expect(seen).toEqual([...new Set(seen)].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(6);
    expect(
      await page.evaluate(async (scope) => {
        try {
          await window.opencut.renderTimeline({ ...scope, size: 320 });
          return false;
        } catch {
          return true;
        }
      }, oldScope),
    ).toBe(true);
    await expect(
      page.getByRole('button', {
        name: /^(New project|Save project|Undo|Redo|Import media)$/,
      }),
    ).toHaveCount(0);

    const child = application.process();
    const exited = once(child, 'exit');
    expect(child.kill('SIGKILL')).toBe(true);
    killed = true;
    await exited;
    await cli('edit', 'undo', path, '--expected-revision', '6');
    await cli('edit', 'redo', path, '--expected-revision', '7');
    const after = JSON.parse((await cli('edit', 'history', path)).stdout);
    expect(after).toMatchObject({ revision: 8, redo: [] });
  } finally {
    if (!killed) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
