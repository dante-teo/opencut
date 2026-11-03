import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { serializeProject, type Project } from '@opencut/core';
import { MediaCache } from '../../packages/media/src/index.js';
import { launchDesktop } from './helpers.js';
import {
  compositionFixture,
  compositionReport,
  openComposition,
  seekComposition,
} from './t26-fixtures.js';

let fixture: Awaited<ReturnType<typeof compositionFixture>>;
test.beforeAll(async () => {
  fixture = await compositionFixture();
});
test.setTimeout(180000);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
async function exportProject(project: Project, name: string) {
  const path = join(fixture.directory, `${name}.json`);
  const output = join(fixture.directory, `${name}.mp4`);
  await writeFile(path, serializeProject(project));
  const result = spawnSync(
    process.execPath,
    [
      resolve('apps/cli/dist/index.js'),
      'project',
      'render',
      path,
      '--output',
      output,
      '--json',
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return output;
}
async function compareFrame(page: Page, output: string, frame: number) {
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      output,
      '-vf',
      `select=eq(n\\,${frame})`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { maxBuffer: 4 * 1024 ** 2, timeout: 30000 },
  );
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  const pixels = await page
    .locator('canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const { data } = canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height);
      const pixels: number[] = [];
      for (let y = 8; y < canvas.height; y += 16)
        for (let x = 8; x < canvas.width; x += 16) {
          const i = (y * canvas.width + x) * 4;
          // Compare transparent preview flattened onto export's black matte.
          for (let c = 0; c < 3; c++)
            pixels.push((data[i + c]! * data[i + 3]!) / 255);
        }
      return pixels;
    });
  const differences: number[] = [];
  let i = 0;
  for (let y = 8; y < 360; y += 16)
    for (let x = 8; x < 640; x += 16)
      for (let c = 0; c < 3; c++)
        differences.push(
          Math.abs(pixels[i++]! - decoded.stdout[(y * 640 + x) * 3 + c]!),
        );
  const mean = differences.reduce((sum, d) => sum + d, 0) / differences.length;
  const p95 = differences.sort((a, b) => a - b)[
    Math.floor(differences.length * 0.95)
  ]!;
  console.log(
    'T26 preview/export RGB error',
    JSON.stringify({ frame, mean, p95 }),
  );
  expect(mean).toBeLessThan(10);
  expect(p95).toBeLessThan(30);
  return { frame, mean, p95 };
}

test('ordered video/image layers match original-media FFmpeg frames across fits, alpha, gaps and boundaries', async () => {
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'cache'),
  });
  const sources = ['base.mp4', 'portrait.mp4', 'alpha.png'].map((file) =>
    join(fixture.directory, file),
  );
  const before = await Promise.all(sources.map(hash));
  const comparisons = [];
  try {
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    const project = structuredClone(fixture.project);
    // Shuffle clip storage to prove track order, rather than clip array order, controls paint order.
    project.clips.reverse();
    const output = await exportProject(project, 'cover');
    await openComposition(application, page, fixture.directory, project);
    for (const [frame, layers] of [
      [0, ['base']],
      [29, ['base']],
      [30, ['base', 'pip']],
      [60, ['base', 'pip', 'image']],
      [119, ['base', 'pip', 'image']],
      [120, ['base', 'pip']],
      [150, ['base']],
      [180, []],
      [210, []],
    ] as [number, string[]][]) {
      await seekComposition(page, frame, layers);
      if (frame < 210)
        comparisons.push(await compareFrame(page, output, frame));
      if (frame === 60) {
        await page.locator('.timeline-diagnostics summary').click();
        await page.screenshot({
          path: join(fixture.directory, 'composition-electron.png'),
        });
        await page.locator('.timeline-diagnostics summary').click();
      }
    }
    await expect(
      page.locator('video[data-timeline-clip="invisible"]'),
    ).toHaveCount(0);
    for (const fit of ['contain', 'stretch'] as const) {
      project.clips.find((clip) => clip.id === 'pip')!.visual!.fit = fit;
      const rendered = await exportProject(project, fit);
      await openComposition(application, page, fixture.directory, project, fit);
      await seekComposition(page, 75, ['base', 'pip', 'image']);
      comparisons.push(await compareFrame(page, rendered, 75));
    }
    project.tracks.reverse();
    await openComposition(
      application,
      page,
      fixture.directory,
      project,
      'reordered',
    );
    await seekComposition(page, 75, ['image', 'pip', 'base']);
    comparisons.push(
      await compareFrame(
        page,
        await exportProject(project, 'reordered-export'),
        75,
      ),
    );
    // Verify that a rounded, lower-resolution proxy retains geometry and SDR colors.
    const cache = new MediaCache(join(fixture.directory, 'cache'));
    expect(
      (await cache.generateProxy(join(fixture.directory, 'base.mp4'))).proxy,
    ).toBe(true);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: true }),
    );
    await expect(
      page.locator('video[data-timeline-clip="base"]'),
    ).toHaveAttribute('data-proxy', 'true', { timeout: 15000 });
    await seekComposition(page, 75, ['image', 'pip', 'base']);
    comparisons.push(
      await compareFrame(
        page,
        join(fixture.directory, 'reordered-export.mp4'),
        75,
      ),
    );
    project.settings.backgroundColor = '#18304880';
    await openComposition(
      application,
      page,
      fixture.directory,
      project,
      'transparent',
    );
    await seekComposition(page, 180, []);
    const alpha = await page
      .locator('canvas')
      .evaluate(
        (canvas: HTMLCanvasElement) =>
          canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data[3],
      );
    expect(alpha).toBe(128);
    comparisons.push(
      await compareFrame(
        page,
        await exportProject(project, 'transparent-export'),
        180,
      ),
    );
    await page.screenshot({ path: join(fixture.directory, 'electron.png') });
    await writeFile(
      join(fixture.directory, 'frame-comparison.json'),
      JSON.stringify(comparisons, null, 2),
    );
    console.log('T26 visual comparison directory', fixture.directory);
    expect(await Promise.all(sources.map(hash))).toEqual(before);
  } finally {
    await application.close();
  }
});

