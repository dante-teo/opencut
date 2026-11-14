import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  createProject,
  deserializeProject,
  executeTransaction,
  frameTime,
  projectRevision,
  serializeProject,
  type Project,
} from '@opencut/core';
import {
  controlDesktopProject,
  writeProjectFile,
  updateProjectFile,
} from '@opencut/core/node';
import { launchDesktop } from './helpers.js';

const root = resolve('tests/fixtures/generated');
const video = join(root, 'video-medium.mp4');
const audio = join(root, 'audio-tone.wav');
const available = await Promise.all(
  [video, audio].map((path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  ),
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
async function fixture() {
  test.skip(available.includes(false), 'Generate synthetic fixtures first.');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't18-'));
  const path = join(directory, 'project.json');
  cli('project', 'create', path, '--name', 'T18 editing verification');
  const videoId = cli('media', 'import', path, video).asset.id as string;
  const audioId = cli('media', 'import', path, audio).asset.id as string;
  const original = deserializeProject(await readFile(path, 'utf8'));
  const project = executeTransaction(original, {
    expectedRevision: projectRevision(original),
    operations: [
      { type: 'track.add', id: 'v1', name: 'Camera', mediaType: 'video' },
      { type: 'track.add', id: 'v2', name: 'Overlay', mediaType: 'video' },
      { type: 'track.add', id: 'a1', name: 'Music', mediaType: 'audio' },
      { type: 'track.add', id: 'a2', name: 'Effects', mediaType: 'audio' },
      {
        type: 'clip.add',
        id: 'c1',
        assetId: videoId,
        trackId: 'v1',
        at: 30,
        in: 30,
        out: 90,
      },
      {
        type: 'clip.add',
        id: 'c2',
        assetId: videoId,
        trackId: 'v1',
        at: 180,
        in: 0,
        out: 60,
      },
      {
        type: 'clip.add',
        id: 'overlay',
        assetId: videoId,
        trackId: 'v2',
        at: 300,
        in: 0,
        out: 60,
      },
      {
        type: 'clip.add',
        id: 'music',
        assetId: audioId,
        trackId: 'a1',
        at: 0,
        in: 0,
        out: 90,
      },
      {
        type: 'clip.add',
        id: 'effect',
        assetId: audioId,
        trackId: 'a2',
        at: 150,
        in: 0,
        out: 60,
      },
    ],
  }).project;
  await rm(path);
  await writeProjectFile(project, path);
  return { directory, path, project };
}
async function open(
  application: ElectronApplication,
  page: Page,
  path: string,
) {
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
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open project', exact: true }),
  ).toBeEnabled();
}
const clip = (page: Page, id = 'c1') =>
  page.getByRole('button', { name: `Inspect clip ${id}`, exact: true });
async function current(page: Page): Promise<Project> {
  return page.evaluate(async () => {
    const reply = await window.opencut.getProject();
    if (!reply.ok || !reply.state) throw new Error('No project state');
    return reply.state.project;
  });
}
async function startDrag(
  page: Page,
  id: string,
  dx: number,
  dy = 0,
  edge?: 'left' | 'right',
) {
  // Let selection/inspector layout and zoom/scroll observers settle before
  // capturing physical pointer coordinates; otherwise a drag can target a stale lane.
  if ((await clip(page, id).getAttribute('aria-pressed')) !== 'true')
    await clip(page, id).locator(':scope > rect').first().click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const target = edge
    ? clip(page, id).locator(`[data-trim="${edge}"]`)
    : clip(page, id).locator(':scope > rect').first();
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const viewport = await page
    .locator('.timeline-scroll')
    .evaluate((element) => ({
      y: element.getBoundingClientRect().top,
      height: element.clientHeight,
    }));
  // Lower lanes can be partly clipped at the default window size. Begin on
  // the visible part of the handle rather than beneath the timeline footer.
  const y = Math.max(
    box.y + 1,
    Math.min(box.y + box.height / 2, viewport.y + viewport.height - 4),
  );
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
}
async function release(page: Page) {
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Save project', exact: true }),
  ).toBeEnabled();
}
async function expectClip(
  page: Page,
  id: string,
  values: Partial<Project['clips'][number]>,
) {
  await expect
    .poll(async () =>
      (await current(page)).clips.find((clip) => clip.id === id),
    )
    .toMatchObject(values);
}
const rate = { numerator: 30, denominator: 1 };

