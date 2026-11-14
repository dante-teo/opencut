import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  createProject,
  deserializeProject,
  frameTime,
  setClipAudio,
  splitClip,
} from '@opencut/core';
import { launchDesktop, commitReviewEdit } from './helpers.js';
import { compositionReport, openComposition } from './t26-fixtures.js';
import { decodeAudio, exportAmplitudes } from './t27-audio.js';
import {
  command,
  decodeFrames,
  exportProject,
  ffmpeg,
  verifyVideoTimestamps,
} from './t27-comparison.js';

const rate = { numerator: 30, denominator: 1 };
const time = (frame: number) => frameTime(frame, rate);

async function fixtures() {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't35-'));
  const video = join(directory, 'video.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=30:d=4',
    '-vf',
    "drawbox=color=white:t=fill:enable='gte(n,15)*lt(n,18)'",
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-an',
    video,
  ]);
  const tone = (name: string, expression: string) =>
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=${expression}:s=48000:d=4`,
      '-c:a',
      'pcm_s16le',
      join(directory, `${name}.wav`),
    ]);
  tone('left', '0.32*sin(2*PI*440*t)|0');
  tone('right', '0|0.2*sin(2*PI*880*t)');
  tone('silence', '0|0');
  const project = createProject({
    name: 'T35 audio fade mix',
    settings: { width: 320, height: 180, frameRate: rate },
  });
  project.assets = ['video', 'left', 'right', 'silence'].map((id) => ({
    id: `asset-${id}`,
    name: id,
    mediaTypes: [id === 'video' ? 'video' : 'audio'],
    duration: time(120),
    file: {
      type: 'relative',
      path: id === 'video' ? 'video.mp4' : `${id}.wav`,
    },
  }));
  project.tracks = [
    { id: 'v', name: 'Picture', type: 'video' },
    { id: 'a', name: 'Left', type: 'audio', volume: 0.5 },
    { id: 'b', name: 'Right', type: 'audio', volume: 0.5 },
    { id: 'c', name: 'Silence', type: 'audio' },
  ];
  project.clips = [
    {
      id: 'picture',
      trackId: 'v',
      assetId: 'asset-video',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(120),
    },
    {
      id: 'left',
      trackId: 'a',
      assetId: 'asset-left',
      timelineStart: time(15),
      sourceIn: time(6),
      sourceOut: time(96),
      volume: 0.75,
    },
    {
      id: 'right',
      trackId: 'b',
      assetId: 'asset-right',
      timelineStart: time(15),
      sourceIn: time(0),
      sourceOut: time(60),
    },
    {
      id: 'silent',
      trackId: 'c',
      assetId: 'asset-silence',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(120),
    },
  ];
  return { directory, project };
}

async function instrument(page: Page) {
  // Tap each channel independently at the production output. The shipped
  // meter remains in the graph and reports through its normal UI.
  await page.evaluate(() => {
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      override createDynamicsCompressor() {
        const output = super.createDynamicsCompressor();
        const stereo = this.createChannelSplitter(2);
        output.connect(stereo);
        const analysers = [this.createAnalyser(), this.createAnalyser()];
        analysers.forEach((analyser, channel) => {
          analyser.fftSize = 2048;
          stereo.connect(analyser, channel);
        });
        Object.assign(window, { fadeTestAnalysers: analysers });
        return output;
      }
    };
  });
}

async function record(page: Page, end: number) {
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.click();
  const trace = await page
    .locator('#project-viewer canvas')
    .evaluate(async (canvas: HTMLCanvasElement, end) => {
      const data = new Float32Array(2048);
      const ctx = canvas.getContext('2d')!;
      const meter = Array.from(
        document.querySelectorAll<HTMLMeterElement>('.audio-meters meter'),
      );
      const result: {
        time: number;
        peak: number[];
        db: number[];
        white: boolean;
      }[] = [];
      const deadline = performance.now() + 12000;
      await new Promise<void>((done, fail) => {
        function tick() {
          const [n, d] = (canvas.dataset.position ?? '0/1')
            .split('/')
            .map(Number);
          const time = n! / d!;
          const nodes = (
            window as unknown as { fadeTestAnalysers: AnalyserNode[] }
          ).fadeTestAnalysers;
          if (nodes && time > 0) {
            const peak = nodes.map((analyser) => {
              analyser.getFloatTimeDomainData(data);
              return data.reduce(
                (max, sample) => Math.max(max, Math.abs(sample)),
                0,
              );
            });
            result.push({
              time,
              peak,
              db: meter.map((node) => node.value),
              white: ctx.getImageData(10, 10, 1, 1).data[0]! > 200,
            });
          }
          if (time >= end) done();
          else if (performance.now() > deadline)
            fail(
              new Error(
                'Electron playback did not reach the capture endpoint.',
              ),
            );
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      return result;
    }, end);
  const report = await compositionReport(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  for (const channel of ['Left', 'Right'])
    await expect(
      page.getByLabel(`${channel} audio peak`, { exact: true }),
    ).toHaveAttribute('value', '-60');
  return { trace, report };
}

test('T35 headless audio edits, measured stereo peaks, and preview/export fade parity through splits', async () => {
  test.setTimeout(60_000);
  const { directory, project } = await fixtures();
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    await instrument(page);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    const path = await openComposition(application, page, directory, project);
    await commitReviewEdit(page, path, {
      type: 'clip.audio',
      id: 'left',
      fadeIn: 30,
      fadeOut: 30,
    });
    const unsplit = deserializeProject(await readFile(path, 'utf8'));
    expect(unsplit.clips.find((clip) => clip.id === 'left')).toMatchObject({
      fadeIn: { duration: time(30) },
      fadeOut: { duration: time(30) },
    });
    // 0.5 + 25/30 rounds above 40/30. Both pieces must schedule
    // their shared gain at the same audio timestamp.
    let split = splitClip(unsplit, 'left', time(40), 'middle').project;
    split = splitClip(split, 'middle', time(90), 'tail').project;
    // This snapshot represents exactly the same project sound with two splits.
    delete split.editing;
    const splitPath = await openComposition(
      application,
      page,
      directory,
      split,
      'split',
    );
    const begin = performance.now();
    const rendered = exportProject(directory, 'split-export', splitPath);
    const renderMs = performance.now() - begin;
    const reference = exportProject(directory, 'unsplit-export', path);
    const left = decodeAudio(rendered, 0).samples;
    const right = decodeAudio(rendered, 1).samples;
    const original = decodeAudio(reference, 0).samples;
    verifyVideoTimestamps(rendered, rate, 120);
    const marker = decodeFrames(rendered, [14, 15], 320, 180);
    expect(marker.get(14)![0]).toBeLessThan(10);
    expect(marker.get(15)![0]).toBeGreaterThan(240);
    let difference = 0;
    let sampleStep = 0;
    for (let i = 1; i < 4 * 48000; i++) {
      difference = Math.max(difference, Math.abs(left[i]! - original[i]!));
      sampleStep = Math.max(sampleStep, Math.abs(left[i]! - left[i - 1]!));
    }
    expect(
      difference,
      'split vs unsplit maximum AAC sample difference',
    ).toBeLessThan(0.025);
    expect(
      sampleStep,
      'maximum intersample jump in the faded left channel',
    ).toBeLessThan(0.013);

    const { trace, report } = await record(page, 3.76);
    const nearest = (target: number) =>
      trace.reduce((best, item) =>
        Math.abs(item.time - target) < Math.abs(best.time - target)
          ? item
          : best,
      );
    const windows = [
      [0.25, 0, 0],
      [0.75, 0.03, 0.1],
      [1.0, 0.06, 0.1],
      [1.25, 0.09, 0.1],
      [1.75, 0.12, 0.1],
      [2.75, 0.09, 0],
      [3.0, 0.06, 0],
      [3.25, 0.03, 0],
      [3.7, 0, 0],
    ] as const;
    let maxParityError = 0;
    for (const [at, l, r] of windows) {
      const preview = nearest(at);
      expect(Math.abs(preview.time - at)).toBeLessThan(0.05);
      const actual = [
        exportAmplitudes(left, at)[0]!,
        exportAmplitudes(right, at)[1]!,
      ];
      for (const [channel, expected] of [l, r].entries()) {
        expect
          .soft(
            Math.abs(actual[channel]! - expected),
            `export ${channel} at ${at}s`,
          )
          .toBeLessThan(0.009);
        const parity = Math.abs(preview.peak[channel]! - actual[channel]!);
        maxParityError = Math.max(parity, maxParityError);
        expect
          .soft(parity, `preview/export ${channel} at ${at}s`)
          .toBeLessThan(0.022);
        if (expected > 0) {
          expect
            .soft(
              Math.abs(preview.db[channel]! - 20 * Math.log10(expected)),
              `meter ${channel} at ${at}s`,
            )
            .toBeLessThan(5);
        } else {
          expect
            .soft(preview.db[channel]!, `silent meter ${channel} at ${at}s`)
            .toBe(-60);
        }
      }
    }
    const audioOnset = trace.find((item) => item.peak[1]! > 0.04)!.time;
    const videoOnset = trace.find((item) => item.white)!.time;
    const syncMs = Math.abs(audioOnset - videoOnset) * 1000;
    expect(syncMs).toBeLessThan(85);
    expect(report.unavailable).toEqual([]);
    expect(Math.max(...trace.flatMap(({ peak }) => peak))).toBeLessThan(1);
    await page.getByRole('slider', { name: 'Seek timeline' }).fill('93');
    const resumed = await record(page, 3.35);
    const insideRelease = resumed.trace.find(({ time }) => time >= 3.23)!;
    expect(insideRelease.peak[0]!).toBeGreaterThan(0.015);
    expect(insideRelease.peak[0]!).toBeLessThan(0.06);
    expect(insideRelease.peak[1]).toBe(0);

    const beforeNoop = await readFile(splitPath, 'utf8');
    const inspectLeft = page.getByRole('button', {
      name: 'Inspect clip left',
      exact: true,
    });
    await inspectLeft.locator(':scope > rect').first().click();
    await inspectLeft.press('ArrowRight');
    await expect(
      page.getByRole('button', { name: 'Fade in of left', exact: true }),
    ).toHaveCount(0);
    const afterNoop = await page.evaluate(async () => {
      const reply = await window.opencut.getProject();
      if (!reply.ok || !reply.state)
        throw new Error('Expected the split project to remain open.');
      return reply.state.project;
    });
    expect(afterNoop.editing).toBeUndefined();
    expect(afterNoop.clips.find(({ id }) => id === 'left')?.fadeIn).toEqual(
      split.clips.find(({ id }) => id === 'left')?.fadeIn,
    );
    await expect(
      page.getByRole('button', { name: 'Undo', exact: true }),
    ).toHaveCount(0);
    expect(await readFile(splitPath, 'utf8')).toBe(beforeNoop);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(640, 680),
    );
    await expect
      .poll(() =>
        page.locator('.viewer-utilities').evaluate((controls) => {
          const bounds = controls
            .closest('.viewer-panel')!
            .getBoundingClientRect();
          return Array.from(controls.children).every((item) => {
            const { left, right } = item.getBoundingClientRect();
            return left >= bounds.left && right <= bounds.right;
          });
        }),
      )
      .toBe(true);
    console.log('T35 tone mix', {
      renderMs: Math.round(renderMs),
      traceFrames: trace.length,
      maxParityError,
      splitSampleDifference: difference,
      sampleStep,
      syncMs,
      maxAudioSkewMs: report.maxAudioSkewMs,
      maxTickGapMs: report.maxTickGapMs,
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('T35 Electron plays a speech recording with music and verifies muted export and meters', async () => {
  test.skip(
    process.platform !== 'darwin',
    'Uses the macOS speech synthesizer to make a recording.',
  );
  test.setTimeout(60_000);
  const { directory, project } = await fixtures();
  const voice = join(directory, 'voice.aiff');
  command('/usr/bin/say', [
    '-o',
    voice,
    'OpenCut audio preview. Adjust the background music under the spoken voice.',
  ]);
  ffmpeg([
    '-i',
    voice,
    '-af',
    'apad',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    '4',
    join(directory, 'left.wav'),
    '-y',
  ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.08*sin(2*PI*220*t)+0.04*sin(2*PI*330*t):s=48000:d=4',
    '-ac',
    '2',
    '-y',
    join(directory, 'right.wav'),
  ]);
  const mixed = setClipAudio(project, 'right', {
    fadeIn: time(12),
    fadeOut: time(18),
  }).project;
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  try {
    await instrument(page);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    const path = await openComposition(
      application,
      page,
      directory,
      mixed,
      'speech',
    );
    const audio = decodeAudio(
      exportProject(directory, 'speech-export', path),
    ).samples;
    const live = await record(page, 2.7);
    const leftTrack = mixed.tracks.find(({ name }) => name === 'Left')!;
    await commitReviewEdit(page, path, {
      type: 'track.audio',
      id: leftTrack.id,
      muted: true,
    });
    await page.locator('.timeline-diagnostics summary').click();
    const music = decodeAudio(
      exportProject(directory, 'music-only', path),
    ).samples;
    await page.getByRole('slider', { name: 'Seek timeline' }).fill('0');
    const muted = await record(page, 2.7);
    const peak = (samples: Float32Array) =>
      samples.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
    const livePeak = Math.max(...live.trace.map(({ peak }) => peak[0]!));
    const mutedPeak = Math.max(...muted.trace.map(({ peak }) => peak[0]!));
    expect(livePeak).toBeLessThan(1);
    expect(peak(audio)).toBeLessThan(1);
    expect(livePeak).toBeGreaterThan(mutedPeak * 1.3);
    expect(peak(audio)).toBeGreaterThan(peak(music) * 1.3);
    expect(Math.abs(livePeak - peak(audio))).toBeLessThan(0.06);
    expect(Math.abs(mutedPeak - peak(music))).toBeLessThan(0.015);
    expect(live.report.unavailable).toEqual([]);
    expect(muted.report.unavailable).toEqual([]);
    console.log('T35 recorded speech and music', {
      previewPeak: livePeak,
      exportPeak: peak(audio),
      mutedPreviewPeak: mutedPeak,
      mutedExportPeak: peak(music),
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
