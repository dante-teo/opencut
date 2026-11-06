import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { serializeProject } from '@opencut/core';
import { MediaCache, probeMedia } from '../../packages/media/src/index.js';
import { runMediaTool } from '../../packages/media/src/process.js';
import { auditProjects } from '../../scripts/t21-projects.js';
import { launchDesktop } from './helpers.js';
import type { TimelineDiagnostics } from '../../apps/desktop/src/renderer/timeline-playback.js';

test('T25 original/proxy timeline seek and playback benchmark', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/t25-benchmark-'),
  );
  const cacheDirectory = join(directory, 'cache');
  const cache = new MediaCache(cacheDirectory);
  const report: {
    environment: unknown;
    definitions: string;
    cases: Record<string, unknown>;
  } = {
    environment: {
      cpu: cpus()[0]?.model,
      logicalCPUs: cpus().length,
      platform: process.platform,
      arch: process.arch,
      release: release(),
      totalMemoryGiB: totalmem() / 1024 ** 3,
      node: process.version,
      harnessSha256: createHash('sha256')
        .update(await readFile(resolve('tests/desktop/t25.perf.ts')))
        .digest('hex'),
      ffmpeg: (await runMediaTool('ffmpeg', ['-version']))
        .toString()
        .split('\n')[0],
      ffprobe: (await runMediaTool('ffprobe', ['-version']))
        .toString()
        .split('\n')[0],
    },
    definitions:
      'Synthetic testsrc2 H.264 high profile CRF20, GOP120, B3, 30fps, 8s, AAC48k. Original then proxy at default window, 2 repetitions each. 3 seek warmups; 20 alternating deterministic seeks; completion requires mapped currentTime and presented canvas. Playback samples 4s after start. Electron aggregate CPU/working-set sampled every 500ms; shared pages may be double counted. OS cache, thermals and system load uncontrolled. Native decoder memory is not the configured PNG-memory budget.',
    cases: {},
  };
  const save = () =>
    writeFile(
      join(directory, 'benchmark.json'),
      JSON.stringify(report, null, 2),
    );
  console.log('T25 results directory', directory);
  await save();
  for (const [label, size] of [
    ['1080p', '1920x1080'],
    ['4K', '3840x2160'],
  ] as const) {
    const source = join(directory, `${label}.mp4`);
    await runMediaTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=30`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '8',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-g',
        '120',
        '-keyint_min',
        '120',
        '-sc_threshold',
        '0',
        '-bf',
        '3',
        '-threads',
        '2',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        source,
      ],
      undefined,
      180000,
    );
    const hash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    const started = performance.now();
    const proxy = await cache.generateProxy(source);
    expect(proxy.proxy).toBe(true);
    const generationMs = performance.now() - started;
    const results: Record<string, unknown>[] = [];
    report.cases[label] = {
      sourceMetadata: await probeMedia(source),
      sha256: hash,
      sourceBytes: (await stat(source)).size,
      proxyMetadata: await probeMedia(proxy.path),
      proxyBytes: (await stat(proxy.path)).size,
      generationMs,
      results,
    };
    await save();
    const project = auditProjects().cuts!;
    project.assets = [project.assets[0]!];
    project.assets[0]!.file = { type: 'relative', path: `${label}.mp4` };
    project.assets[0]!.metadata!.width = label === '4K' ? 3840 : 1920;
    project.assets[0]!.metadata!.height = label === '4K' ? 2160 : 1080;
    project.clips = [
      { ...project.clips[0]!, sourceOut: { numerator: 8, denominator: 1 } },
    ];
    const path = join(directory, `${label}.json`);
    await writeFile(path, serializeProject(project));
    const { application, page } = await launchDesktop({
      OPENCUT_MEDIA_CACHE: cacheDirectory,
    });
    try {
      report.environment = {
        ...(report.environment as object),
        ...(await application.evaluate(
          async ({ app, BrowserWindow, screen }) => ({
            versions: process.versions,
            gpuFeatures: app.getGPUFeatureStatus(),
            display: screen.getPrimaryDisplay(),
            bounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
          }),
        )),
      };
      await page.evaluate(() =>
        window.opencut.mediaCache({ action: 'enable', enabled: false }),
      );
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
      }, path);
      await page
        .getByRole('button', { name: 'Open project', exact: true })
        .click();
      await page.locator('.timeline-diagnostics summary').click();
      for (const useProxy of [false, true])
        for (let repetition = 0; repetition < 2; repetition++) {
          await page.evaluate(
            (enabled) =>
              window.opencut.mediaCache({ action: 'enable', enabled }),
            useProxy,
          );
          const video = page.locator('video[data-timeline-clip]');
          await expect(video).toHaveAttribute('data-proxy', String(useProxy), {
            timeout: 15000,
          });
          await expect
            .poll(() =>
              video.evaluate((video: HTMLVideoElement) => video.videoWidth),
            )
            .toBe(useProxy ? 960 : label === '4K' ? 3840 : 1920);
          const seek = await page.evaluate(async () => {
            const slider = document.querySelector<HTMLInputElement>(
              '[aria-label="Seek timeline"]',
            )!;
            const samples: number[] = [];
            const targetFrames = [180, 15, 150, 30, 210, 45, 120, 60, 195, 75];
            for (let index = -3; index < 20; index++) {
              const frame = targetFrames[(index + 10) % targetFrames.length]!;
              const start = performance.now();
              Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
              )!.set!.call(slider, String(frame));
              slider.dispatchEvent(new Event('input', { bubbles: true }));
              slider.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise<void>((resolve, reject) => {
                const wait = () => {
                  const video = document.querySelector<HTMLVideoElement>(
                    'video[data-timeline-clip]',
                  )!;
                  const canvas = document.querySelector('canvas')!;
                  if (
                    video &&
                    !video.seeking &&
                    Math.abs(video.currentTime - frame / 30) < 0.04 &&
                    canvas.dataset.presentedClip === 'c0'
                  )
                    resolve();
                  else if (performance.now() - start > 8000)
                    reject(new Error('Seek presentation timed out.'));
                  else requestAnimationFrame(wait);
                };
                requestAnimationFrame(wait);
              });
              if (index >= 0) samples.push(performance.now() - start);
            }
            const sorted = [...samples].sort((a, b) => a - b);
            return {
              samples,
              medianMs:
                (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) /
                2,
              p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
            };
          });
          await page
            .getByRole('slider', { name: 'Seek timeline', exact: true })
            .fill('0');
          const before: TimelineDiagnostics = JSON.parse(
            (await page
              .getByTestId('timeline-diagnostics')
              .getAttribute('data-report'))!,
          );
          await page
            .locator('#project-viewer')
            .getByRole('button', { name: 'Play', exact: true })
            .click();
          const resources: {
            cpuPercent: number;
            workingSetMiB: number;
            processCount: number;
          }[] = [];
          const playbackStarted = performance.now();
          while (performance.now() - playbackStarted < 4000) {
            resources.push(
              await page.evaluate(() => window.opencut.getPreviewMetrics()),
            );
            await new Promise((r) => setTimeout(r, 500));
          }
          await page
            .locator('#project-viewer')
            .getByRole('button', { name: 'Pause', exact: true })
            .click();
          const after: TimelineDiagnostics = JSON.parse(
            (await page
              .getByTestId('timeline-diagnostics')
              .getAttribute('data-report'))!,
          );
          const wallSeconds = (performance.now() - playbackStarted) / 1000;
          results.push({
            useProxy,
            repetition,
            seek,
            playback: {
              wallSeconds,
              presentedCallbacks:
                after.presentedFrames - before.presentedFrames,
              presentedCallbacksPerSecond:
                (after.presentedFrames - before.presentedFrames) / wallSeconds,
              droppedFrames: after.droppedFrames - before.droppedFrames,
              waits: after.waitingEvents - before.waitingEvents,
              blankTicks: after.blankVisualTicks - before.blankVisualTicks,
              maxMediaSkewMs: after.maxMediaSkewMs,
              maxAudioSkewMs: after.maxAudioSkewMs,
              decoders: after.decoders,
              proxyDecoders: after.proxyDecoders,
            },
            resources,
            meanCPUPercent:
              resources.slice(1).reduce((n, r) => n + r.cpuPercent, 0) /
              (resources.length - 1),
            peakWorkingSetMiB: Math.max(
              ...resources.map((r) => r.workingSetMiB),
            ),
            cache: await page.evaluate(() =>
              window.opencut.mediaCache({ action: 'status' }),
            ),
          });
          console.log(
            'T25 measurement',
            JSON.stringify({
              label,
              ...results.at(-1)!,
              resources: undefined,
              cache: undefined,
            }),
          );
          await save();
        }
      expect(
        createHash('sha256')
          .update(await readFile(source))
          .digest('hex'),
      ).toBe(hash);
    } finally {
      await application.close();
    }
  }
  await test.info().attach('benchmark.json', {
    path: join(directory, 'benchmark.json'),
    contentType: 'application/json',
  });
});
