import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createProject,
  frameTime,
  serializeProject,
  type Project,
} from '@opencut/core';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { TimelineDiagnostics } from '../../apps/desktop/src/renderer/timeline-playback.js';

export async function compositionFixture() {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't26-'));
  const generate = (args: string[], name: string) => {
    const result = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-nostdin', '-n', ...args, join(directory, name)],
      { encoding: 'utf8', timeout: 180000 },
    );
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr);
  };
  generate(
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1920x1080:r=30:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-threads',
      '2',
      '-g',
      '90',
      '-bf',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
    ],
    'base.mp4',
  );
  generate(
    [
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=120x240:r=25:d=6,drawbox=x=0:y=0:w=120:h=40:c=lime:t=fill',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-an',
    ],
    'portrait.mp4',
  );
  generate(
    [
      '-f',
      'lavfi',
      '-i',
      "nullsrc=s=160x80,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,80),0,128)'",
      '-frames:v',
      '1',
      '-threads',
      '1',
    ],
    'alpha.png',
  );
  const project = createProject({
    name: 'T26 multi-layer composition',
    settings: {
      width: 640,
      height: 360,
      frameRate: { numerator: 30, denominator: 1 },
      backgroundColor: '#183048',
    },
  });
  project.assets = ['base.mp4', 'portrait.mp4', 'alpha.png'].map((file, i) => ({
    id: `a${i}`,
    name: file,
    file: { type: 'relative', path: file },
    mediaTypes: i === 0 ? ['video', 'audio'] : ['video'],
    ...(i < 2 ? { duration: { numerator: 6, denominator: 1 } } : {}),
    metadata: {
      kind: i === 2 ? 'image' : 'video',
      formatName: i === 2 ? 'png_pipe' : 'mov,mp4',
      durationSeconds: i === 2 ? null : 6,
      width: [1920, 120, 160][i]!,
      height: [1080, 240, 80][i]!,
      videoCodec: i === 2 ? 'png' : 'h264',
      audioCodec: i === 0 ? 'aac' : null,
      frameRate: i === 0 ? 30 : i === 1 ? 25 : null,
      frameRateRatio: i === 0 ? '30/1' : i === 1 ? '25/1' : null,
      hasAudio: i === 0,
    },
  }));
  project.tracks = ['base', 'pip', 'image', 'invisible', 'tail'].map((id) => ({
    id: `track-${id}`,
    name: id,
    type: id === 'tail' ? 'audio' : 'video',
  }));
  const time = (n: number) => frameTime(n, project.settings.frameRate);
  project.clips = [
    {
      id: 'base',
      assetId: 'a0',
      trackId: 'track-base',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(180),
      volume: 0.5,
    },
    {
      id: 'pip',
      assetId: 'a1',
      trackId: 'track-pip',
      timelineStart: time(30),
      sourceIn: time(15),
      sourceOut: time(135),
      muted: true,
      visual: { scale: 0.5, x: 160, y: -70, fit: 'cover', opacity: 0.75 },
    },
    {
      id: 'image',
      assetId: 'a2',
      trackId: 'track-image',
      timelineStart: time(60),
      sourceIn: time(0),
      sourceOut: time(60),
      visual: { scale: 0.5, x: -40, y: 40, fit: 'contain', opacity: 0.5 },
    },
    {
      id: 'invisible',
      assetId: 'a0',
      trackId: 'track-invisible',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(180),
      muted: true,
      visual: { opacity: 0 },
    },
    {
      id: 'tail',
      assetId: 'a0',
      trackId: 'track-tail',
      timelineStart: time(180),
      sourceIn: time(0),
      sourceOut: time(30),
      volume: 0.25,
    },
  ];
  return { directory, project };
}

export async function openComposition(
  application: ElectronApplication,
  page: Page,
  directory: string,
  project: Project,
  name = 'project',
) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, serializeProject(project));
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
  await page.getByRole('tab', { name: 'Project viewer', exact: true }).click();
  const summary = page.locator('.timeline-diagnostics summary');
  if (!(await page.locator('.timeline-diagnostics[open]').count()))
    await summary.click();
  await expect(page.getByTestId('timeline-diagnostics')).toBeVisible();
  return path;
}
export async function compositionReport(
  page: Page,
): Promise<TimelineDiagnostics> {
  return JSON.parse(
    (await page.getByTestId('timeline-diagnostics').textContent())!,
  );
}
export async function seekComposition(
  page: Page,
  frame: number,
  layers: string[],
) {
  await page
    .getByRole('slider', { name: 'Seek timeline', exact: true })
    .fill(String(frame));
  await expect(page.locator('canvas')).toHaveAttribute(
    'data-presented-layers',
    JSON.stringify(layers),
    { timeout: 15000 },
  );
  await expect
    .poll(async () => {
      const report = await compositionReport(page);
      return report.position.numerator / report.position.denominator;
    })
    .toBeCloseTo(frame / 30, 5);
  // A layer ID alone cannot prove that the new source frame reached the canvas.
  const time = frameTime(frame, { numerator: 30, denominator: 1 });
  await expect(page.locator('canvas')).toHaveAttribute(
    'data-position',
    `${time.numerator}/${time.denominator}`,
  );
}
