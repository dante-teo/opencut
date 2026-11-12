import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type Page,
  type ElectronApplication,
} from '@playwright/test';
import { frameTime, serializeProject, type Project } from '@opencut/core';
import { auditMedia, auditProjects } from '../../scripts/t21-projects.js';
import type { TimelineDiagnostics } from '../../apps/desktop/src/renderer/timeline-playback.js';
import { launchDesktop } from './helpers.js';

const root = resolve('tests/fixtures/generated');
let directory: string;
test.beforeAll(async () => {
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, 't24-'));
  // Reuse only generated T21 inputs, never user media. Generate via audit:t21 if absent.
  const candidates = (await readdir(root))
    .filter((name) => name.startsWith('t21-'))
    .sort()
    .reverse();
  let copied = false;
  for (const candidate of candidates) {
    try {
      for (const file of auditMedia)
        await copyFile(join(root, candidate, file), join(directory, file));
      copied = true;
      break;
    } catch {
      /* Candidate may be an incomplete earlier audit. */
    }
  }
  if (!copied) {
    const generate = (args: string[], file: string) => {
      const result = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-nostdin', '-y', ...args, join(directory, file)],
        { encoding: 'utf8', timeout: 60000 },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `Generate T21 fixtures with pnpm audit:t21: ${result.error?.message ?? result.stderr}`,
        );
    };
    generate(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
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
        '-threads',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
      ],
      'source.mp4',
    );
    generate(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-t',
        '8',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '6',
        '-threads',
        '2',
        '-an',
      ],
      'mixed.webm',
    );
    generate(
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000',
        '-t',
        '8',
        '-ac',
        '2',
      ],
      'tone.wav',
    );
    generate(
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=320x180',
        '-frames:v',
        '1',
        '-threads',
        '1',
      ],
      'still.png',
    );
  }
});
test.beforeAll(async () => {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.3*sin(2*PI*440*t)*between(mod(t\\,1)\\,0.5\\,0.65):s=48000',
      '-vf',
      "drawbox=color=white:t=fill:enable='between(mod(t,1),0.5,0.65)'",
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(directory, 'sync.mp4'),
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr);
});
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function open(
  application: ElectronApplication,
  page: Page,
  project: Project,
  name: string,
) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, serializeProject(project));
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: project.metadata.name, exact: true }),
  ).toBeVisible();
  await page.locator('.timeline-diagnostics summary').click();
  return path;
}
const report = async (page: Page): Promise<TimelineDiagnostics> =>
  JSON.parse(
    (await page
      .getByTestId('timeline-diagnostics')
      .getAttribute('data-report'))!,
  );
const time = (value: TimelineDiagnostics) =>
  value.position.numerator / value.position.denominator;
const seek = async (page: Page, frame: number) => {
  await page
    .getByRole('slider', { name: 'Seek timeline', exact: true })
    .fill(String(frame));
  await expect
    .poll(async () => Math.round(time(await report(page)) * 30))
    .toBe(frame);
};
async function audioMeter(page: Page) {
  await page.evaluate(() => {
    const Native = window.AudioContext;
    const state = {
      contexts: [] as AudioContext[],
      gains: [] as GainNode[],
      analyser: null as AnalyserNode | null,
    };
    (window as unknown as { t24Audio: typeof state }).t24Audio = state;
    window.AudioContext = class extends Native {
      private first = true;
      constructor(options?: AudioContextOptions) {
        super(options);
        state.contexts.push(this);
      }
      override createGain() {
        const gain = super.createGain();
        state.gains.push(gain);
        if (this.first) {
          this.first = false;
          const analyser = super.createAnalyser();
          analyser.fftSize = 8192;
          analyser.smoothingTimeConstant = 0;
          gain.connect(analyser);
          state.analyser = analyser;
        }
        return gain;
      }
    };
  });
}
async function spectrum(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        t24Audio: {
          analyser: AnalyserNode;
          contexts: AudioContext[];
          gains: GainNode[];
        };
      }
    ).t24Audio;
    const analyser = state.analyser;
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    const at = (hz: number) => {
      const bin = Math.round(
        (hz / state.contexts.at(-1)!.sampleRate) * analyser.fftSize,
      );
      return Math.max(...data.slice(bin - 2, bin + 3));
    };
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    return {
      hz440: at(440),
      hz880: at(880),
      rms:
        state.contexts.at(-1)!.state === 'closed'
          ? 0
          : Math.sqrt(
              samples.reduce((sum, x) => sum + x * x, 0) / samples.length,
            ),
      gains: state.gains.map((g) => g.gain.value),
    };
  });
}

