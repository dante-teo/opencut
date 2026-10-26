import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createProject, deserializeProject, type Project } from '@opencut/core';
import { writeProjectFile } from '@opencut/core/node';
import { launchDesktop } from './helpers.js';

const fixtureRoot = resolve('tests/fixtures/generated');
const fixture = join(fixtureRoot, 'video-medium.mp4');
test.beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true });
});
const available = await access(fixture).then(
  () => true,
  () => false,
);
const cli = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [resolve('apps/cli/dist/index.js'), ...args, '--json'],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};
async function openProject(
  application: ElectronApplication,
  page: Page,
  path: string,
) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Timeline verification', exact: true }),
  ).toBeVisible();
}
async function setup(path: string) {
  cli(
    'project',
    'create',
    path,
    '--name',
    'Timeline verification',
    '--fps',
    '30000/1001',
  );
  const asset = cli('media', 'import', path, fixture).asset.id as string;
  const tracks = [];
  for (const [name, type] of [
    ['Camera', 'video'],
    ['Overlay', 'video'],
    ['Music', 'audio'],
  ]) {
    tracks.push(
      cli('track', 'add', path, '--name', name!, '--type', type!).track
        .id as string,
    );
  }
  for (const [track, start, sourceIn, out] of [
    [tracks[0], '0', '15', '60'],
    [tracks[0], '120', '0', '60'],
    [tracks[1], '15', '0', '60'],
    [tracks[2], '30', '0', '75'],
  ])
    cli(
      'clip',
      'add',
      path,
      asset,
      '--track',
      track!,
      '--at',
      start!,
      '--in',
      sourceIn!,
      '--out',
      out!,
    );
  return deserializeProject(await readFile(path, 'utf8'));
}

