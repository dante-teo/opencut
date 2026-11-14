import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  createProject,
  deserializeProject,
  evaluateTimelineFrame,
  frameTime,
  parseClipSpeed,
  setClipSpeed,
  serializeProject,
  splitClip,
  type Project,
} from '@opencut/core';
import {
  launchDesktop,
  commitReviewEdit,
  restoreReviewEdit,
} from './helpers.js';
import { openComposition } from './t26-fixtures.js';
import {
  decodeAudio,
  exportAmplitudes,
  observeAudioOutput,
  recordPreviewAudio,
  sampleOnsets,
} from './t27-audio.js';
import {
  command,
  compareRgb,
  decodeFrames,
  exportProject,
  ffmpeg,
  observeNativePaint,
  readCanvas,
  verifyVideoTimestamps,
} from './t27-comparison.js';

const rate = { numerator: 30, denominator: 1 };
const time = (frame: number) => frameTime(frame, rate);
const seconds = (value: ReturnType<typeof time>) =>
  value.numerator / value.denominator;
const width = 320;
const height = 180;

async function comparePreviewFrame(
  page: Page,
  project: Project,
  frame: number,
  exported: Buffer,
) {
  const evaluated = evaluateTimelineFrame(project, frame);
  const layers = evaluated.visualClips.map(({ id }) => id);
  const sources = evaluated.visualClips
    .filter(({ kind }) => kind === 'video')
    .map(({ sourceTime }) => seconds(sourceTime));
  await page.getByRole('slider', { name: 'Seek timeline' }).fill(String(frame));
  const position = time(frame);
  let mean = 0;
  await expect
    .poll(
      async () => {
        const preview = await readCanvas(
          page,
          `${position.numerator}/${position.denominator}`,
          layers,
          sources,
        );
        if (!preview) return false;
        const result = compareRgb(preview.rgb, exported, {
          mean: 6,
          p95: 20,
          largePixelFraction: 0.015,
        });
        mean = result.metrics.mean;
        return result.passed;
      },
      { message: `Canvas frame ${frame}` },
    )
    .toBe(true);
  return mean;
}

