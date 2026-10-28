import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { auditProjects } from '../../scripts/t21-projects.js';
import {
  distribution,
  type PreviewBenchmark,
} from '../../apps/desktop/src/renderer/preview.js';
import { chooseVideo, launchDesktop } from './helpers.js';

test('T21 source playback with representative timelines loaded', async () => {
  const directory = process.env.OPENCUT_T21_DIR;
  if (!directory)
    throw new Error('Run pnpm audit:t21 to generate isolated inputs.');
  const report: Record<string, unknown> = {
    cache:
      'Decoder-cold = video.load() before each seek; OS filesystem cache uncontrolled. Warm = existing benchmark after three warmup seeks.',
    cases: Object.fromEntries(
      Object.keys(auditProjects()).map((name) => [
        name,
        { status: 'unverified', reason: 'Not reached yet' },
      ]),
    ),
  };
  const cases = report.cases as Record<string, unknown>;
  const { application, page } = await launchDesktop();
  try {
    report.environment = await application.evaluate(
      async ({ app, screen, BrowserWindow }) => ({
        versions: process.versions,
        gpu: await app.getGPUInfo('basic'),
        gpuFeatures: app.getGPUFeatureStatus(),
        display: screen.getPrimaryDisplay(),
        windowBounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
      }),
    );
    for (const [name, project] of Object.entries(auditProjects())) {
      await application.evaluate(
        ({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [path],
          });
        },
        join(directory, `${name}.opencut.json`),
      );
      await page
        .getByRole('button', { name: 'Open project', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: project.metadata.name, exact: true }),
      ).toBeVisible();
      await page
        .getByRole('tab', { name: 'Project viewer', exact: true })
        .click();
      await expect(page.getByLabel('Edited timeline canvas')).toBeVisible();
      const projectBefore = await readFile(
        join(directory, `${name}.opencut.json`),
        'utf8',
      );
      cases[name] = {
        liveTimeline: {
          status: 'not-measured',
          reason:
            'Dedicated T24 desktop tests measure edited timeline playback.',
        },
        clips: project.clips.length,
        tracks: project.tracks.length,
      };
      // A loaded multi-track project is UI load only, never concurrent decoding.
      const sources = [name === 'cuts' ? 'mixed.webm' : 'source.mp4'];
      if (name === 'mixing') sources.push('mixing.mp4');
      for (const file of sources) {
        if (
          !(await access(join(directory, file)).then(
            () => true,
            () => false,
          ))
        ) {
          cases[`${name}/${file}`] = {
            status: 'unavailable',
            reason:
              'Generated media/export unavailable; rerun after resolving prerequisites.',
          };
          continue;
        }
        await chooseVideo(application, page, join(directory, file));
        const cold = await page
          .locator('video')
          .evaluate(async (video: HTMLVideoElement) => {
            const samples: {
              seekedMs: number;
              presentedMs: number;
              target: number;
              presented: number;
            }[] = [];
            for (const fraction of [0.7, 0.2, 0.8, 0.35, 0.6]) {
              video.pause();
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  clearTimeout(timer);
                  video.removeEventListener('loadeddata', ready);
                  video.removeEventListener('error', error);
                };
                const ready = () => {
                  cleanup();
                  resolve();
                };
                const error = () => {
                  cleanup();
                  reject(new Error('Cold reload failed'));
                };
                const timer = setTimeout(error, 10000);
                video.addEventListener('loadeddata', ready, { once: true });
                video.addEventListener('error', error, { once: true });
                video.load();
              });
              const target = video.duration * fraction;
              samples.push(
                await new Promise((resolve, reject) => {
                  const start = performance.now();
                  let seekedMs: number | null = null;
                  let presentedMs: number | null = null;
                  let presented = 0;
                  let callback = 0;
                  const cleanup = () => {
                    clearTimeout(timer);
                    video.cancelVideoFrameCallback(callback);
                    video.removeEventListener('seeked', seeked);
                  };
                  const finish = () => {
                    if (seekedMs !== null && presentedMs !== null) {
                      cleanup();
                      resolve({ seekedMs, presentedMs, target, presented });
                    }
                  };
                  const seeked = () => {
                    seekedMs = performance.now() - start;
                    finish();
                  };
                  const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error('Cold seek timed out'));
                  }, 5000);
                  video.addEventListener('seeked', seeked);
                  const observe: VideoFrameRequestCallback = (
                    _now,
                    metadata,
                  ) => {
                    // Ignore a late initial frame from load(), not the requested seek.
                    if (Math.abs(metadata.mediaTime - target) > 0.1) {
                      callback = video.requestVideoFrameCallback(observe);
                      return;
                    }
                    presented = metadata.mediaTime;
                    presentedMs = performance.now() - start;
                    finish();
                  };
                  callback = video.requestVideoFrameCallback(observe);
                  video.currentTime = target;
                }),
              );
            }
            return samples;
          });
        const details = page.locator('.preview-details');
        if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
          await details.locator('summary').click();
        await page
          .getByRole('button', { name: 'Run performance validation' })
          .click();
        const output = page.getByTestId('benchmark-result');
        await expect(output).toBeAttached({ timeout: 55000 });
        const warm = JSON.parse(
          (await output.textContent())!,
        ) as PreviewBenchmark;
        expect(warm.seek.count).toBe(30);
        expect(warm.playback.mediaSeconds).toBeGreaterThan(1);
        expect(warm.playback.totalFrames).toBeGreaterThan(0);
        cases[`${name}/${file}`] = {
          status: 'measured',
          kind:
            file === 'mixing.mp4'
              ? 'exported-file playback'
              : 'single-source playback with project loaded',
          decoderCold: {
            count: cold.length,
            seekedMs: distribution(cold.map((s) => s.seekedMs)),
            presentedMs: distribution(cold.map((s) => s.presentedMs)),
            samples: cold,
          },
          warm,
          decodedFps: warm.playback.totalFrames / warm.playback.wallSeconds,
          presentedFps:
            (warm.playback.totalFrames - warm.playback.droppedFrames) /
            warm.playback.wallSeconds,
        };
        await writeFile(
          join(directory, 'desktop.json'),
          JSON.stringify(report, null, 2) + '\n',
        );
      }
      expect(
        await readFile(join(directory, `${name}.opencut.json`), 'utf8'),
      ).toBe(projectBefore);
    }
  } finally {
    await writeFile(
      join(directory, 'desktop.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    await application.close();
  }
});