test('CLI-created tracks, gaps, cross-track overlaps, ruler, zoom anchor and persistent viewport', async () => {
  test.skip(!available, 'Generate synthetic fixtures first.');
  const directory = await mkdtemp(join(fixtureRoot, 't17-'));
  const path = join(directory, 'timeline.json');
  const project = await setup(path);
  const original = await readFile(path, 'utf8');
  const { application, page } = await launchDesktop();
  try {
    await openProject(application, page, path);
    await expect(page.locator('.timeline-row[data-track-id]')).toHaveCount(3);
    expect(
      await page.locator('.track-heading strong').allTextContents(),
    ).toEqual(['Camera', 'Overlay', 'Music']);
    const clip = (n: number) =>
      page.getByRole('button', {
        name: `Inspect clip ${project.clips[n]!.id}`,
        exact: true,
      });
    const rect = async (n: number) => ({
      x: Number(await clip(n).locator(':scope > rect').getAttribute('x')),
      width: Number(
        await clip(n).locator(':scope > rect').getAttribute('width'),
      ),
    });
    expect((await rect(0)).width).toBeCloseTo(120.12, 3);
    expect((await rect(1)).x).toBeCloseTo(320.32, 3);
    expect((await rect(2)).x).toBeCloseTo(40.04, 3);
    const ruler = page.getByRole('slider', { name: 'Timeline playhead' });
    await ruler.click({ position: { x: 80.08, y: 20 } });
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:01:00 NDF',
    );
    await clip(0).click();
    await expect(clip(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:01:00 NDF',
    );
    await ruler.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:01:01 NDF',
    );
    const rulerBounds = (await ruler.boundingBox())!;
    await page.mouse.move(rulerBounds.x + 40.04, rulerBounds.y + 20);
    await page.mouse.down();
    await page.mouse.move(rulerBounds.x + 160.16, rulerBounds.y + 20, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:02:00 NDF',
    );
    // Native capture can be released before the terminal event; the owned
    // gesture still commits when its release is delivered to the ruler.
    await page.mouse.move(rulerBounds.x + 40.04, rulerBounds.y + 20);
    await page.mouse.down();
    await ruler.evaluate((element) => element.releasePointerCapture(1));
    await page.mouse.move(rulerBounds.x + 160.16, rulerBounds.y + 20);
    await page.mouse.up();
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:02:00 NDF',
    );
    // A native input batch may deliver pointerup without a final pointermove.
    await page.mouse.move(rulerBounds.x + 40.04, rulerBounds.y + 20);
    await page.mouse.down();
    await ruler.dispatchEvent('pointerup', {
      pointerId: 1,
      button: 0,
      clientX: rulerBounds.x + 160.16,
      clientY: rulerBounds.y + 20,
    });
    await page.mouse.up();
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:02:00 NDF',
    );
    await page.getByLabel('Timeline zoom', { exact: true }).selectOption('320');
    const scroller = page.locator('.timeline-scroll');
    await scroller.evaluate((element) => {
      element.scrollLeft = 500;
    });
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBe(500);
    await page.waitForTimeout(50);
    const bounds = (await ruler.boundingBox())!;
    await page.mouse.move(bounds.x + 250, bounds.y + 15);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue(
      '640',
    );
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBeCloseTo(1250, 0);
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue(
      '640',
    );
    expect(
      await scroller.evaluate((element) => element.scrollLeft),
    ).toBeCloseTo(1250, 0);
    await ruler.click({ position: { x: 250, y: 20 } });
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:02:10 NDF',
    );
    await page.screenshot({ path: 'test-results/t17-timeline.png' });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(640, 720),
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(640);
    for (const control of [
      page.getByLabel('Timeline zoom', { exact: true }),
      page.getByRole('button', { name: 'Zoom in', exact: true }),
      page.getByRole('button', { name: 'Preview selected clip' }),
    ]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(640);
    }

    expect(await readFile(path, 'utf8')).toBe(original);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('linked trimmed video source follows ruler seeks and playback independently of clip selection', async () => {
  test.skip(!available, 'Generate synthetic fixtures first.');
  const directory = await mkdtemp(join(fixtureRoot, 't17-'));
  const path = join(directory, 'timeline.json');
  const project = await setup(path);
  const { application, page } = await launchDesktop();
  try {
    await openProject(application, page, path);
    await page
      .getByRole('button', { name: `Inspect clip ${project.clips[0]!.id}` })
      .click();
    await page.getByRole('button', { name: 'Preview selected clip' }).click();
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(0.5005, 3);
    await page
      .getByRole('button', { name: `Inspect clip ${project.clips[1]!.id}` })
      .click();
    await page.getByRole('button', { name: 'Preview selected clip' }).click();
    const play = page.getByRole('button', { name: 'Play', exact: true });
    await expect(play).toBeEnabled();
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:04:00 NDF',
    );
    const ruler = page.getByRole('slider', { name: 'Timeline playhead' });
    await ruler.click({ position: { x: 400.4, y: 20 } });
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(1.001, 3);
    await page
      .getByRole('button', { name: `Inspect clip ${project.clips[2]!.id}` })
      .click();
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:05:00 NDF',
    );
    await play.click();
    await expect
      .poll(async () => Number(await ruler.getAttribute('aria-valuenow')))
      .toBeGreaterThan(150);
    // Repeating a seek to the last requested target must still seek after playback.
    await ruler.click({ position: { x: 400.4, y: 20 } });
    await expect(play).toBeEnabled();
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(1.001, 3);
    await play.click();
    // Source playback does not advance through other timeline clips.
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:06:00 NDF',
      { timeout: 6000 },
    );
    await ruler.click({ position: { x: 200, y: 20 } });
    await expect(
      page.getByRole('tab', { name: 'Project viewer', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.paused),
      )
      .toBe(true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('empty and large timelines bound DOM work and scroll to distant tracks and clips', async () => {
  const directory = await mkdtemp(join(fixtureRoot, 't17-'));
  const path = join(directory, 'large.json');
  const project: Project = createProject({ name: 'Timeline verification' });
  const { application, page } = await launchDesktop();
  try {
    await writeProjectFile(project, path);
    await openProject(application, page, path);
    await expect(
      page.getByText(
        'No timeline tracks. Add tracks and clips through the CLI.',
      ),
    ).toBeVisible();
    project.assets = [
      {
        id: 'offline',
        name: 'Offline synthetic video',
        file: { type: 'relative', path: 'missing.mp4' },
        mediaTypes: ['video'],
      },
    ];
    project.tracks = Array.from({ length: 120 }, (_, n) => ({
      id: `track-${n}`,
      name: `Track ${n}`,
      type: 'video' as const,
    }));
    project.clips = Array.from({ length: 24_000 }, (_, n) => ({
      id: `clip-${n}`,
      assetId: 'offline',
      trackId: `track-${Math.floor(n / 200)}`,
      timelineStart: { numerator: (n % 200) * 4320, denominator: 1 },
      sourceIn: { numerator: 0, denominator: 1 },
      sourceOut: { numerator: 3600, denominator: 1 },
    }));
    // Replace only this test-owned generated project, through core persistence.
    await rm(path);
    await writeProjectFile(project, path);
    const started = performance.now();
    await openProject(application, page, path);
    await expect(page.locator('.timeline-clip').first()).toBeVisible();
    const loadMs = performance.now() - started;
    await page.getByLabel('Timeline zoom', { exact: true }).selectOption('640');
    const scroller = page.locator('.timeline-scroll');
    const scrollStarted = performance.now();
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.scrollLeft = element.scrollWidth;
    });
    await expect(page.locator('[data-track-id="track-119"]')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Inspect clip clip-23999',
        exact: true,
      }),
    ).toBeVisible();
    const scrollMs = performance.now() - scrollStarted;
    const ruler = page.getByRole('slider', { name: 'Timeline playhead' });
    await ruler.focus();
    await page.keyboard.press('End');
    await expect(page.getByTestId('timeline-playhead')).toBeVisible();
    expect(await page.locator('.timeline-clip').count()).toBeLessThan(15);
    expect(
      await page.locator('.timeline-row[data-track-id]').count(),
    ).toBeLessThan(10);
    const stats = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.timeline-panel *').length,
      scrollWidth: document.querySelector('.timeline-scroll')!.scrollWidth,
    }));
    console.log(
      JSON.stringify({
        clips: project.clips.length,
        tracks: project.tracks.length,
        loadMs,
        scrollMs,
        ...stats,
      }),
    );
    await page.screenshot({ path: 'test-results/t17-large-timeline.png' });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('valid rational rates render empty projects and support ruler and keyboard seeks without overflow', async () => {
  const directory = await mkdtemp(join(fixtureRoot, 't17-rational-'));
  const emptyPath = join(directory, 'empty.json');
  const populatedPath = join(directory, 'populated.json');
  const project = createProject({
    name: 'Timeline verification',
    settings: {
      width: 1920,
      height: 1080,
      frameRate: {
        numerator: 3_000_000_000_000_001,
        denominator: 100_000_000_000_000,
      },
    },
  });
  const { application, page } = await launchDesktop();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await writeProjectFile(project, emptyPath);
    await openProject(application, page, emptyPath);
    await expect(
      page.getByRole('heading', {
        name: 'Timeline (0 tracks · 0 clips)',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('.time-ruler text')).not.toHaveCount(0);
    project.assets = [
      {
        id: 'video',
        name: 'Offline synthetic video',
        file: { type: 'relative', path: 'missing.mp4' },
        mediaTypes: ['video'],
      },
    ];
    project.tracks = [{ id: 'camera', name: 'Camera', type: 'video' }];
    project.clips = [
      {
        id: 'clip',
        assetId: 'video',
        trackId: 'camera',
        timelineStart: { numerator: 0, denominator: 1 },
        sourceIn: { numerator: 0, denominator: 1 },
        sourceOut: { numerator: 20, denominator: 1 },
      },
    ];
    await writeProjectFile(project, populatedPath);
    const original = await readFile(populatedPath, 'utf8');
    await openProject(application, page, populatedPath);
    const ruler = page.getByRole('slider', { name: 'Timeline playhead' });
    await ruler.click({ position: { x: 400, y: 20 } });
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:05:00 NDF',
    );
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:05:01 NDF',
    );
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:05:00 NDF',
    );
    await page.keyboard.press('End');
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:20:00 NDF',
    );
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('timeline-timecode')).toHaveText(
      '00:00:19:29 NDF',
    );
    for (const zoom of ['5', '80', '640']) {
      await page
        .getByLabel('Timeline zoom', { exact: true })
        .selectOption(zoom);
      await expect(page.locator('.time-ruler text')).not.toHaveCount(0);
    }
    expect(errors).toEqual([]);
    expect(await readFile(populatedPath, 'utf8')).toBe(original);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