test('T36 headless speed edits, Canvas frames and pitch-preserved audio agree with encoded media', async () => {
  test.setTimeout(100_000);
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't36-'));
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=30:d=5',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.28*sin(2*PI*440*t)*between(t\\,1.5\\,2.3):s=48000:d=5',
      '-vf',
      "drawbox=color=white:t=fill:enable='gte(n,45)*lt(n,69)'",
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(directory, 'marker.mp4'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.20*sin(2*PI*880*t)*between(t\\,1.5\\,2.3):s=48000:d=5',
      '-c:a',
      'pcm_s16le',
      join(directory, 'tone.wav'),
    ]);
    await observeNativePaint(page);
    await observeAudioOutput(page);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    const baseline = createProject({
      name: 'Retimed sync markers',
      settings: { width, height, frameRate: rate },
    });
    baseline.assets = ['marker.mp4', 'tone.wav'].map((path, i) => ({
      id: `asset-${i}`,
      name: path,
      mediaTypes: i === 0 ? ['video', 'audio'] : ['audio'],
      duration: time(150),
      file: { type: 'relative', path },
    }));
    baseline.tracks = [
      { id: 'v', name: 'Video', type: 'video' },
      { id: 'a', name: 'Audio', type: 'audio', volume: 0.75 },
    ];
    baseline.clips = baseline.assets.map(({ id }, i) => ({
      id: i === 0 ? 'picture' : 'tone',
      assetId: id,
      trackId: i === 0 ? 'v' : 'a',
      timelineStart: time(3),
      sourceIn: time(15),
      sourceOut: time(136),
      fadeIn: { duration: time(3) },
      fadeOut: { duration: time(3) },
    }));
    baseline.subtitles = {
      style: {},
      cues: [{ id: 'caption', text: 'T36', start: time(6), end: time(16) }],
    };
    const seek = page.getByRole('slider', { name: 'Seek timeline' });
    const play = page.getByRole('button', { name: 'Play', exact: true });
    for (const speed of [0.5, 1.5, 2, 4, 0.25]) {
      const label = String(speed);
      const rational = parseClipSpeed(label);
      const project = setClipSpeed(baseline, 'tone', rational).project;
      const path = await openComposition(
        application,
        page,
        directory,
        project,
        `speed-${label}`,
      );
      await commitReviewEdit(page, path, {
        type: 'clip.speed',
        id: 'picture',
        speed: rational,
      });
      const saved = () => readFile(path, 'utf8').then(deserializeProject);
      await expect
        .poll(async () => (await saved()).clips[0]?.speed)
        .toEqual(rational);
      await expect(
        page
          .locator('.clip-name')
          .getByText(`${label}× · marker.mp4`, { exact: true }),
      ).toBeVisible();
      if (speed === 1.5) {
        await restoreReviewEdit(page, path, 'undo');
        expect((await saved()).clips[0]?.speed).toBeUndefined();
        await restoreReviewEdit(page, path, 'redo');
        await expect
          .poll(async () => (await saved()).clips[0]?.speed)
          .toEqual(rational);
      }
      if (speed === 1.5) {
        await seek.fill('24');
        await commitReviewEdit(page, path, {
          type: 'clip.split',
          id: 'picture',
          at: 24,
        });
        await expect.poll(async () => (await saved()).clips.length).toBe(3);
        const split = (await saved()).clips.find(
          ({ trackId, id }) => trackId === 'v' && id !== 'picture',
        );
        expect(split?.sourceIn).toEqual({ numerator: 31, denominator: 20 });
      }
      await page.locator('.timeline-diagnostics summary').click();
      const snapshot = await saved();
      expect(snapshot.subtitles).toEqual(baseline.subtitles);
      const output = exportProject(directory, `export-${label}`, path);
      const count = Math.ceil(3 + 121 / speed);
      verifyVideoTimestamps(output, rate, count);
      const onsetFrame = Math.ceil(3 + 30 / speed);
      const stopFrame = Math.ceil(3 + 54 / speed);
      const points = [
        onsetFrame - 1,
        onsetFrame,
        onsetFrame + 1,
        stopFrame - 1,
        stopFrame,
        count - 1,
      ];
      const frames = decodeFrames(output, points, width, height);
      let maxMeanRgb = 0;
      for (const frame of points) {
        const exported = frames.get(frame)!;
        expect(
          exported[(10 * width + 10) * 3]! > 200,
          `${label}× export frame ${frame}`,
        ).toBe(frame >= onsetFrame && frame < stopFrame);
        maxMeanRgb = Math.max(
          maxMeanRgb,
          await comparePreviewFrame(page, snapshot, frame, exported),
        );
      }
      const { samples } = decodeAudio(output);
      expect(samples.length / 48000).toBeGreaterThanOrEqual(count / 30 - 0.001);
      expect(samples.length / 48000).toBeLessThan(count / 30 + 0.025);
      const expected = 0.1 + 1 / speed;
      const center = expected + 0.4 / speed;
      const renderedOnset = sampleOnsets(samples)[0]!;
      expect(
        Math.abs(renderedOnset - expected),
        `${label}× encoded audio onset`,
      ).toBeLessThan(speed === 0.25 ? 0.12 : 0.08);
      for (const amplitude of exportAmplitudes(samples, center))
        expect(amplitude).toBeGreaterThan(0.065);
      await seek.fill('0');
      await play.click();
      const trace = await recordPreviewAudio(
        page,
        Math.min((count - 1) / 30, center + 0.12),
      );
      const liveAudio = trace.find(
        ({ hz440, hz880 }) => hz440 > 0.05 && hz880 > 0.045,
      );
      const liveVideo = trace.find(({ white }) => white);
      expect(
        liveAudio,
        `${label}× Electron preserved both pitches`,
      ).toBeDefined();
      expect(liveVideo, `${label}× live flash`).toBeDefined();
      const liveSyncMs = 1000 * Math.abs(liveAudio!.time - liveVideo!.time);
      expect(liveSyncMs, `${label}× Electron A/V onset skew`).toBeLessThan(
        speed === 0.25 ? 180 : 110,
      );
      expect(Math.abs(liveVideo!.time - onsetFrame / 30)).toBeLessThan(0.14);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      console.log('T36', {
        speed,
        frames: count,
        seconds: count / 30,
        maxMeanRgb,
        exportSyncMs: 1000 * Math.abs(renderedOnset - onsetFrame / 30),
        liveSyncMs,
      });
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function splitReviewFixture(directory: string): Project {
  const source = join(directory, 'transition.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.24*sin(2*PI*440*t):s=48000:d=1',
    '-vf',
    "drawbox=color=white:t=fill:enable='gte(n,2)'",
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    source,
  ]);
  const project = createProject({
    name: 'T36 review fixture',
    settings: { width, height, frameRate: rate },
  });
  project.assets = [
    {
      id: 'asset',
      name: 'Transition and tone',
      mediaTypes: ['video', 'audio'],
      duration: time(30),
      file: { type: 'relative', path: 'transition.mp4' },
    },
  ];
  project.tracks = [{ id: 'v', name: 'Video', type: 'video' }];
  project.clips = [
    {
      id: 'picture',
      assetId: 'asset',
      trackId: 'v',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(30),
    },
  ];
  return project;
}