for (const name of ['cuts', 'gaps', 'mixing'] as const)
  test(`edited T21 ${name}: real playback, boundaries and diagnostics`, async () => {
    test.setTimeout(45000);
    const { application, page } = await launchDesktop();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('Renderer:', msg.text());
    });
    try {
      await audioMeter(page);
      const project = auditProjects()[name]!;
      if (name === 'cuts') {
        // Preserve a split with continuous source points at second 1.
        const first = project.clips[0]!;
        project.clips.splice(
          0,
          1,
          { ...first, id: 'left', sourceOut: { numerator: 1, denominator: 1 } },
          {
            ...first,
            id: 'right',
            timelineStart: { numerator: 1, denominator: 1 },
            sourceIn: { numerator: 1, denominator: 1 },
          },
        );
      }
      const path = await open(application, page, project, name);
      const original = await readFile(path, 'utf8');
      await page
        .locator('#project-viewer')
        .getByRole('button', { name: 'Play', exact: true })
        .click();
      await expect
        .poll(async () => time(await report(page)))
        .toBeGreaterThan(0.25);
      if (name === 'cuts') {
        const decoder = await page
          .locator('[data-timeline-clip="left"]')
          .elementHandle();
        await expect
          .poll(async () => time(await report(page)))
          .toBeGreaterThan(1.2);
        expect(await decoder!.evaluate((video) => video.isConnected)).toBe(
          true,
        );
        expect(await page.locator('canvas').getAttribute('data-clip-id')).toBe(
          'right',
        );
      }
      if (name === 'gaps') {
        expect(await page.locator('canvas').getAttribute('data-clip-id')).toBe(
          '',
        );
        const pixel = await page
          .locator('canvas')
          .evaluate((canvas: HTMLCanvasElement) => [
            ...canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data,
          ]);
        expect(pixel).toEqual([24, 48, 72, 255]);
      }
      await expect
        .poll(async () => time(await report(page)), { timeout: 12000 })
        .toBeGreaterThan(name === 'gaps' ? 6.4 : 4.4);
      if (name === 'mixing') {
        const audio = await spectrum(page);
        console.log('T24 audible mix', JSON.stringify(audio));
        expect(audio.hz440).toBeGreaterThan(-65);
        expect(audio.hz880).toBeGreaterThan(-65);
        expect((await report(page)).activeAudio).toBe(2);
        expect(audio.gains).toContain(0.5);
        expect(audio.gains).toContain(0.25);
      }
      const metrics = await report(page);
      console.log(`T24 ${name}`, JSON.stringify(metrics));
      expect(metrics.unavailable).toEqual([]);
      expect(metrics.maxMediaSkewMs).toBeLessThan(250);
      await page
        .locator('#project-viewer')
        .getByRole('button', { name: 'Pause', exact: true })
        .click();
      await expect
        .poll(async () => (await spectrum(page)).rms)
        .toBeLessThan(0.00001);
      await seek(page, name === 'gaps' ? 75 : 120);
      await page
        .locator('#project-viewer')
        .getByRole('button', { name: 'Next frame' })
        .click();
      await expect(page.getByTestId('project-position')).toContainText(
        name === 'gaps' ? '00:00:02:16' : '00:00:04:01',
      );
      const targets = [5, 165, 40, 180, 61];
      for (const frame of targets)
        await page
          .getByRole('slider', { name: 'Seek timeline', exact: true })
          .fill(String(frame));
      await expect
        .poll(async () => Math.round(time(await report(page)) * 30))
        .toBe(61);
      await expect
        .poll(() => page.locator('canvas').getAttribute('data-presented-clip'))
        .toBe(name === 'cuts' ? 'right' : name === 'gaps' ? 'c0' : 'mixed');
      expect(errors).toEqual([]);
      expect(await readFile(path, 'utf8')).toBe(original);
      await page.screenshot({ path: `test-results/t24-${name}.png` });
    } finally {
      await application.close();
    }
  });