test('moves, changes track, trims both edges, splits, deletes, restores history and saves the same state the CLI reads', async () => {
  const { directory, path, project } = await fixture();
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 1000),
    );
    await open(application, page, path);
    await page.getByLabel('Snap', { exact: true }).uncheck();
    const revision = projectRevision(project);
    await startDrag(page, 'c1', 80);
    await expect(page.getByTestId('edit-preview')).toBeVisible();
    expect(projectRevision(await current(page))).toBe(revision);
    expect(await readFile(path, 'utf8')).toBe(serializeProject(project));
    await release(page);
    await expectClip(page, 'c1', { timelineStart: frameTime(60, rate) });
    expect(projectRevision(await current(page))).toBe(revision + 1);
    await startDrag(page, 'c1', 40, 64);
    await release(page);
    await expectClip(page, 'c1', {
      timelineStart: frameTime(75, rate),
      trackId: 'v2',
    });
    await startDrag(page, 'c1', -40, 0, 'right');
    await release(page);
    await expectClip(page, 'c1', { sourceOut: frameTime(75, rate) });
    await startDrag(page, 'c1', 40, 0, 'left');
    await release(page);
    await expectClip(page, 'c1', {
      timelineStart: frameTime(90, rate),
      sourceIn: frameTime(45, rate),
    });
    const trimmed = await current(page);
    expect(trimmed.editing?.undo.length).toBe(project.editing!.undo.length + 4);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectClip(page, 'c1', {
      timelineStart: frameTime(75, rate),
      sourceIn: frameTime(30, rate),
    });
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectClip(page, 'c1', {
      timelineStart: frameTime(90, rate),
      sourceIn: frameTime(45, rate),
    });
    const ruler = page.getByRole('slider', { name: 'Timeline playhead' });
    await ruler.click({ position: { x: 280, y: 20 } });
    await page
      .getByRole('button', { name: 'Split at playhead', exact: true })
      .click();
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    const right = (await current(page)).clips.find(
      (entry) => !project.clips.some((old) => old.id === entry.id),
    )!;
    await clip(page, right.id).locator(':scope > rect').first().click();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await current(page)).clips.length).toBe(5);
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    );
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z',
    );
    await expect.poll(async () => (await current(page)).clips.length).toBe(5);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    const edited = await current(page);
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    expect(deserializeProject(await readFile(path, 'utf8'))).toEqual(edited);
    const inspected = cli('timeline', 'list', path);
    expect(
      inspected.tracks
        .flatMap((track: { clips: { id: string }[] }) => track.clips)
        .map((entry: { id: string }) => entry.id)
        .sort(),
    ).toEqual(edited.clips.map((entry) => entry.id).sort());
    await open(application, page, path);
    expect(await current(page)).toEqual(edited);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await current(page)).clips.length).toBe(5);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    await page.screenshot({ path: 'test-results/t18-edited.png' });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects overlap and incompatible tracks, cancels gestures and handles rejected IPC without changing project state', async () => {
  const { directory, path, project } = await fixture();
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 1000),
    );
    await open(application, page, path);
    await page.getByLabel('Snap', { exact: true }).uncheck();
    await startDrag(page, 'c1', 400);
    await expect(page.getByTestId('edit-preview')).toHaveClass(/invalid/);
    await release(page);
    await expect(page.getByRole('alert')).toContainText('overlap');
    expect(await current(page)).toEqual(project);
    await clip(page, 'music').scrollIntoViewIfNeeded();
    await startDrag(page, 'music', 0, -64);
    await release(page);
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await current(page)).toEqual(project);
    await startDrag(page, 'c1', 80);
    await page.keyboard.press('Escape');
    await release(page);
    await expect(page.getByTestId('edit-preview')).toHaveCount(0);
    expect(await current(page)).toEqual(project);
    await startDrag(page, 'c1', 80);
    await page
      .locator('.timeline-scroll')
      .dispatchEvent('pointercancel', { pointerId: 1 });
    await release(page);
    expect(await current(page)).toEqual(project);
    // An obsolete GUI revision is rejected by production IPC; the preview clears.
    await startDrag(page, 'c1', 80);
    const reply = await page.evaluate(
      async (project) =>
        window.opencut.editTimeline({
          projectId: project.metadata.id,
          expectedRevision: project.editing!.revision,
          label: 'Competing edit',
          operations: [{ type: 'clip.move', id: 'c2', at: 210 }],
        }),
      project,
    );
    expect(reply.ok).toBe(true);
    await release(page);
    await expect(page.getByRole('alert')).toContainText('revision conflict');
    await expect(page.getByTestId('edit-preview')).toHaveCount(0);
    await expect(clip(page)).toHaveAttribute('aria-pressed', 'true');
    // The rejected operation preserved c1; only the competing accepted edit was saved.
    expect(
      (await current(page)).clips.find((entry) => entry.id === 'c1'),
    ).toEqual(project.clips[0]);
    expect(deserializeProject(await readFile(path, 'utf8'))).toEqual(
      await current(page),
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('snaps at different zooms and supports focused keyboard movement and trimming', async () => {
  const { directory, path } = await fixture();
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    await page.getByLabel('Snap threshold pixels', { exact: true }).fill('8');
    // Snapping starts with a selected clip; selection/inspector mounting is covered separately.
    await clip(page).click();
    for (const zoom of [80, 160]) {
      await page
        .getByLabel('Timeline zoom', { exact: true })
        .selectOption(String(zoom));
      await page.locator('.timeline-scroll').evaluate((element) => {
        element.scrollLeft = 0;
      });
      await startDrag(page, 'c1', 3 * zoom - 5);
      await expect(page.locator('.snap-guide')).toHaveCount(1);
      await release(page);
      // Moving right edge meets the next clip's left edge at frame 180.
      await expectClip(page, 'c1', { timelineStart: frameTime(120, rate) });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expectClip(page, 'c1', { timelineStart: frameTime(30, rate) });
    }
    await clip(page).focus();
    await page.keyboard.press('ArrowRight');
    await expectClip(page, 'c1', { timelineStart: frameTime(31, rate) });
    await page
      .getByRole('button', { name: 'Trim end of c1', exact: true })
      .focus();
    await page.keyboard.press('ArrowLeft');
    await expectClip(page, 'c1', { sourceOut: frameTime(89, rate) });
    await clip(page).focus();
    await page.keyboard.press('ArrowDown');
    await expectClip(page, 'c1', { trackId: 'v2' });
    const scrollTop = await page
      .locator('.timeline-scroll')
      .evaluate((element) => element.scrollTop);
    // The partly visible lower lane must not jump when an edge receives focus.
    await startDrag(page, 'c1', -80, 0, 'right');
    await release(page);
    await expectClip(page, 'c1', { sourceOut: frameTime(74, rate) });
    expect(
      await page
        .locator('.timeline-scroll')
        .evaluate((element) => element.scrollTop),
    ).toBe(scrollTop);
    // Default-sized window keeps editing and zoom controls inside the viewport.
    for (const control of ['Split at playhead', 'Delete clip', 'Zoom in']) {
      const bounds = (await page
        .getByRole('button', { name: control, exact: true })
        .boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1080);
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('undo/redo of CLI media removal refreshes library availability and survives save/reopen', async () => {
  const { directory, path } = await fixture();
  await updateProjectFile(path, async (project) => ({
    project: {
      ...project,
      assets: [
        ...project.assets,
        { ...project.assets[0]!, id: 'unused', name: 'Unused video' },
      ],
    },
    result: null,
  }));
  cli('media', 'remove', path, 'unused');
  const { application, page } = await launchDesktop();
  try {
    await open(application, page, path);
    const library = page.getByRole('complementary', { name: 'Media library' });
    const unused = library.getByRole('button', { name: /Unused video/ });
    await expect(unused).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(unused).toHaveAttribute('draggable', 'true');
    const restored = await page.evaluate(() => window.opencut.getProject());
    expect(
      restored.ok &&
        restored.state?.media.filter((item) => item.status === 'available'),
    ).toHaveLength(3);
    expect(
      deserializeProject(await readFile(path, 'utf8')).assets.some(
        (asset) => asset.id === 'unused',
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(unused).toHaveCount(0);
    const reply = await page.evaluate(() => window.opencut.getProject());
    expect(reply).toMatchObject({
      ok: true,
      state: {
        media: expect.not.arrayContaining([
          expect.objectContaining({ assetId: 'unused' }),
        ]),
      },
    });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(unused).toHaveAttribute('draggable', 'true');
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    await open(application, page, path);
    await expect(unused).toHaveAttribute('draggable', 'true');
    expect((await current(page)).assets).toContainEqual(
      expect.objectContaining({ id: 'unused' }),
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('moves, ripples and inserts a video/audio selection and verifies the saved timeline through CLI', async () => {
  test.setTimeout(45_000);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't39-'));
  const path = join(directory, 'project.json');
  const rate = { numerator: 30, denominator: 1 };
  const time = (frame: number) => frameTime(frame, rate);
  const media = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=128x96:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(directory, 'interview.mp4'),
    ],
    { encoding: 'utf8' },
  );
  expect(media.status, media.stderr).toBe(0);
  const project = createProject({
    name: 'Creator workflow',
    settings: { width: 128, height: 96, frameRate: rate },
  });
  project.assets.push({
    id: 'source',
    name: 'Interview',
    file: { type: 'relative', path: 'interview.mp4' },
    mediaTypes: ['video', 'audio'],
  });
  project.tracks.push(
    { id: 'v', name: 'Camera', type: 'video' },
    { id: 'a', name: 'Dialogue', type: 'audio' },
  );
  project.clips.push(
    ...['v', 'a'].flatMap((trackId) => [
      {
        id: trackId + '0',
        trackId,
        assetId: 'source',
        timelineStart: time(0),
        sourceIn: time(0),
        sourceOut: time(30),
      },
      {
        id: trackId + '1',
        trackId,
        assetId: 'source',
        timelineStart: time(90),
        sourceIn: time(0),
        sourceOut: time(60),
        linkId: 'second-take',
      },
    ]),
  );
  await writeProjectFile(project, path);
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    await open(application, page, path);
    const body = (id: string) =>
      clip(page, id).locator(':scope > rect').first();
    await body('v0').click();
    await body('a0').click({ modifiers: ['Shift'] });
    await expect(clip(page, 'v0')).toHaveAttribute('aria-pressed', 'true');
    await expect(clip(page, 'a0')).toHaveAttribute('aria-pressed', 'true');
    const primary = process.platform === 'darwin' ? 'Meta' : 'Control';
    await body('a0').click({ modifiers: [primary] });
    await expect(clip(page, 'a0')).toHaveAttribute('aria-pressed', 'false');
    await body('a0').click({ modifiers: [primary] });
    await expect(clip(page, 'a0')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press(primary + '+c');
    await startDrag(page, 'v0', 80);
    await expect(page.getByTestId('edit-preview').locator('rect')).toHaveCount(
      2,
    );
    await release(page);
    const starts = async (ids: string[]) =>
      (await current(page)).clips
        .filter((entry) => ids.includes(entry.id))
        .map((entry) => entry.timelineStart);
    await expect.poll(() => starts(['v0', 'a0'])).toEqual([time(30), time(30)]);
    await page.keyboard.press('Shift+Delete');
    await expect.poll(() => starts(['v1', 'a1'])).toEqual([time(60), time(60)]);
    await expect.poll(() => starts(['v0', 'a0'])).toEqual([]);
    await controlDesktopProject(path, { action: 'seek', frame: 90 });
    await expect(
      page.getByRole('slider', { name: 'Timeline playhead' }),
    ).toHaveAttribute('aria-valuenow', '90');
    await page.locator('.timeline-scroll').focus();
    await page.keyboard.press(primary + '+Shift+v');
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    await page.keyboard.press(primary + '+z');
    await expect.poll(async () => (await current(page)).clips.length).toBe(2);
    await page.keyboard.press(primary + '+Shift+z');
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect
      .poll(async () => (await readFile(path, 'utf8')).includes('Insert clips'))
      .toBe(true);
    const timeline = cli('timeline', 'list', path);
    expect(
      timeline.tracks.map(
        (track: {
          clips: { timelineStart: unknown; timelineEnd: unknown }[];
        }) =>
          track.clips.map((entry) => [entry.timelineStart, entry.timelineEnd]),
      ),
    ).toEqual(
      Array.from({ length: 2 }, () => [
        [time(60), time(90)],
        [time(90), time(120)],
        [time(120), time(150)],
      ]),
    );
    expect(timeline.tracks[0].clips[2].linkId).toBe(
      timeline.tracks[1].clips[2].linkId,
    );
    expect(timeline.tracks[0].clips[2].linkId).not.toBe('second-take');
    await open(application, page, path);
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    await body('v1').click();
    await expect(clip(page, 'a1')).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.evaluate(async () => {
        const reply = await window.opencut.getProject();
        if (!reply.ok || !reply.state) throw new Error('No project state');
        const project = reply.state.project;
        return window.opencut.editTimeline({
          projectId: project.metadata.id,
          expectedRevision: project.editing?.revision ?? 0,
          operations: [{ type: 'clip.remove', id: 'v1' }],
          label: 'Remove one linked clip',
        });
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Use clips.remove'),
    });
    expect((await current(page)).clips).toHaveLength(6);

    const width = page.getByRole('spinbutton', { name: 'Timeline position' });
    await expect(width).toBeVisible();
    await width.focus({ timeout: 3000 });
    const revision = projectRevision(await current(page));
    await page.keyboard.press(primary + '+x');
    expect(projectRevision(await current(page))).toBe(revision);
    await page.locator('.timeline-scroll').focus();
    await page.keyboard.press(primary + '+x');
    await expect.poll(async () => (await current(page)).clips.length).toBe(4);
    await controlDesktopProject(path, { action: 'seek', frame: 60 });
    await expect(
      page.getByRole('slider', { name: 'Timeline playhead' }),
    ).toHaveAttribute('aria-valuenow', '60');
    await page.keyboard.press(primary + '+v');
    await expect.poll(async () => (await current(page)).clips.length).toBe(6);
    const lastId = timeline.tracks[0].clips[2].id as string;
    await body(lastId).click();
    await page.keyboard.press(primary + '+d');
    await expect.poll(async () => (await current(page)).clips.length).toBe(8);
    await controlDesktopProject(path, { action: 'seek', frame: 30 });
    await expect(
      page.getByRole('slider', { name: 'Timeline playhead' }),
    ).toHaveAttribute('aria-valuenow', '30');
    await page.locator('summary').filter({ hasText: 'Edit clips' }).click();
    await page
      .getByRole('button', { name: 'Close gap at playhead', exact: true })
      .click({ timeout: 3000 });
    await expect
      .poll(async () =>
        (await current(page)).clips
          .map((entry) => entry.timelineStart.numerator)
          .includes(0),
      )
      .toBe(true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
