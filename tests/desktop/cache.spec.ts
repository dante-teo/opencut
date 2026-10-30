import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { serializeProject } from '@opencut/core';
import { auditProjects } from '../../scripts/t21-projects.js';
import { runMediaTool } from '../../packages/media/src/process.js';
import { launchDesktop } from './helpers.js';

test('proxy preview preserves trimmed source mapping, toggles safely and falls back after loss', async () => {
  test.setTimeout(90000);
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/t25-desktop-'),
  );
  const source = join(directory, 'source.mp4');
  await runMediaTool('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-threads',
    '2',
    '-c:a',
    'aac',
    source,
  ]);
  const before = await readFile(source);
  const project = auditProjects().cuts!;
  project.assets = [project.assets[0]!];
  project.assets[0]!.metadata!.width = 1920;
  project.assets[0]!.metadata!.height = 1080;
  project.clips = [
    {
      ...project.clips[0]!,
      sourceIn: { numerator: 1, denominator: 1 },
      sourceOut: { numerator: 4, denominator: 1 },
    },
  ];
  const path = join(directory, 'project.json');
  await writeFile(path, serializeProject(project));
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, path);
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: project.metadata.name, exact: true }),
    ).toBeVisible();
    await page.getByText('Proxy & cache', { exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.opencut.mediaCache({ action: 'status' }),
            )
          )?.jobs.some((job) => job.state === 'ready'),
        { timeout: 30000 },
      )
      .toBe(true);
    const decoder = page.locator('video[data-timeline-clip]');
    await expect(decoder).toHaveAttribute('data-proxy', 'true', {
      timeout: 15000,
    });
    await expect
      .poll(() =>
        decoder.evaluate((video: HTMLVideoElement) => video.videoWidth),
      )
      .toBe(960);
    const firstGrant = await decoder.getAttribute('src');
    await page
      .getByRole('button', { name: 'Regenerate proxies', exact: true })
      .click();
    await expect
      .poll(() => decoder.getAttribute('src'), { timeout: 15000 })
      .not.toBe(firstGrant);
    await expect(decoder).toHaveAttribute('data-proxy', 'true');
    await page
      .getByRole('slider', { name: 'Seek timeline', exact: true })
      .fill('30');
    await expect
      .poll(() =>
        decoder.evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(2, 1);
    await page.getByLabel('Use proxies', { exact: true }).uncheck();
    await expect(decoder).toHaveAttribute('data-proxy', 'false');
    await expect
      .poll(() =>
        decoder.evaluate((video: HTMLVideoElement) => video.videoWidth),
      )
      .toBe(1920);
    await expect
      .poll(() =>
        decoder.evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(2, 1);
    await page.getByLabel('Use proxies', { exact: true }).check();
    await expect(decoder).toHaveAttribute('data-proxy', 'true');
    // Remove an already granted proxy, then exercise the media-error original fallback.
    const status = await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'status' }),
    );
    const proxy = status!.entries.find((entry) => entry.kind === 'proxy')!;
    await rm(join(status!.directory, `${proxy.key}.mp4`));
    await decoder.evaluate((video: HTMLVideoElement) => video.load());
    await expect(decoder).toHaveAttribute('data-proxy', 'false');
    await expect
      .poll(() =>
        decoder.evaluate((video: HTMLVideoElement) => video.videoWidth),
      )
      .toBe(1920);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect(page.locator('canvas')).toHaveAttribute(
      'data-presented-clip',
      'c0',
    );
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Pause', exact: true })
      .click();
    await page.getByLabel('Disk cache MiB').fill('8');
    await page.getByLabel('Frame memory MiB').fill('1');
    await page
      .getByRole('button', { name: 'Apply limits', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.opencut.mediaCache({ action: 'status' }),
            )
          )?.limits.memoryBytes,
      )
      .toBe(1024 ** 2);
    await page
      .getByRole('button', { name: 'Cancel generation', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Cancel generation', exact: true }),
    ).toBeEnabled();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() =>
            window.opencut.mediaCache({ action: 'status' }),
          ))!.diskBytes,
      )
      .toBeLessThanOrEqual(8 * 1024 ** 2);
    const rejected = await page.evaluate(async () => {
      try {
        await window.opencut.timelineFrame({
          projectId: 'other',
          expectedRevision: 0,
          assetId: 'asset-0',
          timestamp: 0,
        });
        return false;
      } catch {
        return true;
      }
    });
    // Stale frame requests expose no data.
    expect(rejected).toBe(false);
    expect(
      await page.evaluate(() =>
        window.opencut.timelineFrame({
          projectId: 'other',
          expectedRevision: 0,
          assetId: 'asset-0',
          timestamp: 0,
        }),
      ),
    ).toBeNull();
    await page.screenshot({ path: 'test-results/t25-cache.png' });
    expect(await readFile(source)).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(serializeProject(project));
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the first cache status applies persisted memory limits to speculative decoders', async () => {
  test.setTimeout(60000);
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/t25-initial-budget-'),
  );
  const source = join(directory, 'source.mp4');
  const cacheDirectory = join(directory, 'cache');
  const { MediaCache } = await import('../../packages/media/src/index.js');
  await new MediaCache(cacheDirectory).configure({
    diskBytes: 8 * 1024 ** 2,
    memoryBytes: 1024 ** 2,
  });
  await runMediaTool('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30',
    '-t',
    '3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-threads',
    '2',
    source,
  ]);
  const project = auditProjects().cuts!;
  project.assets = [project.assets[0]!];
  project.assets[0]!.metadata!.width = 640;
  project.assets[0]!.metadata!.height = 360;
  project.assets[0]!.metadata!.hasAudio = false;
  project.assets[0]!.metadata!.audioCodec = null;
  project.clips = [0, 1, 2].map((index) => ({
    ...project.clips[0]!,
    id: `clip-${index}`,
    timelineStart: { numerator: index, denominator: 2 },
    sourceIn: { numerator: index, denominator: 1 },
    sourceOut: { numerator: index * 2 + 1, denominator: 2 },
  }));
  const path = join(directory, 'project.json');
  await writeFile(path, serializeProject(project));
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: cacheDirectory,
  });
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, path);
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: project.metadata.name, exact: true }),
    ).toBeVisible();
    await page.locator('.timeline-diagnostics summary').click();
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await page.getByTestId('timeline-diagnostics').textContent())!,
          ).decoders,
      )
      .toBe(1);
    await expect(page.locator('video[data-timeline-clip]')).toHaveCount(1);
    // A later explicit increase proves both upcoming noncontiguous runs are in lookahead.
    await page.evaluate(() =>
      window.opencut.mediaCache({
        action: 'configure',
        limits: { diskBytes: 8 * 1024 ** 2, memoryBytes: 64 * 1024 ** 2 },
      }),
    );
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await page.getByTestId('timeline-diagnostics').textContent())!,
          ).decoders,
      )
      .toBe(3);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
