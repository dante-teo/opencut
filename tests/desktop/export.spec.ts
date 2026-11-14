import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { projectRevision, serializeProject } from '@opencut/core';
import { renderProjectFile } from '@opencut/core/node';
import { launchDesktop } from './helpers.js';
import { compositionFixture, openComposition } from './t26-fixtures.js';
import {
  command,
  decodeFrames,
  verifyVideoTimestamps,
} from './t27-comparison.js';

let fixture: Awaited<ReturnType<typeof compositionFixture>>;
test.beforeAll(async () => {
  fixture = await compositionFixture();
});
test.afterAll(async () => {
  await rm(fixture.directory, { recursive: true, force: true });
});
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const panel = (page: Page) =>
  page.getByRole('dialog', { name: 'Export video', exact: true });
async function show(page: Page) {
  await page
    .getByRole('button', { name: /^(Export|Exporting…)$/, exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
}
async function choose(
  application: ElectronApplication,
  page: Page,
  path: string | null,
) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({
      canceled: path === null,
      filePath: path ?? '',
    });
  }, path);
  await panel(page)
    .getByRole('button', { name: 'Choose output…', exact: true })
    .click();
  await expect(
    panel(page).getByRole('button', { name: 'Choose output…', exact: true }),
  ).toBeEnabled();
}
async function start(page: Page) {
  await panel(page)
    .getByRole('button', { name: 'Export video', exact: true })
    .click();
}
async function rendering(page: Page) {
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.opencut.getExport());
        return (
          state?.status === 'rendering' &&
          (state.progress?.processedFrames ?? 0) > 0
        );
      },
      { timeout: 45000 },
    )
    .toBe(true);
}
async function terminal(page: Page, status: string) {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.opencut.getExport()))?.status,
      { timeout: 90000 },
    )
    .toBe(status);
  return (await page.evaluate(() => window.opencut.getExport()))!;
}
function probe(path: string) {
  return JSON.parse(
    command('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path,
    ]).toString(),
  ) as {
    streams: {
      codec_name: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration: string;
      nb_frames?: string;
    }[];
    format: { duration: string };
  };
}

test('GUI export uses originals with proxies enabled and holds its snapshot while CLI edits continue', async () => {
  test.setTimeout(180000);
  const { directory, project } = fixture;
  const before = await hash(join(directory, 'base.mp4'));
  const snapshotPath = join(directory, 'snapshot.json');
  await writeFile(snapshotPath, serializeProject(project));
  const output = join(directory, 'gui-originals.mp4');
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    await openComposition(
      application,
      page,
      directory,
      project,
      'gui-snapshot',
    );
    await expect(
      page.locator('video[data-timeline-clip="base"]'),
    ).toHaveAttribute('data-proxy', 'true', { timeout: 45000 });
    await show(page);
    await panel(page).getByLabel('Preset', { exact: true }).selectOption('1');
    await expect(panel(page)).toContainText('7.000 s output');
    await choose(application, page, null);
    await expect(
      panel(page).getByLabel('Output file', { exact: true }),
    ).toHaveValue('');
    await choose(application, page, output);
    await start(page);
    await rendering(page);
    const captured = (await page.evaluate(() => window.opencut.getExport()))!;
    await panel(page)
      .getByRole('button', { name: 'Hide', exact: true })
      .click();
    const projectFile = join(directory, 'gui-snapshot.json');
    const batch = join(directory, 'hide-base.json');
    await writeFile(
      batch,
      JSON.stringify({
        expectedRevision: captured.revision,
        operations: [{ type: 'clip.visual', id: 'base', opacity: 0 }],
      }),
    );
    await promisify(execFile)(process.execPath, [
      resolve('apps/cli/dist/index.js'),
      'edit',
      'apply',
      projectFile,
      batch,
      '--json',
    ]);
    await expect(
      page.getByText('Revision ' + (captured.revision + 1), { exact: true }),
    ).toBeVisible();
    const edited = await page.evaluate(() => window.opencut.getProject());
    expect(
      edited.ok &&
        edited.state?.project.clips.find((clip) => clip.id === 'base')?.visual
          ?.opacity,
    ).toBe(0);
    expect(
      edited.ok && edited.state && projectRevision(edited.state.project),
    ).toBeGreaterThan(captured.revision);
    // The edit was accepted while the real FFmpeg subprocess was still active.
    expect(
      (await page.evaluate(() => window.opencut.getExport()))?.status,
    ).toBe('rendering');
    const result = await terminal(page, 'succeeded');
    expect(result.revision).toBe(captured.revision);
    expect(result.summary).toMatchObject({
      width: 1920,
      height: 1080,
      frameCount: 210,
      durationSeconds: 7,
      codec: 'h264',
    });
    const metadata = probe(output);
    expect(metadata.streams.map((stream) => stream.codec_name)).toEqual([
      'h264',
      'aac',
    ]);
    expect(Number(metadata.format.duration)).toBe(7);
    verifyVideoTimestamps(output, project.settings.frameRate, 210);
    const reference = join(directory, 'snapshot-reference.mp4');
    await renderProjectFile(snapshotPath, reference, {
      quality: 'high',
      resolution: '1080p',
    });
    const frames = [0, 65, 165, 195];
    const actual = decodeFrames(output, frames, 1920, 1080);
    const expected = decodeFrames(reference, frames, 1920, 1080);
    for (const frame of frames)
      expect(actual.get(frame)!.equals(expected.get(frame)!)).toBe(true);
    expect(await hash(join(directory, 'base.mp4'))).toBe(before);
    await show(page);
    await expect(panel(page).getByRole('status')).toHaveText('Export complete');
    await page.screenshot({ path: 'test-results/t28-export-success.png' });
    for (const size of [
      { width: 640, height: 480 },
      { width: 1080, height: 720 },
    ]) {
      await page.setViewportSize(size);
      const bounds = await panel(page).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
      const actions = await panel(page)
        .locator('.dialog-actions')
        .boundingBox();
      expect(actions!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(actions!.y + actions!.height).toBeLessThanOrEqual(
        bounds!.y + bounds!.height,
      );
    }
    console.log(
      JSON.stringify({
        export: 'T28 GUI snapshot/originals',
        seconds: result.elapsedSeconds,
        progress: result.progress,
        summary: result.summary,
      }),
    );
  } finally {
    await application.close();
  }
});