test('visible and audible clips reclaim slots from hidden animated layers', async () => {
  const { application, page } = await launchDesktop();
  try {
    const project = auditProjects().mixing!;
    const rate = project.settings.frameRate;
    const at = (frame: number) => frameTime(frame, rate);
    const hiddenTracks = Array.from({ length: 16 }, (_, i) => ({
      id: `hidden-${i}`,
      name: `Hidden ${i}`,
      type: 'video' as const,
    }));
    project.tracks.unshift(...hiddenTracks);
    project.clips = [
      ...hiddenTracks.map(({ id }) => ({
        id: `clip-${id}`,
        trackId: id,
        assetId: 'asset-3',
        timelineStart: at(0),
        sourceIn: at(0),
        sourceOut: at(180),
        muted: true,
        keyframes: {
          opacity: [
            { time: at(0), value: 1, easing: 'linear' as const },
            { time: at(30), value: 0, easing: 'linear' as const },
          ],
        },
      })),
      {
        id: 'priority-video',
        trackId: 'v0',
        assetId: 'asset-1',
        timelineStart: at(120),
        sourceIn: at(0),
        sourceOut: at(60),
        muted: true,
      },
      {
        id: 'priority-audio',
        trackId: 'a0',
        assetId: 'asset-2',
        timelineStart: at(120),
        sourceIn: at(0),
        sourceOut: at(60),
      },
    ];
    await open(application, page, project, 'animated-decoder-priority');
    const canvas = page.locator('#project-viewer canvas');
    await expect.poll(async () => (await report(page)).decoders).toBe(16);
    await seek(page, 120);
    await expect(canvas).toHaveAttribute(
      'data-presented-layers',
      '["priority-video"]',
    );
    await expect.poll(async () => (await report(page)).activeAudio).toBe(1);
    const state = await report(page);
    expect(state.decoders).toBeLessThanOrEqual(16);
    expect(state.unavailable).not.toContain(
      'Preview decoder limit (16) reached.',
    );
  } finally {
    await application.close();
  }
});

test('samples dense keyframes in Electron without cloning their arrays', async () => {
  const { application, page } = await launchDesktop();
  try {
    const project = auditProjects().cuts!;
    const rate = project.settings.frameRate;
    project.clips = [
      {
        id: 'dense',
        trackId: 'v0',
        assetId: 'asset-0',
        timelineStart: frameTime(0, rate),
        sourceIn: frameTime(0, rate),
        sourceOut: frameTime(120, rate),
        keyframes: {
          x: Array.from({ length: 901 }, (_, index) => ({
            time: { numerator: index, denominator: 300 },
            value: index / 10,
            easing: 'linear',
          })),
        },
      },
    ];
    await open(application, page, project, 'dense-keyframe-playback');
    await page.evaluate(() => {
      const original = globalThis.structuredClone;
      const counts = { samples: 0, arrays: 0 };
      (window as unknown as { playbackClones: typeof counts }).playbackClones =
        counts;
      globalThis.structuredClone = (value, options) => {
        if (
          value &&
          typeof value === 'object' &&
          'id' in value &&
          value.id === 'dense' &&
          'timelineEnd' in value
        ) {
          counts.samples++;
          if ('keyframes' in value && value.keyframes) counts.arrays++;
        }
        return original(value, options);
      };
    });
    const viewer = page.locator('#project-viewer');
    await viewer.getByRole('button', { name: 'Play', exact: true }).click();
    await expect
      .poll(async () => time(await report(page)))
      .toBeGreaterThan(0.4);
    await expect(viewer.locator('canvas')).toHaveAttribute(
      'data-presented-layers',
      '["dense"]',
    );
    await viewer.getByRole('button', { name: 'Pause', exact: true }).click();
    const counts = await page.evaluate(
      () =>
        (
          window as unknown as {
            playbackClones: { samples: number; arrays: number };
          }
        ).playbackClones,
    );
    expect(counts.samples).toBeGreaterThan(10);
    expect(counts.arrays).toBe(0);
  } finally {
    await application.close();
  }
});

