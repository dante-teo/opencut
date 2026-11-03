import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MediaCache } from '../../packages/media/src/index.js';
import { launchDesktop } from './helpers.js';
import {
  compositionFixture,
  compositionReport,
  openComposition,
  seekComposition,
} from './t26-fixtures.js';

test('T26 mixed-resolution overlapping videos/image original and proxy benchmark', async () => {
  const { directory, project } = await compositionFixture();
  const cacheDirectory = join(directory, 'cache');
  const source = join(directory, 'base.mp4');
  const sourceHash = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  const cache = new MediaCache(cacheDirectory);
  expect((await cache.generateProxy(source)).proxy).toBe(true);
  const samples: Record<string, unknown>[] = [];
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: cacheDirectory,
  });
  const environment = {
    sourceSha256: sourceHash,
    harnessSha256: createHash('sha256')
      .update(await readFile(new URL('./t26.perf.ts', import.meta.url)))
      .digest('hex'),
    cpu: cpus()[0]?.model,
    platform: process.platform,
    arch: process.arch,
    release: release(),
    logicalCPUs: cpus().length,
    memoryGiB: totalmem() / 1024 ** 3,
    ...(await application.evaluate(({ app, BrowserWindow }) => ({
      versions: process.versions,
      gpuFeatures: app.getGPUFeatureStatus(),
      bounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
    }))),
  };
  try {
    for (const count of [2, 4, 6])
      for (const useProxy of [false, true]) {
        const candidate = structuredClone(project);
        candidate.settings.width = 1280;
        candidate.settings.height = 720;
        candidate.tracks = Array.from({ length: count + 1 }, (_, i) => ({
          id: `track-${i}`,
          name: `Layer ${i}`,
          type: 'video' as const,
        }));
        candidate.clips = Array.from({ length: count }, (_, i) => ({
          id: `layer-${i}`,
          assetId: i % 2 ? 'a1' : 'a0',
          trackId: `track-${i}`,
          timelineStart: { numerator: 0, denominator: 1 },
          sourceIn: { numerator: 0, denominator: 1 },
          sourceOut: { numerator: 6, denominator: 1 },
          muted: i !== 0,
          volume: 0.5,
          visual: {
            scale: i === 0 ? 1 : 0.4,
            x: i === 0 ? 0 : ((i % 3) - 1) * 300,
            y: i === 0 ? 0 : i % 2 ? -170 : 170,
            opacity: i === 0 ? 1 : 0.8,
          },
        }));
        candidate.clips.push({
          ...project.clips.find((clip) => clip.id === 'image')!,
          id: 'overlay',
          trackId: `track-${count}`,
          timelineStart: { numerator: 0, denominator: 1 },
          sourceOut: { numerator: 6, denominator: 1 },
        });
        await page.evaluate(
          (enabled) => window.opencut.mediaCache({ action: 'enable', enabled }),
          useProxy,
        );
        await openComposition(
          application,
          page,
          directory,
          candidate,
          `benchmark-${count}-${useProxy}`,
        );
        const layers = candidate.clips.map((clip) => clip.id);
        await seekComposition(page, 60, layers);
        await expect
          .poll(async () => (await compositionReport(page)).proxyDecoders)
          .toBe(useProxy ? Math.ceil(count / 2) : 0);
        const seekSamples: number[] = [];
        for (let index = -2; index < 12; index++) {
          const frame = [120, 15, 150, 30, 135, 60][(index + 6) % 6]!;
          const start = performance.now();
          await seekComposition(page, frame, layers);
          if (index >= 0) seekSamples.push(performance.now() - start);
        }
        await seekComposition(page, 0, layers);
        const before = await compositionReport(page);
        await page
          .locator('#project-viewer')
          .getByRole('button', { name: 'Play', exact: true })
          .click();
        await expect
          .poll(async () => (await compositionReport(page)).playing)
          .toBe(true);
        const resources = [];
        const started = performance.now();
        while (performance.now() - started < 3200) {
          resources.push(
            await page.evaluate(() => window.opencut.getPreviewMetrics()),
          );
          await page.waitForTimeout(500);
        }
        await page
          .locator('#project-viewer')
          .getByRole('button', { name: 'Pause', exact: true })
          .click();
        await expect(page.locator('canvas')).toHaveAttribute(
          'data-presented-layers',
          JSON.stringify(layers),
        );
        await expect
          .poll(async () => (await compositionReport(page)).paintedLayers)
          .toBe(count + 1);
        const after = await compositionReport(page);
        const elapsed = after.position.numerator / after.position.denominator;
        const sorted = seekSamples.sort((a, b) => a - b);
        const measurement = {
          videos: count,
          images: 1,
          useProxy,
          seekSamples,
          seekMedianMs: (sorted[5]! + sorted[6]!) / 2,
          seekP95Ms: sorted[11],
          rendererLastSeekMs: after.lastSeekLatencyMs,
          timelineSeconds: elapsed,
          compositeFps:
            (after.compositeFrames - before.compositeFrames) / elapsed,
          decoderCallbacksPerSecond:
            (after.presentedFrames - before.presentedFrames) / elapsed,
          droppedFrames: after.droppedFrames - before.droppedFrames,
          blankTicks: after.blankVisualTicks - before.blankVisualTicks,
          waits: after.waitingEvents - before.waitingEvents,
          maxCompositionMs: after.maxCompositionMs,
          maxAudioSkewMs: after.maxAudioSkewMs,
          maxMediaSkewMs: after.maxMediaSkewMs,
          meanCpuPercent:
            resources.slice(1).reduce((sum, r) => sum + r.cpuPercent, 0) /
            (resources.length - 1),
          peakWorkingSetMiB: Math.max(...resources.map((r) => r.workingSetMiB)),
          resources,
        };
        expect(after.unavailable).toEqual([]);
        expect(after.paintedLayers).toBe(count + 1);
        samples.push(measurement);
        console.log(
          'T26 measurement',
          JSON.stringify({
            ...measurement,
            resources: undefined,
            seekSamples: undefined,
          }),
        );
        await writeFile(
          join(directory, 'benchmark.json'),
          JSON.stringify(
            {
              environment,
              definitions:
                'Generated 6s H.264 1080p30 testsrc2/AAC440Hz, 120x240p25 portrait, alpha PNG. 1280x720 project at default Electron window. Two seek warmups + twelve seeks, then 3.2s playback per case. Composite FPS counts complete project-frame paints, callbacks sum visible video decoders. Seek samples include Playwright/UI/report polling; rendererLastSeekMs measures seek-to-all-layer presentation. CPU aggregates Electron processes; working set may double-count shared pages. One run per case, warm OS cache, uncontrolled thermal/background load; no physical audio/display loopback.',
              samples,
            },
            null,
            2,
          ),
        );
      }
    expect(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
    ).toBe(sourceHash);
    await page.screenshot({ path: join(directory, 'multilayer-electron.png') });
    console.log('T26 benchmark directory', directory);
  } finally {
    await application.close();
  }
});