test('GUI presets, HEVC and fractional output frame rates produce verified metadata', async () => {
  test.setTimeout(180000);
  const project = structuredClone(fixture.project);
  project.clips = [project.clips[0]!];
  project.clips[0]!.sourceOut = { numerator: 31, denominator: 30 };
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'codec-cache'),
  });
  try {
    await openComposition(
      application,
      page,
      fixture.directory,
      project,
      'codec',
    );
    await show(page);
    for (const [preset, codec, frameRate, ratio, frames, width, height] of [
      ['2', 'h264', '24', '24/1', 25, 1280, 720],
      ['3', 'hevc', '30000/1001', '30000/1001', 31, 1920, 1080],
      ['0', 'h264', 'project', '30/1', 31, 640, 360],
    ] as const) {
      await panel(page)
        .getByLabel('Preset', { exact: true })
        .selectOption(preset);
      await panel(page)
        .getByLabel('Export frame rate', { exact: true })
        .selectOption(frameRate);
      const output = join(fixture.directory, `gui-${codec}-${preset}.mp4`);
      await choose(application, page, output);
      await start(page);
      const result = await terminal(page, 'succeeded');
      const video = probe(output).streams[0]!;
      expect(video).toMatchObject({
        codec_name: codec,
        width,
        height,
        avg_frame_rate: ratio,
      });
      expect(Number(video.nb_frames)).toBe(frames);
      verifyVideoTimestamps(output, result.summary!.frameRate, frames);
      console.log(
        JSON.stringify({
          export: `T28 ${codec} preset ${preset}`,
          seconds: result.elapsedSeconds,
          summary: result.summary,
        }),
      );
    }
  } finally {
    await application.close();
  }
});