for (const interruption of ['pause', 'seek'] as const)
  test(`${interruption} during timeline startup preserves healthy media for replay`, async () => {
    const { application, page } = await launchDesktop();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await audioMeter(page);
      // Hold the first play request pending. Native pause/seek cancellation is
      // represented by its AbortError, without racing the machine's decoder speed.
      await page.evaluate(() => {
        const nativePlay = HTMLMediaElement.prototype.play;
        const nativePause = HTMLMediaElement.prototype.pause;
        const state = { pending: false, aborted: false };
        (window as unknown as { t24Startup: typeof state }).t24Startup = state;
        const gate = { media: null as HTMLMediaElement | null };
        let rejectPlay: ((error: DOMException) => void) | undefined;
        HTMLMediaElement.prototype.play = function () {
          if (
            !gate.media &&
            this instanceof HTMLVideoElement &&
            this.dataset.timelineClip
          ) {
            gate.media = this;
            state.pending = true;
            return new Promise<void>((_resolve, reject) => {
              rejectPlay = reject;
            });
          }
          return nativePlay.call(this);
        };
        HTMLMediaElement.prototype.pause = function () {
          nativePause.call(this);
          if (this === gate.media && state.pending) {
            state.pending = false;
            state.aborted = true;
            rejectPlay!(
              new DOMException(
                'Playback startup was interrupted.',
                'AbortError',
              ),
            );
          }
        };
      });
      const project = auditProjects().cuts!;
      project.clips = project.clips.slice(0, 1);
      await open(application, page, project, `startup-${interruption}`);
      const play = page
        .locator('#project-viewer')
        .getByRole('button', { name: 'Play', exact: true });
      await play.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { t24Startup: { pending: boolean } })
                .t24Startup.pending,
          ),
        )
        .toBe(true);
      const decoder = await page
        .locator('[data-timeline-clip="c0"]')
        .elementHandle();
      if (interruption === 'pause') await play.click();
      else await seek(page, 30);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { t24Startup: { aborted: boolean } })
                .t24Startup.aborted,
          ),
        )
        .toBe(true);
      await expect.poll(async () => (await report(page)).playing).toBe(false);
      await expect
        .poll(async () => (await report(page)).unavailable)
        .toEqual([]);

      await play.click();
      const resumedFrom = interruption === 'pause' ? 0 : 1;
      await expect
        .poll(async () => time(await report(page)))
        .toBeGreaterThan(resumedFrom + 0.2);
      expect(
        await decoder!.evaluate(
          (video) => video.isConnected && !(video as HTMLVideoElement).paused,
        ),
      ).toBe(true);
      await expect(page.locator('canvas')).toHaveAttribute(
        'data-presented-clip',
        'c0',
      );
      await expect
        .poll(async () => (await spectrum(page)).hz440)
        .toBeGreaterThan(-65);
      expect((await report(page)).unavailable).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await application.close();
    }
  });

