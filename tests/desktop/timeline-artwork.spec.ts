import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { serializeProject } from '@opencut/core';
import { runMediaTool } from '../../packages/media/src/process.js';
import { auditProjects } from '../../scripts/t21-projects.js';
import { launchDesktop } from './helpers.js';

test('timeline filmstrips and real waveforms follow trims, remain editable, and fit the workspace', async () => {
  test.setTimeout(120000);
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(resolve('tests/fixtures/generated/artwork-'));
  const source = join(directory, 'source.mp4');
  await runMediaTool('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=640x360:r=30:d=1.5',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x360:r=30:d=4.5',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(lt(t\\,2)\\,0\\,0.7*sin(2*PI*440*t)):s=48000:d=6',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a',
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
  const project = auditProjects().cuts!;
  project.metadata.name = 'Studio preview';
  project.assets = [project.assets[0]!];
  project.assets[0]!.metadata!.width = 640;
  project.assets[0]!.metadata!.height = 360;
  project.tracks = [project.tracks[0]!, project.tracks[2]!];
  project.clips = ['v0', 'a0'].map((trackId, i) => ({
    id: `preview-${i}`,
    assetId: 'asset-0',
    trackId,
    timelineStart: { numerator: 0, denominator: 1 },
    sourceIn: { numerator: 1, denominator: 1 },
    sourceOut: { numerator: 5, denominator: 1 },
  }));
  const path = join(directory, 'project.json');
  await writeFile(path, serializeProject(project));
  const original = await readFile(source);
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    console.log(
      'Electron GPU features',
      await application.evaluate(({ app }) => app.getGPUFeatureStatus()),
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    }, path);
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    const filmstrip = page.locator('.filmstrip .clip-artwork-tile');
    const waveform = page.locator('.waveform .clip-artwork-tile');
    await expect(filmstrip.first()).toHaveAttribute('data-status', 'ready', {
      timeout: 30000,
    });

    await expect(waveform.first()).toHaveAttribute('data-status', 'ready', {
      timeout: 30000,
    });
    expect(await filmstrip.first().getAttribute('data-start')).toBe('1');
    expect(Number(await filmstrip.first().getAttribute('data-count'))).toBe(4);
    expect(
      Number(await filmstrip.first().getAttribute('data-interval')),
    ).toBeCloseTo(0.9);
    // Read the actual returned pixels, not just the existence of an SVG image.
    const red = await filmstrip.first().locator('image').getAttribute('href');
    const blue = red;
    const wave = await waveform.first().locator('image').getAttribute('href');
    const pixels = await page.evaluate(
      async (urls) => {
        return Promise.all(
          urls.map(async (url, index) => {
            const img = new Image();
            img.src = url!;
            await img.decode();
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(img, 0, 0);
            const p = Array.from(
              context.getImageData(
                img.width * (index === 0 ? 1 / 8 : index === 1 ? 5 / 8 : 1 / 2),
                img.height / 2,
                1,
                1,
              ).data,
            );
            const energy = (from: number, to: number) => {
              const d = context.getImageData(
                from,
                0,
                to - from,
                img.height,
              ).data;
              let value = 0;
              for (let i = 0; i < d.length; i += 4) value += d[i + 1]!;
              return value / d.length;
            };
            return {
              p,
              quiet: energy(0, Math.floor(img.width / 8)),
              loud: energy(
                Math.floor(img.width / 2),
                Math.floor((img.width * 3) / 4),
              ),
            };
          }),
        );
      },
      [red, blue, wave],
    );
    expect(pixels[0]!.p[0]).toBeGreaterThan(200);
    expect(pixels[1]!.p[2]).toBeGreaterThan(200);
    expect(pixels[2]!.loud).toBeGreaterThan(pixels[2]!.quiet + 10);
    await page
      .getByRole('button', { name: 'Inspect clip preview-0', exact: true })
      .click();
    await expect(page.getByLabel('Source in', { exact: true })).toBeVisible();
    const stage = page.locator('.timeline-stage');
    const before = (await stage.boundingBox())!.height;
    await page.locator('.timeline-diagnostics summary').click();
    await expect(page.getByTestId('timeline-diagnostics')).toBeVisible();
    expect((await stage.boundingBox())!.height).toBe(before);
    await expect(page.locator('pre')).toHaveCount(0);
    await page.locator('.timeline-diagnostics summary').click();
    for (const [width, height] of [
      [1080, 720],
      [800, 680],
      [1440, 900],
    ]) {
      await application.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!),
        [width!, height!],
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const tops = await page
        .locator('.editor-panels > * > .panel-heading')
        .evaluateAll((elements) =>
          elements.map((e) => e.getBoundingClientRect().top),
        );
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/studio-artwork-${width}.png`,
        animations: 'disabled',
      });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(
      page.locator('.viewer-tabs button[aria-selected="true"]'),
    ).toHaveCSS('background-color', 'rgb(39, 36, 47)');
    await page.screenshot({ path: 'test-results/studio-artwork-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    const invalid = await page.evaluate(async () => {
      const state = await window.opencut.getProject();
      if (!state.ok || !state.state) throw new Error('Missing project');
      try {
        await window.opencut.timelineArtwork({
          projectId: state.state.project.metadata.id,
          expectedRevision: state.state.project.editing?.revision ?? 0,
          assetId: 'asset-0',
          kind: 'waveform',
          start: 0,
          duration: 1,
          width: 100000,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(invalid).toBe(true);
    const stale = await page.evaluate(() =>
      window.opencut.timelineArtwork({
        projectId: 'other',
        expectedRevision: 0,
        assetId: 'asset-0',
        kind: 'waveform',
        start: 0,
        duration: 1,
        width: 100,
      }),
    );
    expect(stale).toBeNull();
    await page
      .getByRole('button', { name: 'Trim start of preview-0', exact: true })
      .focus();
    await page.keyboard.press('ArrowRight');
    await expect(filmstrip.first()).toHaveAttribute('data-status', 'ready', {
      timeout: 30000,
    });
    await expect
      .poll(async () =>
        Number(await filmstrip.first().getAttribute('data-start')),
      )
      .toBeCloseTo(31 / 30);
    expect(errors).toEqual([]);
    expect(await readFile(source)).toEqual(original);
    // Reopening must not reuse cached artwork when the original has disappeared.
    await rm(source);
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(filmstrip.first()).toHaveAttribute(
      'data-status',
      'unavailable',
      { timeout: 30000 },
    );
    await expect(waveform.first()).toHaveAttribute(
      'data-status',
      'unavailable',
      { timeout: 30000 },
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