test('GUI validation rejects conflicts, paths, missing media and unsupported projects, then recovers', async () => {
  test.setTimeout(120000);
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'validation-cache'),
  });
  try {
    await openComposition(
      application,
      page,
      fixture.directory,
      fixture.project,
      'validation',
    );
    await show(page);
    const conflict = join(fixture.directory, 'existing.mp4');
    await writeFile(conflict, 'existing video must survive');
    for (const [output, message] of [
      [conflict, 'Refusing to overwrite'],
      [join(fixture.directory, 'out.mov'), '.mp4 extension'],
      [
        join(fixture.directory, 'no-directory', 'out.mp4'),
        'existing writable directory',
      ],
    ]) {
      await choose(application, page, output!);
      await start(page);
      await terminal(page, 'validation_failed');
      await expect(panel(page).getByRole('alert')).toContainText(message!);
    }
    expect(await readFile(conflict, 'utf8')).toBe(
      'existing video must survive',
    );
    const missing = structuredClone(fixture.project);
    missing.assets[0]!.file = {
      type: 'relative',
      path: 'missing-original.mp4',
    };
    await panel(page)
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await openComposition(
      application,
      page,
      fixture.directory,
      missing,
      'missing',
    );
    await show(page);
    const output = join(fixture.directory, 'recovered.mp4');
    await choose(application, page, output);
    await start(page);
    await terminal(page, 'validation_failed');
    await expect(panel(page).getByRole('alert')).toContainText(
      'cannot read/probe media',
    );
    await expect(access(output)).rejects.toThrow();
    await panel(page)
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    const unsupported = structuredClone(fixture.project);
    unsupported.settings.width = 641;
    await openComposition(
      application,
      page,
      fixture.directory,
      unsupported,
      'unsupported',
    );
    await show(page);
    await start(page);
    await terminal(page, 'validation_failed');
    await expect(panel(page).getByRole('alert')).toContainText(
      'even dimensions',
    );
    await panel(page)
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await openComposition(
      application,
      page,
      fixture.directory,
      fixture.project,
      'recovery',
    );
    await show(page);
    await start(page);
    await terminal(page, 'succeeded');
    expect(probe(output).streams[0]!.codec_name).toBe('h264');
  } finally {
    await application.close();
  }
});

test('GUI cancellation and publication failure preserve late destination conflicts and clean temporary output', async () => {
  test.setTimeout(180000);
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'cancel-cache'),
  });
  try {
    await openComposition(
      application,
      page,
      fixture.directory,
      fixture.project,
      'cancel',
    );
    await show(page);
    await panel(page).getByLabel('Preset', { exact: true }).selectOption('1');
    const output = join(fixture.directory, 'late-conflict.mp4');
    await choose(application, page, output);
    await start(page);
    await rendering(page);
    await writeFile(output, 'late existing file');
    const began = performance.now();
    await panel(page)
      .getByRole('button', { name: 'Cancel export', exact: true })
      .click();
    await terminal(page, 'cancelled');
    const cancelledMs = performance.now() - began;
    expect(await readFile(output, 'utf8')).toBe('late existing file');
    expect(
      (await readdir(fixture.directory)).filter((name) =>
        name.startsWith('.opencut-render-'),
      ),
    ).toEqual([]);
    await rm(output);
    await start(page);
    await rendering(page);
    await writeFile(output, 'another late file');
    await terminal(page, 'failed');
    expect(await readFile(output, 'utf8')).toBe('another late file');
    await expect(panel(page).getByRole('alert')).toContainText(
      'Refusing to overwrite existing output',
    );
    expect(
      (await readdir(fixture.directory)).filter((name) =>
        name.startsWith('.opencut-render-'),
      ),
    ).toEqual([]);
    await choose(
      application,
      page,
      join(fixture.directory, 'after-failure.mp4'),
    );
    await panel(page).getByLabel('Preset', { exact: true }).selectOption('0');
    await start(page);
    await terminal(page, 'succeeded');
    console.log(
      JSON.stringify({ export: 'T28 GUI cancellation', cancelledMs }),
    );
  } finally {
    await application.close();
  }
});

test('GUI preflight reports unavailable media tools and export IPC rejects untrusted windows and malformed requests', async () => {
  test.setTimeout(90000);
  const { application, page } = await launchDesktop({
    PATH: '/nonexistent',
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'no-tools-cache'),
  });
  try {
    await openComposition(
      application,
      page,
      fixture.directory,
      fixture.project,
      'no-tools',
    );
    await show(page);
    await choose(application, page, join(fixture.directory, 'no-tools.mp4'));
    await start(page);
    await terminal(page, 'validation_failed');
    await expect(panel(page).getByRole('alert')).toContainText(
      'not found on PATH',
    );
    const invalid = await page.evaluate(async () => {
      try {
        await window.opencut.startExport({ output: '/injected.mp4' } as never);
        return '';
      } catch (error) {
        return String(error);
      }
    });
    expect(invalid).toContain('Invalid export');
    const scope = await page.evaluate(async () => {
      const reply = await window.opencut.getProject();
      if (!reply.ok || !reply.state) throw new Error('No project');
      return {
        view: reply.state.view,
        projectId: reply.state.project.metadata.id,
        expectedRevision: reply.state.project.editing?.revision ?? 0,
      };
    });
    const rejectExport = (request: typeof scope) =>
      page.evaluate(async (request) => {
        try {
          await window.opencut.startExport({
            ...request,
            settings: {
              resolution: 'project',
              quality: 'balanced',
              frameRate: 'project',
              codec: 'h264',
            },
          });
          return '';
        } catch (error) {
          return String(error);
        }
      }, request);
    const stale = await rejectExport({ ...scope, expectedRevision: 100 });
    expect(stale).toContain('revision');
    await panel(page)
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const reply = await window.opencut.getProject();
          return reply.ok && reply.state?.view;
        }),
      )
      .toBeGreaterThan(scope.view);
    expect(await rejectExport(scope)).toContain('Project changed');
  } finally {
    await application.close();
  }
});

