import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { serializeProject } from '@opencut/core';
import { runMediaTool } from '../../packages/media/src/process.js';
import { auditProjects } from '../../scripts/t21-projects.js';
import { launchDesktop, commitReviewEdit } from './helpers.js';

test('timeline filmstrips and real waveforms follow headless trims, and fit the workspace', async () => {
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
  project.assets[0]!.metadata!.durationSeconds = 6;
  project.assets[0]!.duration = { numerator: 6, denominator: 1 };
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
    const waveform = page.locator(
      '.timeline-clip.audio .waveform .clip-artwork-tile',
    );
    const videoWaveform = page.locator(
      '.timeline-clip.video .waveform .clip-artwork-tile',
    );
    await expect(videoWaveform.first()).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30000 },
    );
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
    const jpeg = await filmstrip.first().locator('image').getAttribute('href');
    const pixels = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url!;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      return [1 / 8, 5 / 8].map((cell) =>
        Array.from(
          context.getImageData(img.width * cell, img.height / 2, 1, 1).data,
        ),
      );
    }, jpeg);
    expect(pixels[0]![0]).toBeGreaterThan(200);
    expect(pixels[1]![2]).toBeGreaterThan(200);
    for (const [tile, height] of [
      [waveform.first(), 32],
      [videoWaveform.first(), 10],
    ] as const) {
      const peaks = await tile
        .locator('.waveform-peaks path')
        .last()
        .evaluate((path, height) => {
          const canvas = document.createElement('canvas');
          canvas.width = Number(path.closest('svg')!.getAttribute('width'));
          canvas.height = height;
          const context = canvas.getContext('2d')!;
          context.fill(new Path2D(path.getAttribute('d')!));
          const level = (from: number, to: number) =>
            context
              .getImageData(from, 0, to - from, height)
              .data.filter((_value, index) => index % 4 === 3)
              .reduce(
                (total, alpha) => total + alpha / ((to - from) * height),
                0,
              );
          return { quiet: level(10, 55), loud: level(120, 220) };
        }, height);
      expect(peaks.quiet).toBe(0);
      expect(peaks.loud).toBeGreaterThan(100);
    }
    await page
      .getByRole('button', { name: 'Inspect clip preview-0', exact: true })
      .click();
    await expect(page.getByText('Source', { exact: true })).toBeVisible();
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
        await window.opencut.timelineArtwork(10_000, {
          projectId: state.state.project.metadata.id,
          expectedRevision: state.state.project.editing?.revision ?? 0,
          assetId: 'asset-0',
          kind: 'waveform',
          start: 1,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(invalid).toBe(true);
    const stale = await page.evaluate(() =>
      window.opencut.timelineArtwork(10_001, {
        projectId: 'other',
        expectedRevision: 0,
        assetId: 'asset-0',
        kind: 'waveform',
        start: 0,
      }),
    );
    expect(stale).toBeNull();
    await commitReviewEdit(page, path, {
      type: 'clip.trim',
      id: 'preview-0',
      in: 31,
    });
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

test('an unavailable filmstrip keeps its status label visible on a partly scrolled tile', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/artwork-label-'),
  );
  try {
    const project = auditProjects().cuts!;
    project.metadata.id = 't32-offscreen-label';
    const asset = project.assets[0]!;
    const duration = { numerator: 20, denominator: 1 };
    asset.duration = duration;
    asset.metadata!.durationSeconds = 20;
    asset.metadata!.hasAudio = false;
    project.assets = [asset];
    project.tracks = [project.tracks[0]!];
    project.clips = [{ ...project.clips[0]!, sourceOut: duration }];
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
      const tiles = page.locator('.filmstrip .clip-artwork-tile');
      await expect(tiles.first()).toHaveAttribute('data-status', 'unavailable');
      for (const [scrollLeft, labelIndex] of [
        [150, 0],
        [280, 1],
      ] as const) {
        await page.locator('.timeline-scroll').evaluate((element, left) => {
          element.scrollLeft = left;
        }, scrollLeft);
        await expect
          .poll(async () => Number(await tiles.first().getAttribute('x')))
          .toBeCloseTo(1 - scrollLeft);
        const tile = tiles.nth(labelIndex);
        await expect(tile).toHaveAttribute('data-status', 'unavailable');
        const label = tile.locator('.artwork-placeholder');
        await expect(label).toHaveText('Preview unavailable');
        await expect(tiles.locator('.artwork-placeholder')).toHaveCount(1);
        const bounds = await label.evaluate((element) => {
          const atlas = element.closest('svg')!;
          const clip = atlas.parentElement!.closest('svg')!;
          const tileX = atlas.x.baseVal.value;
          const text = (element as SVGTextElement).getBBox();
          return {
            labelLeft: tileX + text.x,
            labelRight: tileX + text.x + text.width,
            visibleLeft: Math.max(0, tileX),
            visibleRight: Math.min(
              clip.width.baseVal.value,
              tileX + atlas.width.baseVal.value,
            ),
          };
        });
        expect(bounds.labelLeft).toBeGreaterThanOrEqual(bounds.visibleLeft);
        expect(bounds.labelRight).toBeLessThanOrEqual(bounds.visibleRight);
      }
    } finally {
      await application.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('long source artwork stays aligned through viewport changes and a split on a multitrack timeline', async () => {
  test.setTimeout(120000);
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/artwork-long-'),
  );
  const source = join(directory, 'source.mp4');
  const path = join(directory, 'project.json');
  try {
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:r=5:d=1186',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=5:d=14',
      '-itsoffset',
      '1184',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=if(between(t\\,3\\,6)\\,0.7*sin(2*PI*440*t)\\,0):s=48000:d=16',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-g',
      '10',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-c:a',
      'aac',
      source,
    ]);
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=if(between(t\\,2\\,5)\\,0.6*sin(2*PI*550*t)\\,0):s=48000:d=12',
      '-c:a',
      'pcm_s16le',
      join(directory, 'tone.wav'),
    ]);
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'color=c=yellow:s=320x180',
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(directory, 'still.png'),
    ]);
    const original = await readFile(source);
    const project = auditProjects().cuts!;
    project.metadata.id = 't32-long-artwork';
    project.assets = [
      project.assets[0]!,
      project.assets[2]!,
      project.assets[3]!,
    ];
    const seconds = (numerator: number) => ({ numerator, denominator: 1 });
    Object.assign(project.assets[0]!, { duration: seconds(1200) });
    Object.assign(project.assets[0]!.metadata!, {
      width: 160,
      height: 90,
      durationSeconds: 1200,
      frameRate: 5,
      frameRateRatio: '5/1',
    });
    project.assets[1]!.duration = seconds(12);
    project.assets[1]!.metadata!.durationSeconds = 12;
    project.tracks.push({ id: 'a1', name: 'Ambience', type: 'audio' });
    project.clips = [
      {
        id: 'long',
        assetId: 'asset-0',
        trackId: 'v0',
        timelineStart: seconds(0),
        sourceIn: seconds(0),
        sourceOut: seconds(1200),
      },
      {
        id: 'still',
        assetId: 'asset-3',
        trackId: 'v1',
        timelineStart: seconds(1185),
        sourceIn: seconds(0),
        sourceOut: seconds(5),
      },
      {
        id: 'tone',
        assetId: 'asset-2',
        trackId: 'a0',
        timelineStart: seconds(1184),
        sourceIn: seconds(1),
        sourceOut: seconds(12),
      },
      {
        id: 'quiet',
        assetId: 'asset-0',
        trackId: 'a1',
        timelineStart: seconds(1184),
        sourceIn: seconds(0),
        sourceOut: seconds(12),
      },
    ];
    await writeFile(path, serializeProject(project));
    const { application, page } = await launchDesktop({
      OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
    });
    try {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await application.evaluate(({ BrowserWindow, dialog }, path) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1100);
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
      const clip = (id: string) =>
        page.getByRole('button', { name: 'Inspect clip ' + id, exact: true });
      const waveform = (id: string, start: number) =>
        clip(id).locator('.waveform [data-start="' + start + '"]');
      const peaks = (id: string, start: number) =>
        waveform(id, start).locator('.waveform-peaks path').last();
      const ready = (id: string, start: number) =>
        expect(waveform(id, start)).toHaveAttribute('data-status', 'ready', {
          timeout: 30000,
        });
      const scroll = (time: number, zoom: number) =>
        page.locator('.timeline-scroll').evaluate((element, left) => {
          element.scrollLeft = left;
        }, time * zoom);
      await ready('long', 0);
      await expect(peaks('long', 0)).toHaveAttribute('d', '');

      const filmstrip = (id: string) =>
        clip(id).locator('.filmstrip .clip-artwork-tile').first();
      const lateReady = async () => {
        await ready('long', 1184);
        await expect(filmstrip('long')).toHaveAttribute('data-status', 'ready');
        await ready('tone', 0);
        await ready('quiet', 0);
        await expect(filmstrip('still')).toHaveAttribute(
          'data-status',
          'ready',
        );
      };
      const coldStart = performance.now();
      // Briefly expose another region before navigating to the late edit.
      await scroll(600, 80);
      await scroll(1184, 80);
      await lateReady();
      const coldLateMs = performance.now() - coldStart;
      await expect(clip('still').locator('.waveform')).toHaveCount(0);
      await expect(peaks('quiet', 0)).toHaveAttribute('d', '');
      const peakX = async (id: string, start: number) =>
        Number(
          (await peaks(id, start).getAttribute('d'))?.match(/^M([\d.]+)/)?.[1],
        );
      expect(await peakX('long', 1184)).toBeCloseTo(237, -1);
      expect(await peakX('tone', 0)).toBeCloseTo(79, -1);

      await scroll(0, 80);
      await expect(waveform('long', 1184)).toHaveCount(0);
      const warmStart = performance.now();
      await scroll(1184, 80);
      await lateReady();
      const warmLateMs = performance.now() - warmStart;

      await page
        .getByLabel('Timeline zoom', { exact: true })
        .selectOption('160');
      await scroll(1184, 160);
      await ready('long', 1184);
      await expect.poll(() => peakX('long', 1184)).toBeCloseTo(477, -1);
      await expect(filmstrip('long')).toHaveAttribute('data-interval', '0.45');
      await expect(filmstrip('long')).toHaveAttribute('data-status', 'ready');

      await clip('long')
        .locator(':scope > rect')
        .first()
        .click({ position: { x: 100, y: 24 } });
      await page
        .getByRole('slider', { name: 'Timeline playhead' })
        .click({ position: { x: 720, y: 20 } });
      await commitReviewEdit(page, path, {
        type: 'clip.split',
        id: 'long',
        at: 35655,
      });
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const state = await window.opencut.getProject();
            return state.ok
              ? state.state?.project.editing?.revision
              : undefined;
          }),
        )
        .toBe(1);
      const state = await page.evaluate(() => window.opencut.getProject());
      const split =
        state.ok &&
        state.state?.project.clips.find(
          (entry) => entry.trackId === 'v0' && entry.id !== 'long',
        );
      if (!split) throw new Error('Missing split');
      expect(split.sourceIn.numerator / split.sourceIn.denominator).toBe(
        1188.5,
      );
      await ready(split.id, 1184);
      await expect(filmstrip(split.id)).toHaveAttribute('data-start', '1188.5');
      await expect(filmstrip(split.id)).toHaveAttribute('data-status', 'ready');
      expect(await peakX(split.id, 1184)).toBeLessThan(2);
      expect(errors).toEqual([]);
      expect(await readFile(source)).toEqual(original);
      console.log(
        JSON.stringify({ durationSeconds: 1200, coldLateMs, warmLateMs }),
      );
    } finally {
      await application.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