test('edits, interruption, source isolation, missing media and grant revocation', async () => {
  test.setTimeout(45000);
  const { application, page } = await launchDesktop();
  try {
    await audioMeter(page);
    const project = auditProjects().mixing!;
    await open(application, page, project, 'lifecycle');
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect
      .poll(async () => time(await report(page)))
      .toBeGreaterThan(1.3);
    const urls = await page
      .locator('#project-viewer video')
      .evaluateAll((videos) =>
        videos.map((video) => (video as HTMLVideoElement).src),
      );
    await page
      .getByRole('button', { name: 'Inspect clip music', exact: true })
      .click();
    await page.getByLabel('Mute', { exact: true }).check();
    await expect.poll(async () => (await report(page)).playing).toBe(false);
    await expect
      .poll(async () => (await spectrum(page)).rms)
      .toBeLessThan(0.00001);
    for (const url of urls)
      expect(
        await application.evaluate(
          async ({ net }, url) => (await net.fetch(url)).status,
          url,
        ),
      ).toBe(403);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect
      .poll(async () => time(await report(page)))
      .toBeGreaterThan(1.8);
    await expect
      .poll(async () => (await spectrum(page)).hz440)
      .toBeGreaterThan(-65);
    await expect
      .poll(async () => (await spectrum(page)).hz880)
      .toBeLessThan(-80);
    await page.evaluate(async () => {
      await (
        window as unknown as { t24Audio: { contexts: AudioContext[] } }
      ).t24Audio.contexts
        .at(-1)!
        .suspend();
    });
    await expect.poll(async () => (await report(page)).playing).toBe(false);
    await page
      .getByRole('tab', { name: 'Source preview', exact: true })
      .click();
    await expect(page.locator('#project-viewer video')).toHaveCount(0);
    await expect
      .poll(async () => (await spectrum(page)).rms)
      .toBeLessThan(0.00001);
    await page
      .getByRole('tab', { name: 'Project viewer', exact: true })
      .click();
    await expect.poll(async () => (await report(page)).playing).toBe(false);
    // Discard this test's mute edit before opening the offline project.
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const missing = auditProjects().cuts!;
    missing.assets[0]!.file = { type: 'relative', path: 'offline.mp4' };
    await open(application, page, missing, 'offline');
    await expect
      .poll(async () => (await report(page)).unavailable.length)
      .toBeGreaterThan(0);
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await expect
      .poll(async () => time(await report(page)))
      .toBeGreaterThan(0.2);
    await seek(page, 100);
    await expect(page.locator('canvas')).toHaveAttribute('data-clip-id', 'c1');
    // Rejection is scoped to the authorized project and exact revision.
    const rejected = await page.evaluate(async () => {
      try {
        await window.opencut.timelinePreview({
          projectId: 'wrong',
          expectedRevision: 0,
          assetId: 'asset-0',
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
  } finally {
    await application.close();
  }
});

test('decoded audio pulses and painted video markers stay synchronized after trimming', async () => {
  const { application, page } = await launchDesktop();
  try {
    await audioMeter(page);
    const project = auditProjects().cuts!;
    project.assets[0]!.file = { type: 'relative', path: 'sync.mp4' };
    project.assets[0]!.duration = { numerator: 4, denominator: 1 };
    project.clips = [
      {
        ...project.clips[0]!,
        sourceIn: { numerator: 1, denominator: 4 },
        sourceOut: { numerator: 13, denominator: 4 },
      },
    ];
    await open(application, page, project, 'sync');
    await page
      .locator('#project-viewer')
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    const observations = await page.evaluate(async () => {
      const analyser = (
        window as unknown as { t24Audio: { analyser: AnalyserNode } }
      ).t24Audio.analyser;
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      const samples = new Float32Array(analyser.fftSize);
      const audio: number[] = [],
        video: number[] = [];
      let wasAudio = false,
        wasVideo = false;
      const started = performance.now();
      await new Promise<void>((resolve) => {
        function observe() {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(
            samples.reduce((sum, x) => sum + x * x, 0) / samples.length,
          );
          const audible = rms > 0.06;
          const white =
            ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
              .data[0]! > 200;
          if (audible && !wasAudio) audio.push(performance.now() - started);
          if (white && !wasVideo) video.push(performance.now() - started);
          wasAudio = audible;
          wasVideo = white;
          if (performance.now() - started < 2700)
            requestAnimationFrame(observe);
          else resolve();
        }
        requestAnimationFrame(observe);
      });
      return { audio, video };
    });
    console.log('T24 A/V marker onsets', JSON.stringify(observations));
    expect(observations.audio.length).toBe(3);
    expect(observations.video.length).toBe(3);
    const offsets = observations.audio.map(
      (onset, i) => onset - observations.video[i]!,
    );
    console.log('T24 A/V onset offsets ms', JSON.stringify(offsets));
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(100);
  } finally {
    await application.close();
  }
});
