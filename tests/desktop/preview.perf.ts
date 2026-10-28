import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, release } from 'node:os';
import { expect, test } from '@playwright/test';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';
import type { PreviewBenchmark } from '../../apps/desktop/src/renderer/preview.js';
import { runMediaTool } from '../../packages/media/src/process.js';
import { chooseVideo, launchDesktop } from './helpers.js';

// Opt-in native performance suite; no downloads, thresholds or hardware assumptions.
test('reproducible HTML video preview measurements', async () => {
  const testInfo = test.info();
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const generated = resolve('tests/fixtures/generated');
  const fixtures = ['video-short.mp4', 'video-medium.mp4', 'video-long.mp4'];
  for (const fixture of fixtures) await readFile(join(generated, fixture));
  const owned = await mkdtemp(join(generated, 't04-'));
  try {
    for (const [file, rate, duration, gop] of [
      ['1080p30.mp4', '30', '12', '120'],
      ['1080p5994.mp4', '60000/1001', '10', '240'],
    ] as const) {
      // Burn a 10-bit frame ID into a black/white strip for independent pixel checks.
      const frameId = [
        'drawbox=x=0:y=0:w=320:h=32:color=black:t=fill',
        ...Array.from(
          { length: 10 },
          (_, bit) =>
            `drawbox=x=${bit * 32}:y=0:w=32:h=32:color=white:t=fill:enable='bitand(n,${2 ** bit})'`,
        ),
      ].join(',');
      runTool('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=1920x1080:rate=${rate}`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        duration,
        '-vf',
        frameId,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        '-g',
        gop,
        '-keyint_min',
        gop,
        '-sc_threshold',
        '0',
        '-bf',
        '3',
        '-threads:v',
        '2',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        join(owned, file),
      ]);
    }
    const { application, page } = await launchDesktop();
    try {
      const environment = await application.evaluate(
        async ({ app, screen }) => ({
          versions: process.versions,
          gpu: await app.getGPUInfo('basic'),
          gpuFeatures: app.getGPUFeatureStatus(),
          display: screen.getPrimaryDisplay(),
        }),
      );
      await writeFile(
        testInfo.outputPath('environment.json'),
        JSON.stringify(
          {
            cpu: cpus()[0]?.model,
            logicalCPUs: cpus().length,
            platform: process.platform,
            arch: process.arch,
            release: release(),
            ...environment,
          },
          null,
          2,
        ),
      );
      console.log(
        'T04 environment',
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          release: release(),
          cpu: cpus()[0]?.model,
          logicalCPUs: cpus().length,
          ...environment,
        }),
      );
      for (const path of [
        ...fixtures.map((fixture) => join(generated, fixture)),
        join(owned, '1080p30.mp4'),
        join(owned, '1080p5994.mp4'),
      ]) {
        const before = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
        await chooseVideo(application, page, path);
        await page.locator('.preview-details > summary').click();
        await page
          .getByRole('button', { name: 'Run performance validation' })
          .click();
        const output = page.getByTestId('benchmark-result');
        await expect(output).toBeAttached({ timeout: 55000 });
        const report = JSON.parse(
          (await output.textContent())!,
        ) as PreviewBenchmark;
        console.log(
          'T04 measurement',
          JSON.stringify({
            file: path.split('/').at(-1),
            sha256: before,
            ...report,
          }),
        );
        const metadata = JSON.parse(
          runTool('ffprobe', [
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            path,
          ]),
        ) as unknown;
        const resultPath = testInfo.outputPath(
          path.split('/').at(-1)! + '.json',
        );
        await writeFile(
          resultPath,
          JSON.stringify(
            {
              file: path.split('/').at(-1),
              sha256: before,
              metadata,
              ...report,
            },
            null,
            2,
          ),
        );
        await testInfo.attach(path.split('/').at(-1)! + '.json', {
          path: resultPath,
          contentType: 'application/json',
        });
        expect(report.seek.count).toBe(30);
        expect(report.playback.mediaSeconds).toBeGreaterThan(0.5);
        expect(report.playback.totalFrames).toBeGreaterThan(0);
        // Check reported frame PTS against the known CFR fixture clock, not currentTime.
        expect(report.seek.nominalFrameMismatches).toBe(0);
        // The diagnostics popover covers the video; expose pixels before sampling.
        await page.locator('.preview-details > summary').click();
        if (path.startsWith(owned)) {
          const stream = (
            metadata as {
              streams: { codec_type: string; nb_frames?: string }[];
            }
          ).streams.find((stream) => stream.codec_type === 'video')!;
          const lastFrame = Number(stream.nb_frames) - 1;
          for (const [frame, action] of [
            [120, 'seek'],
            [121, 'next'],
            [120, 'previous'],
            [238, 'seek'],
            [lastFrame, 'seek'],
            [lastFrame, 'next'],
          ] as const) {
            if (action === 'seek')
              await page
                .getByRole('slider', { name: 'Seek', exact: true })
                .fill(String(frame));
            else
              await page
                .getByRole('button', {
                  name: action === 'next' ? 'Next frame' : 'Previous frame',
                })
                .click();
            await expect(page.getByTestId('position')).toContainText(
              `Frame ${frame} `,
            );
            const imagePath = testInfo.outputPath(
              `${path.split('/').at(-1)}-frame-${frame}.png`,
            );
            const png = await page
              .locator('video')
              .screenshot({ path: imagePath, scale: 'css' });
            const width = png.readUInt32BE(16);
            const height = png.readUInt32BE(20);
            const rgb = await runMediaTool('ffmpeg', [
              '-v',
              'error',
              '-nostdin',
              '-i',
              imagePath,
              '-pix_fmt',
              'rgb24',
              '-f',
              'rawvideo',
              'pipe:1',
            ]);
            const contentWidth = Math.min(width, (height * 1920) / 1080);
            const contentHeight = (contentWidth * 1080) / 1920;
            const y = Math.floor(
              (height - contentHeight) / 2 + (16 / 1080) * contentHeight,
            );
            let observed = 0;
            for (let bit = 0; bit < 10; bit++) {
              const x = Math.floor(
                (width - contentWidth) / 2 +
                  ((bit * 32 + 16) / 1920) * contentWidth,
              );
              if (rgb[(y * width + x) * 3]! > 128) observed += 2 ** bit;
            }
            expect(observed, 'pixel frame ID after ' + action).toBe(frame);
          }
          console.log(
            'T04 pixel frame IDs verified',
            path.split('/').at(-1),
            `120 → 121 → 120 → 238 → ${lastFrame} → ${lastFrame}`,
          );
        }
        expect(
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ).toBe(before);
        await page.screenshot({
          path: testInfo.outputPath(path.split('/').at(-1)! + '.png'),
        });
      }
    } finally {
      await application.close();
    }
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