test('multi-layer transport, independent decoders, rapid seeks, edits, frame stepping and resource disposal', async () => {
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'transport-cache'),
  });
  try {
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    await openComposition(
      application,
      page,
      fixture.directory,
      fixture.project,
      'transport',
    );
    await seekComposition(page, 75, ['base', 'pip', 'image']);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Next frame', exact: true })
      .click();
    await expect
      .poll(async () => {
        const r = await compositionReport(page);
        return r.position.numerator / r.position.denominator;
      })
      .toBeCloseTo(76 / 30, 5);
    await expect
      .poll(() =>
        page
          .locator('video[data-timeline-clip="pip"]')
          .evaluate((video: HTMLVideoElement) =>
            video.seeking ? -1 : video.currentTime,
          ),
      )
      .toBeCloseTo(76 / 30 - 0.5, 4);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect
      .poll(async () => {
        const entries = await page
          .locator('video[data-timeline-clip]')
          .evaluateAll((videos) =>
            videos.map((v) => ({
              id: (v as HTMLVideoElement).dataset.timelineClip,
              time: (v as HTMLVideoElement).currentTime,
              paused: (v as HTMLVideoElement).paused,
            })),
          );
        return entries.filter(
          (v) =>
            ['base', 'pip'].includes(v.id!) &&
            v.time > (v.id === 'pip' ? 2.2 : 2.7) &&
            !v.paused,
        ).length;
      })
      .toBe(2);
    expect((await compositionReport(page)).activeAudio).toBe(1);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Pause', exact: true })
      .click();
    await page.evaluate(() => {
      const slider = document.querySelector<HTMLInputElement>(
        '[aria-label="Seek timeline"]',
      )!;
      for (const frame of [180, 1, 130, 60, 210, 75]) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(slider, String(frame));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await seekComposition(page, 75, ['base', 'pip', 'image']);
    // Exercise the production edit/history/IPC path while all three layers are visible.
    await page
      .getByRole('button', { name: 'Inspect clip pip', exact: true })
      .locator(':scope > rect')
      .first()
      .click();
    const x = page.getByRole('spinbutton', { name: 'Position X', exact: true });
    await x.fill('-160');
    await x.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.opencut.getProject();
          return (
            r.ok &&
            r.state?.project.clips.find((c) => c.id === 'pip')?.visual?.x
          );
        }),
      )
      .toBe(-160);
    await expect(page.locator('.workspace')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await page
      .getByRole('button', { name: 'Inspect clip image', exact: true })
      .locator(':scope > rect')
      .first()
      .click();
    const opacity = page.getByRole('spinbutton', {
      name: 'Opacity',
      exact: true,
    });
    await expect(opacity).toHaveValue('0.5');
    await opacity.fill('0');
    await opacity.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.opencut.getProject();
          return (
            r.ok &&
            r.state?.project.clips.find((c) => c.id === 'image')?.visual
              ?.opacity
          );
        }),
      )
      .toBe(0);
    await expect(page.locator('.workspace')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await seekComposition(page, 75, ['base', 'pip']);
    await expect
      .poll(async () => (await compositionReport(page)).unavailable)
      .toEqual([]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await seekComposition(page, 75, ['base', 'pip', 'image']);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await seekComposition(page, 75, ['base', 'pip']);
    const before = await page.locator('canvas').screenshot();
    expect(before.byteLength).toBeGreaterThan(1000);
    await page
      .getByRole('tab', { name: 'Source preview', exact: true })
      .click();
    await expect(page.locator('video[data-timeline-clip]')).toHaveCount(0);
  } finally {
    await application.close();
  }
});

test('missing upper video degrades to lower layers and offscreen silent videos allocate no decoder', async () => {
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(fixture.directory, 'offline-cache'),
  });
  try {
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    const project = structuredClone(fixture.project);
    project.assets[1]!.file = { type: 'relative', path: 'missing.mp4' };
    await openComposition(
      application,
      page,
      fixture.directory,
      project,
      'offline',
    );
    await seekComposition(page, 75, ['base', 'image']);
    await expect
      .poll(async () => (await compositionReport(page)).unavailable.length)
      .toBeGreaterThan(0);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect
      .poll(async () => {
        const r = await compositionReport(page);
        return r.position.numerator / r.position.denominator;
      })
      .toBeGreaterThan(2.7);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Pause', exact: true })
      .click();
    project.assets[1] = structuredClone(fixture.project.assets[1]!);
    project.clips.find((clip) => clip.id === 'pip')!.visual!.x = -479.5;
    await openComposition(
      application,
      page,
      fixture.directory,
      project,
      'offscreen',
    );
    await seekComposition(page, 75, ['base', 'image']);
    await expect(page.locator('video[data-timeline-clip="pip"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('video[data-timeline-clip="invisible"]'),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await compositionReport(page)).unavailable)
      .toEqual([]);
  } finally {
    await application.close();
  }
});