test('T36 retimed splits preserve the video transition and steady audio across the joins', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't36-split-'));
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    const fixture = splitReviewFixture(directory);
    const slow = setClipSpeed(
      fixture,
      'picture',
      parseClipSpeed('0.25'),
    ).project;
    slow.clips[0]!.fadeIn = { duration: time(12) };
    slow.clips[0]!.fadeOut = { duration: time(15) };
    const splitAtFlash = splitClip(slow, 'picture', time(8), 'middle').project;
    const split = splitClip(splitAtFlash, 'middle', time(60), 'right').project;
    await observeNativePaint(page);
    await observeAudioOutput(page);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );

    const points = [7, 8, 9, 119];
    const exports = [];
    for (const [name, project] of [
      ['unsplit', slow],
      ['split', split],
    ] as const) {
      const path = await openComposition(
        application,
        page,
        directory,
        project,
        name,
      );
      const output = exportProject(directory, name + '-export', path);
      verifyVideoTimestamps(output, rate, 120);
      const frames = decodeFrames(output, points, width, height);
      for (const frame of points) {
        const exported = frames.get(frame)!;
        expect(exported[0]! > 200, `${name} frame ${frame}`).toBe(frame >= 8);
        await comparePreviewFrame(page, project, frame, exported);
      }
      exports.push(decodeAudio(output).samples);
    }

    const [unsplitPcm, splitPcm] = exports;
    const start = Math.round(1.96 * 48000);
    const end = Math.round(2.04 * 48000);
    let maxPcmDifference = 0;
    for (let i = start; i < end; i += 240) {
      let energy = 0;
      for (let n = i; n < i + 240; n++) {
        energy += splitPcm![n]! ** 2;
        maxPcmDifference = Math.max(
          maxPcmDifference,
          Math.abs(splitPcm![n]! - unsplitPcm![n]!),
        );
      }
      expect(
        Math.sqrt(energy / 240),
        `5 ms split audio window at sample ${i}`,
      ).toBeGreaterThan(0.08);
    }
    expect(maxPcmDifference).toBeLessThan(0.015);

    await page.getByRole('slider', { name: 'Seek timeline' }).fill('0');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const trace = await recordPreviewAudio(page, 2.2);
    const atJoin = trace.filter(({ time }) => time >= 1.96 && time <= 2.04);
    expect(atJoin.length).toBeGreaterThan(2);
    expect(Math.min(...atJoin.map(({ hz440 }) => hz440))).toBeGreaterThan(0.08);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('T36 exact CLI and batch trims export and match Electron at default speed', async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't36-exact-trim-'));
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    const project = splitReviewFixture(directory);
    const cli = resolve('apps/cli/dist/index.js');
    const projectFile = join(directory, 'untrimmed.json');
    await writeFile(projectFile, serializeProject(project));
    command(process.execPath, [
      cli,
      'clip',
      'trim',
      projectFile,
      'picture',
      '--in-time',
      '1/20',
      '--json',
    ]);
    const batchFile = join(directory, 'trim.json');
    const first = deserializeProject(await readFile(projectFile, 'utf8'));
    await writeFile(
      batchFile,
      JSON.stringify({
        expectedRevision: first.editing?.revision,
        operations: [
          {
            type: 'clip.trim',
            id: 'picture',
            outTime: { numerator: 1, denominator: 8 },
          },
        ],
      }),
    );
    command(process.execPath, [
      cli,
      'edit',
      'apply',
      projectFile,
      batchFile,
      '--json',
    ]);
    const trimmed = deserializeProject(await readFile(projectFile, 'utf8'));
    expect(trimmed.clips[0]).toMatchObject({
      sourceIn: { numerator: 1, denominator: 20 },
      sourceOut: { numerator: 1, denominator: 8 },
    });
    expect(trimmed.clips[0]?.speed).toBeUndefined();

    await observeNativePaint(page);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    await openComposition(
      application,
      page,
      directory,
      trimmed,
      'exact-trim-preview',
    );
    const output = exportProject(directory, 'exact-trim-export', projectFile);
    verifyVideoTimestamps(output, rate, 3);
    const frames = decodeFrames(output, [0, 1, 2], width, height);
    for (const [frame, exported] of frames) {
      expect(exported[0]! > 200).toBe(frame > 0);
      await comparePreviewFrame(page, trimmed, frame, exported);
    }
    const { samples } = decodeAudio(output);
    const peak = (from: number, to: number) =>
      samples
        .slice(from, to)
        .reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak(960, 3000)).toBeGreaterThan(0.08);
    // The audio ends at 75 ms, before the last video frame's 100 ms boundary.
    expect(peak(4320, 4800)).toBeLessThan(0.02);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
