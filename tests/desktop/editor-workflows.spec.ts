import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProject, frameTime } from '@opencut/core';
import { controlDesktopProject, writeProjectFile } from '@opencut/core/node';
import { launchDesktop, commitReviewEdit } from './helpers.js';

test('edits canvas and fit, caches an exact preview and exports a composited PNG', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'editor-desktop-'));
  const source = join(directory, 'blue.mp4');
  const output = join(directory, 'frame.png');
  const path = join(directory, 'project.opencut.json');
  try {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=128x96:r=30:d=1',
      '-c:v',
      'libx264',
      source,
    ]);
    const project = createProject({
      name: 'Desktop workflow',
      settings: {
        width: 128,
        height: 96,
        frameRate: { numerator: 30, denominator: 1 },
      },
    });
    project.assets.push({
      id: 'asset',
      name: 'Blue',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'blue.mp4' },
    });
    project.tracks.push({ id: 'track', name: 'Video', type: 'video' });
    project.clips.push({
      id: 'blue',
      assetId: 'asset',
      trackId: 'track',
      timelineStart: frameTime(0, project.settings.frameRate),
      sourceIn: frameTime(0, project.settings.frameRate),
      sourceOut: frameTime(30, project.settings.frameRate),
    });
    await writeProjectFile(project, path);
    const { application, page } = await launchDesktop({
      OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
    });
    try {
      await application.evaluate(
        ({ dialog }, { path, output }) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [path],
          });
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: output,
          });
        },
        { path, output },
      );
      await page
        .getByRole('button', { name: 'Open project', exact: true })
        .click();
      await commitReviewEdit(
        page,
        path,
        { type: 'canvas.set', width: 72 },
        { type: 'clip.visual', id: 'blue', fit: 'cover' },
      );
      await page
        .getByRole('button', { name: 'Inspect clip blue', exact: true })
        .click();
      const canvas = page.getByLabel('Edited timeline canvas');
      await expect(canvas).toHaveAttribute('data-visual-ready', 'true');
      await page.getByText('Preview quality', { exact: true }).click();
      await page.getByRole('checkbox', { name: 'Exact paused frames' }).check();
      await page
        .getByRole('slider', { name: 'Seek timeline', exact: true })
        .fill('1');
      await expect(canvas).toHaveAttribute('data-visual-ready', 'true');
      await page
        .getByRole('button', { name: 'Export frame', exact: true })
        .click();
      await expect
        .poll(async () =>
          (await readFile(output).catch(() => Buffer.alloc(0)))
            .subarray(0, 8)
            .toString('hex'),
        )
        .toBe('89504e470d0a1a0a');
      const frame = await readFile(output);
      expect([frame.readUInt32BE(16), frame.readUInt32BE(20)]).toEqual([
        72, 96,
      ]);
      const pixel = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        output,
        '-vf',
        'scale=1:1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
      expect(pixel[2]).toBeGreaterThan(220);
      expect(pixel[0]).toBeLessThan(20);
      const request = join(directory, 'desktop-control.json');
      await writeFile(request, JSON.stringify({ action: 'seek', frame: 8 }));
      const cli = await promisify(execFile)(process.execPath, [
        resolve('apps/cli/dist/index.js'),
        'desktop',
        'control',
        path,
        request,
        '--json',
      ]);
      expect(JSON.parse(cli.stdout).accepted).toBe(true);
      await expect(page.getByTestId('project-position')).toContainText(
        '00:00:00:08',
      );
      expect(
        await controlDesktopProject(path, { action: 'status' }),
      ).toMatchObject({
        accepted: true,
        state: {
          frame: 8,
          viewer: 'project',
          selection: { kind: 'clip', id: 'blue' },
        },
      });
      await controlDesktopProject(path, { action: 'render-preview' });
      const preview = page.getByLabel('Rendered timeline preview');
      await expect(preview).toBeVisible();
      await expect
        .poll(() =>
          preview.evaluate((video: HTMLVideoElement) => video.readyState),
        )
        .toBeGreaterThan(0);
      await controlDesktopProject(path, { action: 'play' });
      await expect
        .poll(() =>
          preview.evaluate((video: HTMLVideoElement) => video.currentTime),
        )
        .toBeGreaterThan(0.35);
      await controlDesktopProject(path, { action: 'pause' });
      await expect
        .poll(() => preview.evaluate((video: HTMLVideoElement) => video.paused))
        .toBe(true);
    } finally {
      await application.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