test('native window close and application quit cancel active exports before closing', async () => {
  test.setTimeout(120000);
  for (const action of ['close', 'quit'] as const) {
    const { application, page } = await launchDesktop({
      OPENCUT_MEDIA_CACHE: join(fixture.directory, `shutdown-${action}-cache`),
    });
    try {
      await openComposition(
        application,
        page,
        fixture.directory,
        fixture.project,
        `shutdown-${action}`,
      );
      await show(page);
      await panel(page).getByLabel('Preset', { exact: true }).selectOption('1');
      const output = join(fixture.directory, `shutdown-${action}.mp4`);
      await choose(application, page, output);
      await start(page);
      await rendering(page);
      const closed = page.waitForEvent('close');
      await application.evaluate(({ app, BrowserWindow }, action) => {
        if (action === 'quit') app.quit();
        else BrowserWindow.getAllWindows()[0]!.close();
      }, action);
      await closed;
      await expect(access(output)).rejects.toThrow();
      expect(
        (await readdir(fixture.directory)).filter((name) =>
          name.startsWith('.opencut-render-'),
        ),
      ).toEqual([]);
    } finally {
      await application.close();
    }
  }
});

test('restoring the export panel requires a fresh destination without changing the last job', async () => {
  test.setTimeout(90000);
  const project = structuredClone(fixture.project);
  project.clips = [project.clips[0]!];
  project.clips[0]!.sourceOut = { numerator: 1, denominator: 1 };
  const first = join(fixture.directory, 'restore-first.mp4');
  const next = join(fixture.directory, 'restore-next.mp4');
  const unconfirmed = join(fixture.directory, 'restore-unconfirmed.mp4');
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'restore-cache'),
  });
  try {
    await openComposition(
      application,
      page,
      fixture.directory,
      project,
      'restore',
    );
    await show(page);
    await choose(application, page, first);
    await start(page);
    const completed = await terminal(page, 'succeeded');
    const original = await hash(first);
    await choose(application, page, next);
    await expect(
      panel(page).getByLabel('Output file', { exact: true }),
    ).toHaveValue(next);

    await page.reload();
    await expect(page.locator('.workspace')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await show(page);
    await expect(
      panel(page).getByLabel('Output file', { exact: true }),
    ).toHaveValue('');
    await expect(
      panel(page).getByRole('button', { name: 'Export video', exact: true }),
    ).toBeDisabled();
    await expect(
      panel(page).getByRole('region', { name: 'Export status' }),
    ).toContainText(first);
    expect(await page.evaluate(() => window.opencut.getExport())).toMatchObject(
      { id: completed.id, output: first },
    );
    await expect(access(next)).rejects.toThrow();

    await choose(application, page, null);
    await expect(
      panel(page).getByRole('button', { name: 'Export video', exact: true }),
    ).toBeDisabled();
    await choose(application, page, next);
    await start(page);
    expect(await terminal(page, 'succeeded')).toMatchObject({ output: next });
    expect(probe(next).streams[0]!.codec_name).toBe('h264');
    expect(await hash(first)).toBe(original);

    if (process.platform === 'darwin') {
      await choose(application, page, unconfirmed);
      const closed = page.waitForEvent('close');
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.close(),
      );
      await closed;
      const reopened = application.waitForEvent('window');
      await application.evaluate(({ app }) => app.emit('activate'));
      const restored = await reopened;
      await show(restored);
      await expect(
        panel(restored).getByLabel('Output file', { exact: true }),
      ).toHaveValue('');
      await expect(
        panel(restored).getByRole('button', {
          name: 'Export video',
          exact: true,
        }),
      ).toBeDisabled();
      await expect(
        panel(restored).getByRole('region', { name: 'Export status' }),
      ).toContainText(next);
      await expect(access(unconfirmed)).rejects.toThrow();
    }
  } finally {
    await application.close();
  }
});
