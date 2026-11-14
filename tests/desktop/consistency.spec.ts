import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  expect,
  test,
  type Page,
  type ElectronApplication,
} from '@playwright/test';
import {
  createProject,
  type EditOperation,
  deserializeProject,
  evaluateTimelineFrame,
  frameTime,
  planProjectRender,
  parseSubtitles,
  serializeProject,
  type Project,
} from '@opencut/core';
import {
  auditProjects,
  generateAuditMedia,
} from '../../scripts/t21-projects.js';
import {
  decodeAudio,
  exportAmplitudes,
  observeAudioOutput,
  recordPreviewAudio,
  sampleOnsets,
} from './t27-audio.js';
import {
  launchDesktop,
  commitReviewEdit,
  restoreReviewEdit,
} from './helpers.js';
import { openComposition } from './t26-fixtures.js';
import {
  command,
  compareRgb,
  decodeFrames,
  exportProject,
  ffmpeg,
  observeNativePaint,
  readCanvas,
  saveDiff,
  verifyVideoTimestamps,
  type Tolerance,
} from './t27-comparison.js';

function readTolerance(key: string, fallback: number, max = 255) {
  const raw = process.env[`OPENCUT_T27_${key}`];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < 0 || value > max)
    throw new Error(`Invalid T27 tolerance ${key}: ${raw}`);
  return value;
}

const tolerance: Tolerance = {
  mean: readTolerance('MEAN', 8),
  p95: readTolerance('P95', 25),
  largePixelFraction: readTolerance('LARGE_PIXEL_FRACTION', 0.025, 1),
};
const mutation = process.env.OPENCUT_T27_INJECT;
if (mutation !== undefined && mutation !== 'visual' && mutation !== 'timing')
  throw new Error('OPENCUT_T27_INJECT must be visual or timing');

let directory: string;
let tools: Record<string, string>;
test.beforeAll(async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, 't27-'));
  console.log('T27 report directory:', directory);
  tools = Object.fromEntries(
    ['ffmpeg', 'ffprobe'].map((tool) => [
      tool,
      command(tool, ['-version']).toString().split('\n')[0]!,
    ]),
  );
  generateAuditMedia((args, file) => {
    ffmpeg(['-n', ...args, join(directory, file)]);
  });
});
test.setTimeout(180_000);

const time = (frame: number) =>
  frameTime(frame, { numerator: 30, denominator: 1 });
const seconds = (t: { numerator: number; denominator: number }) =>
  t.numerator / t.denominator;
type Mapping = [id: string, sourceFrame: number][];
interface Point {
  frame: number;
  mapping?: Mapping;
  marker?: number;
  textVisible?: boolean;
  subtitleCount?: number;
}

interface TextScenario {
  edit: (
    application: ElectronApplication,
    page: Page,
    path: string,
  ) => Promise<Project>;
  guiExport?: boolean;
  fontWarning?: boolean;
  observeAudio?: boolean;
}

async function compareScenario(
  name: string,
  project: Project,
  points: Point[],
  changed?: Project,
  textScenario?: TextScenario,
) {
  const { width, height, frameRate } = project.settings;
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'cache'),
  });
  const report = {
    schemaVersion: 1,
    name,
    tools,
    platform: process.platform,
    arch: process.arch,
    electron: await application.evaluate(() => process.versions.electron),
    tolerance,
    mutation,
    width,
    height,
    frameRate,
    comparisons: [] as Record<string, unknown>[],
    status: 'failed',
    errors: [] as string[],
  };
  const previousErrors = test.info().errors.length;
  try {
    await observeNativePaint(page);
    if (textScenario?.observeAudio) await observeAudioOutput(page);
    await page.evaluate(() =>
      window.opencut.mediaCache({ action: 'enable', enabled: false }),
    );
    let exportPath = await openComposition(
      application,
      page,
      directory,
      project,
      name,
    );
    if (textScenario)
      project = await textScenario.edit(application, page, exportPath);
    if (changed) {
      exportPath = join(directory, `${name}-injected.json`);
      await writeFile(exportPath, serializeProject(changed));
    }
    const output = textScenario?.guiExport
      ? await exportTextFromDesktop(
          application,
          page,
          join(directory, name + '.mp4'),
          textScenario.fontWarning ?? true,
        )
      : exportProject(directory, name, exportPath);
    const plan = planProjectRender(project);
    const videoTimestamps = verifyVideoTimestamps(
      output,
      frameRate,
      plan.frameCount,
    );
    const exported = decodeFrames(
      output,
      points
        .filter(({ frame }) => frame < plan.frameCount)
        .map(({ frame }) => frame),
      width,
      height,
    );
    let bareCanvas: Buffer | undefined;
    let bareExport: Buffer | undefined;
    for (const {
      frame,
      mapping,
      marker,
      textVisible,
      subtitleCount,
    } of points) {
      const evaluation = evaluateTimelineFrame(project, frame);
      const layers = evaluation.visualClips.filter((clip) => clip.visible);
      const ids = layers.map((clip) => clip.id);
      if (textVisible !== undefined)
        expect(layers.some((clip) => clip.kind === 'text')).toBe(textVisible);
      if (subtitleCount !== undefined) {
        expect(
          layers.filter((clip) => clip.kind === 'text' && clip.subtitle),
        ).toHaveLength(subtitleCount);
        expect(
          plan.visualClips.filter(
            (clip) =>
              clip.subtitle &&
              frame >= clip.timelineStartFrame &&
              frame < clip.timelineStartFrame + clip.frameCount,
          ),
        ).toHaveLength(subtitleCount);
      }
      const videoTimes = layers
        .filter((clip) => clip.kind === 'video')
        .map((clip) => seconds(clip.sourceTime));
      const position = `${evaluation.time.numerator}/${evaluation.time.denominator}`;
      const evaluated = layers.map(({ id, sourceTime }) => ({
        id,
        sourceTime,
      }));
      const entry: Record<string, unknown> = {
        frame,
        timestamp: evaluation.time,
        boundary: evaluation.boundary,
        expectedMapping: mapping,
        evaluated,
      };
      report.comparisons.push(entry);
      if (mapping) {
        expect
          .soft(
            evaluated,
            `frame ${frame}: half-open layers and evaluator source times`,
          )
          .toEqual(
            mapping.map(([id, source]) => ({ id, sourceTime: time(source) })),
          );
        expect
          .soft(
            plan.visualClips
              .filter(
                (clip) =>
                  frame >= clip.timelineStartFrame &&
                  frame < clip.timelineStartFrame + clip.frameCount,
              )
              .map((clip) => [
                clip.clipId,
                clip.sourceStartFrame + frame - clip.timelineStartFrame,
              ]),
            `frame ${frame}: render plan source indices`,
          )
          .toEqual(mapping);
      }
      await page
        .getByRole('slider', { name: 'Seek timeline', exact: true })
        .fill(String(frame));
      let capture: Awaited<ReturnType<typeof readCanvas>> = null;
      await expect
        .poll(
          async () => {
            capture = await readCanvas(page, position, ids, videoTimes);
            return capture !== null;
          },
          {
            timeout: 15000,
            message: `Chromium canvas frame ${frame} at ${position}, layers ${ids}, native video times ${videoTimes}`,
          },
        )
        .toBe(true);
      const canvas = capture!;
      expect([canvas.width, canvas.height]).toEqual([width, height]);
      entry.nativeVideoTimes = canvas.nativeVideoTimes;
      entry.exportTimestampSeconds = videoTimestamps[frame];
      const rgb = exported.get(frame);
      if (!rgb) {
        expect(evaluation.boundary).toBe('end');
        entry.status = 'preview-only-project-end';
        continue;
      }
      const result = compareRgb(canvas.rgb, rgb, tolerance);
      Object.assign(entry, result);
      if (textVisible === false) {
        bareCanvas ??= canvas.rgb;
        bareExport ??= rgb;
      }
      if (textVisible && bareCanvas && bareExport) {
        const previewInk = compareRgb(
          canvas.rgb,
          bareCanvas,
          tolerance,
        ).metrics;
        const exportedInk = compareRgb(rgb, bareExport, tolerance).metrics;
        entry.textComparedWithCleanVideo = { previewInk, exportedInk };
        // The still-color fixture isolates the overlay. Require substantial text
        // signal independently in each path so two missing overlays cannot pass.
        expect(previewInk.largePixelFraction).toBeGreaterThan(0.025);
        expect(exportedInk.largePixelFraction).toBeGreaterThan(0.025);
      }
      if (marker !== undefined) {
        const preview = readMarker(canvas.rgb, width, height);
        const rendered = readMarker(rgb, width, height);
        entry.marker = { expected: marker, preview, export: rendered };
        entry.passed =
          result.passed && preview === marker && rendered === marker;
        expect
          .soft(preview, `frame ${frame}: Chromium decoded marker`)
          .toBe(marker);
        expect
          .soft(rendered, `frame ${frame}: FFmpeg decoded marker`)
          .toBe(marker);
      }
      if (!entry.passed)
        entry.artifacts = saveDiff(
          directory,
          `${name}-${frame}`,
          canvas.rgb,
          rgb,
          width,
          height,
        );
      expect
        .soft(
          result.passed,
          `${name} frame ${frame}: ${JSON.stringify(result.metrics)}; artifacts in ${directory}`,
        )
        .toBe(true);
    }
    report.errors = test
      .info()
      .errors.slice(previousErrors)
      .map(({ message }) => message ?? 'Unknown assertion error');
    report.status = report.errors.length ? 'failed' : 'passed';
  } catch (error) {
    report.errors.push(String(error));
    throw error;
  } finally {
    try {
      await writeFile(
        join(directory, `${name}-report.json`),
        JSON.stringify(report, null, 2) + '\n',
      );
    } finally {
      await application.close();
    }
  }
}

async function exportTextFromDesktop(
  application: ElectronApplication,
  page: Page,
  output: string,
  fontWarning = true,
) {
  await application.evaluate(({ dialog }, output) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  }, output);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Export video', exact: true });
  await panel
    .getByRole('button', { name: 'Choose output…', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Export video', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.opencut.getExport()), {
      timeout: 60000,
    })
    .toMatchObject({ status: 'succeeded', output });
  if (fontWarning) {
    await expect(
      panel.getByRole('list', { name: 'Export warnings' }),
    ).toContainText(/Font .*unavailable. Using Noto Sans SC/);
  }
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  return output;
}

for (const vertical of [false, true]) {
  const orientation = vertical ? 'vertical' : 'horizontal';
  test(
    'T33 ' +
      orientation +
      ' text matches encoded video at exact project boundaries',
    async () => {
      const width = vertical ? 360 : 640;
      const height = vertical ? 640 : 360;
      const video = 't33-' + orientation + '-source.mp4';
      ffmpeg([
        '-n',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x242937:s=' + width + 'x' + height + ':r=30:d=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-colorspace',
        'bt709',
        '-threads',
        '1',
        join(directory, video),
      ]);
      const project = createProject({
        name: 'T33 ' + orientation,
        settings: {
          width,
          height,
          frameRate: { numerator: 30, denominator: 1 },
        },
      });
      project.assets = [
        {
          id: 'background',
          name: video,
          file: { type: 'relative', path: video },
          mediaTypes: ['video'],
          duration: time(60),
        },
      ];
      project.tracks = [{ id: 'video', name: 'Video', type: 'video' }];
      project.clips = [
        {
          id: 'base',
          trackId: 'video',
          assetId: 'background',
          timelineStart: time(0),
          sourceIn: time(0),
          sourceOut: time(60),
        },
      ];
      await compareScenario(
        't33-' + orientation,
        project,
        [
          { frame: 0, textVisible: false },
          { frame: 8, textVisible: false },
          { frame: 9, textVisible: true },
          { frame: 24, textVisible: true },
          { frame: 32, textVisible: true },
          { frame: 33, textVisible: false },
          { frame: 59, textVisible: false },
        ],
        undefined,
        {
          guiExport: vertical,
          async edit(_application, page, path) {
            const content = vertical
              ? 'OpenCut Vertical\n繁體中文 😀'
              : 'OpenCut Wide\n简体中文 😀';
            await commitReviewEdit(page, path, {
              type: 'text.add',
              id: 'heading',
              at: 9,
              duration: 24,
              visual: {
                x: vertical ? -17 : 29,
                y: vertical ? 65 : -27,
                scale: 1.1,
                opacity: 0.82,
                rotation: vertical ? 12 : -8,
              },
              text: {
                content,
                fontSize: 33,
                wrapWidth: 260,
                fontWeight: 700,
                alignment: vertical ? 'right' : 'left',
                color: '#f9e8b4',
                ...(vertical && { fontFamily: 'OpenCut Missing Test Face' }),
                stroke: { color: '#000000', width: 2 },
                shadow: { color: '#000000', blur: 4, x: 2, y: 2 },
                background: { color: '#50365bbf', padding: 8 },
              },
            });
            const saved = deserializeProject(await readFile(path, 'utf8'));
            expect(saved.clips[1]).toMatchObject({
              timelineStart: time(9),
              text: {
                content,
                fontWeight: 700,
                stroke: { width: 2 },
                shadow: { blur: 4 },
                background: { padding: 8 },
              },
              visual: { x: vertical ? -17 : 29, opacity: 0.82 },
            });
            await expect(page.locator('.timeline-clip.text')).toBeVisible();
            await page.locator('.timeline-clip.text').press('Enter');
            await expect(
              page.getByRole('complementary', { name: 'Inspector' }),
            ).toContainText(content.split('\n')[0]!);
            await page
              .getByRole('slider', { name: 'Seek timeline', exact: true })
              .fill('24');
            await expect(
              page.locator('#project-viewer canvas'),
            ).toHaveAttribute(
              'data-presented-layers',
              JSON.stringify(['base', saved.clips[1]!.id]),
            );
            if (vertical)
              await expect(
                page.getByText(/Font .*unavailable. Using Noto Sans SC/),
              ).toBeVisible();
            const diagnostics = page.locator(
              '.timeline-diagnostics[open] summary',
            );
            if (await diagnostics.count()) await diagnostics.click();
            await page.screenshot({
              path: join(directory, 't33-' + orientation + '-editor.png'),
            });
            await page
              .getByRole('slider', { name: 'Seek timeline', exact: true })
              .fill('0');
            await page
              .getByRole('button', { name: 'Play', exact: true })
              .click();
            await expect(
              page.getByRole('button', { name: 'Pause', exact: true }),
            ).toBeVisible();
            await expect(
              page.locator('#project-viewer canvas'),
            ).toHaveAttribute(
              'data-presented-layers',
              JSON.stringify(['base', saved.clips[1]!.id]),
            );
            await page
              .getByRole('button', { name: 'Pause', exact: true })
              .click();
            return saved;
          },
        },
      );
    },
  );
}

test('T27 T21 cuts, trims and continuous split at adjacent frames', async () => {
  const project = auditProjects().cuts!;
  const first = project.clips[0]!;
  project.clips.splice(
    0,
    1,
    { ...first, id: 'left', sourceOut: time(30) },
    { ...first, id: 'right', timelineStart: time(30), sourceIn: time(30) },
  );
  await compareScenario(
    'cuts',
    project,
    (
      [
        [0, 'left', 0],
        [29, 'left', 29],
        [30, 'right', 30],
        [31, 'right', 31],
        [89, 'right', 89],
        [90, 'c1', 30],
        [91, 'c1', 31],
        [92, 'c1', 32],
        [179, 'c1', 119],
        [180, '', 0],
      ] as const
    ).map(([frame, id, source]) => ({
      frame,
      mapping: id ? [[id, source]] : [],
    })),
  );
});

test('T27 T21 gaps, transparent matte and audio-only tail', async () => {
  const project = auditProjects().gaps!;
  project.settings.backgroundColor = '#18304880';
  await compareScenario(
    'gaps',
    project,
    (
      [
        [0, '', 0],
        [29, '', 0],
        [30, 'c0', 0],
        [31, 'c0', 1],
        [89, 'c0', 59],
        [90, '', 0],
        [91, '', 0],
        [119, '', 0],
        [120, 'c1', 0],
        [121, 'c1', 1],
        [179, 'c1', 59],
        [180, '', 0],
        [181, '', 0],
        [239, '', 0],
        [240, '', 0],
      ] as const
    ).map(([frame, id, source]) => ({
      frame,
      mapping: id ? [[id, source]] : [],
    })),
  );
});

test('T27 T21 overlays with overlapping mixed-rate video, fit modes and track reversal', async () => {
  const projects = auditProjects();
  const project = projects.overlays!;
  project.settings.width = 640;
  project.settings.height = 400;
  project.tracks.splice(1, 0, {
    id: 'pip',
    name: 'Picture in picture',
    type: 'video',
  });
  project.clips.unshift({
    ...projects.mixing!.clips[1]!,
    trackId: 'pip',
    visual: { x: -70, y: 28, scale: 0.65, opacity: 0.75 },
  });
  for (const fit of ['contain', 'cover', 'stretch'] as const) {
    project.clips[0]!.visual!.fit = fit;
    if (fit === 'stretch') project.tracks.reverse();
    const changed =
      mutation === 'visual' && fit === 'contain'
        ? structuredClone(project)
        : undefined;
    if (changed)
      changed.clips.find((clip) => clip.id === 'overlay')!.visual!.x = -140;
    await compareScenario(
      `overlays-${fit}`,
      project,
      (fit === 'contain'
        ? [29, 30, 59, 60, 61, 92, 149, 150, 179]
        : [61, 92]
      ).map((frame) => ({ frame })),
      changed,
    );
  }
});

// Independent frame identity: eight grayscale cells encode the source frame's
// index. The oracle is calculated from fixture PTS, without an image metric,
// render plan or FFmpeg frame-rate conversion to tell us the expected index.
function readMarker(rgb: Buffer, width: number, height: number) {
  let result = 0;
  for (let bit = 0; bit < 8; bit++) {
    const x = Math.floor(((bit + 0.5) * width) / 8);
    const y = Math.floor(height / 2);
    if (rgb[(y * width + x) * 3]! > 128) result |= 1 << bit;
  }
  return result;
}

for (const sourceRate of [25, 30])
  test(`T27 numbered decoded frames verify ${sourceRate} fps source identity independently`, async () => {
    const project = auditProjects().cuts!;
    project.settings.width = 320;
    project.settings.height = 180;
    const asset = project.assets[1]!;
    const mixed = sourceRate === 25;
    const file = mixed ? 'numbered.webm' : 'numbered.mp4';
    asset.file = { type: 'relative', path: file };
    asset.duration = time(120);
    Object.assign(asset.metadata!, {
      width: 160,
      height: 90,
      durationSeconds: 4,
      frameRate: sourceRate,
      frameRateRatio: `${sourceRate}/1`,
      videoCodec: mixed ? 'vp9' : 'h264',
      formatName: mixed ? 'matroska,webm' : 'mov,mp4',
    });
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `nullsrc=s=160x90:r=${sourceRate}:d=4`,
      '-vf',
      "geq=lum='16+219*mod(floor(N/pow(2,floor(X/20))),2)':cb=128:cr=128",
      '-c:v',
      ...(mixed
        ? ['libvpx-vp9', '-lossless', '1']
        : ['libx264', '-crf', '12', '-pix_fmt', 'yuv420p']),
      '-threads',
      '2',
      '-an',
      '-n',
      join(directory, file),
    ]);
    const clip = {
      ...project.clips[1]!,
      timelineStart: time(10),
      sourceIn: time(15),
      sourceOut: time(45),
    };
    project.clips = [
      { ...clip, id: 'numbered-left', sourceOut: time(30) },
      {
        ...clip,
        id: 'numbered-right',
        timelineStart: time(25),
        sourceIn: time(30),
      },
    ];
    const changed =
      mutation === 'timing' && mixed ? structuredClone(project) : undefined;
    if (changed) {
      changed.clips[1]!.sourceIn = time(31);
      changed.clips[1]!.sourceOut = time(46);
    }
    await compareScenario(
      `numbered-${sourceRate}`,
      project,
      [9, 10, 11, 12, 13, 14, 15, 16, 24, 25, 26, 27, 28, 29, 30, 39, 40].map(
        (frame): Point =>
          frame < 10 || frame >= 40
            ? { frame, mapping: [] }
            : {
                frame,
                mapping: [
                  [frame < 25 ? 'numbered-left' : 'numbered-right', frame + 5],
                ],
                marker: Math.floor(((frame + 5) * sourceRate) / 30),
              },
      ),
      changed,
    );
  });

test('T27 T21 mixing: decoded audio gains, trim onsets, mute and A/V synchronization', async () => {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=30:d=4',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.3*sin(2*PI*440*t)*between(mod(t\\,1)\\,0.5\\,0.75):s=48000:d=4',
    '-vf',
    "drawbox=color=white:t=fill:enable='gte(mod(t,1),0.5)*lt(mod(t,1),0.75)'",
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-af',
    'pan=stereo|c0=c0|c1=c0',
    '-n',
    join(directory, 'pulse.mp4'),
  ]);
  const project = auditProjects().mixing!;
  project.settings = { ...project.settings, width: 320, height: 180 };
  const source = project.assets[0]!;
  source.file = { type: 'relative', path: 'pulse.mp4' };
  source.duration = time(120);
  Object.assign(source.metadata!, {
    width: 320,
    height: 180,
    durationSeconds: 4,
  });
  const [video, , music] = project.clips;
  project.clips = [
    {
      ...video!,
      timelineStart: time(15),
      sourceIn: time(6),
      sourceOut: time(102),
    },
    { ...music!, sourceIn: time(9), sourceOut: time(54) },
  ];
  const { application, page } = await launchDesktop({
    OPENCUT_MEDIA_CACHE: join(directory, 'audio-cache'),
  });
  try {
    await observeAudioOutput(page);
    for (const muted of [false, true]) {
      project.clips[1]!.muted = muted;
      const name = muted ? 'mixing-muted' : 'mixing';
      const report = {
        schemaVersion: 1,
        name,
        tools,
        electron: await application.evaluate(() => process.versions.electron),
        status: 'failed',
        error: '',
        evidence: {} as Record<string, unknown>,
      };
      const previousErrors = test.info().errors.length;
      try {
        const path = await openComposition(
          application,
          page,
          directory,
          project,
          name,
        );
        const exported = exportProject(directory, name, path);
        const { frameRate, frameCount } = planProjectRender(project);
        const videoTimestamps = verifyVideoTimestamps(
          exported,
          frameRate,
          frameCount,
        );
        const {
          samples: pcm,
          startSeconds: exportAudioStart,
          decodedFrames: exportAudioFrames,
        } = decodeAudio(exported);
        const exportAudio = sampleOnsets(pcm);
        const markers = [24, 54, 84];
        const indices = markers.flatMap((frame) => [frame - 1, frame]);
        const images = decodeFrames(exported, indices, 320, 180);
        const exportVideo = indices
          .filter((frame) => images.get(frame)![0]! > 200)
          .map((frame) => videoTimestamps[frame]!);
        await page.getByRole('slider', { name: 'Seek timeline' }).fill('0');
        await expect(page.locator('#project-viewer canvas')).toHaveAttribute(
          'data-position',
          '0/1',
        );
        await page
          .locator('#project-viewer')
          .getByRole('button', { name: 'Play', exact: true })
          .click();
        const trace = await recordPreviewAudio(page);
        await page
          .locator('#project-viewer')
          .getByRole('button', { name: 'Pause', exact: true })
          .click();
        const previewAudio = trace
          .filter(
            (item, i) =>
              item.hz440 > 0.04 && (trace[i - 1]?.hz440 ?? 0) <= 0.04,
          )
          .map(({ time }) => time);
        const previewVideo = trace
          .filter((item, i) => item.white && !trace[i - 1]?.white)
          .map(({ time }) => time);
        const targetOnsets = markers.map((frame) => frame / 30);
        const timingLimits = { exportPcmSeconds: 0.01, previewSeconds: 0.09 };
        const windows = [
          { time: 0.3, gains: [0, 0] },
          { time: 0.94, gains: [0.15, 0] },
          { time: 1.35, gains: [0, muted ? 0 : 0.0221] },
          { time: 1.94, gains: [0.15, muted ? 0 : 0.0221] },
          { time: 2.64, gains: [0, 0] },
          { time: 2.94, gains: [0.15, 0] },
          { time: 3.25, gains: [0, 0] },
        ].map(({ time, gains }) => {
          const observed = trace.reduce((nearest, item) =>
            Math.abs(item.time - time) < Math.abs(nearest.time - time)
              ? item
              : nearest,
          );
          return {
            time,
            gains,
            export: exportAmplitudes(pcm, time),
            preview: [observed.hz440, observed.hz880],
            sampledAt: observed.time,
          };
        });
        report.evidence = {
          sampleRate: 48000,
          pcmSamples: pcm.length,
          timingLimits,
          targetOnsets,
          previewAudio,
          previewVideo,
          exportAudio,
          exportAudioStart,
          exportAudioFrames,
          exportVideo,
          windows,
          trace,
        };
        expect
          .soft(
            exportVideo,
            'export marker enters on the exact numbered project frame',
          )
          .toEqual(targetOnsets);
        const { exportPcmSeconds, previewSeconds } = timingLimits;
        const onsetChecks = [
          ['export PCM timing', exportAudio, targetOnsets, exportPcmSeconds],
          [
            'preview audio timing vs export',
            previewAudio,
            exportAudio,
            previewSeconds,
          ],
          [
            'preview video timing vs export',
            previewVideo,
            targetOnsets,
            previewSeconds,
          ],
          ['preview A/V skew', previewAudio, previewVideo, previewSeconds],
        ] as const;
        for (const [label, actual, expected, limit] of onsetChecks) {
          expect.soft(actual, label).toHaveLength(expected.length);
          for (const [i, timestamp] of expected.entries())
            expect
              .soft(
                Math.abs((actual[i] ?? Infinity) - timestamp),
                `${label} onset ${i}`,
              )
              .toBeLessThanOrEqual(limit);
        }
        for (const window of windows) {
          expect
            .soft(
              Math.abs(window.sampledAt - window.time),
              'recorded the requested preview audio window',
            )
            .toBeLessThan(0.06);
          for (const [i, expected] of window.gains.entries()) {
            const actual = window.export[i]!;
            expect
              .soft(
                Math.abs(actual - expected),
                `export gain at ${window.time}s tone ${i}`,
              )
              .toBeLessThan(Math.max(0.004, expected * 0.1));
            expect
              .soft(
                Math.abs(window.preview[i]! - actual),
                `preview/export gain at ${window.time}s tone ${i}`,
              )
              .toBeLessThan(Math.max(0.006, expected * 0.22));
          }
        }
        report.error = test
          .info()
          .errors.slice(previousErrors)
          .map(({ message }) => message)
          .join('\n');
        report.status = report.error ? 'failed' : 'passed';
      } catch (error) {
        report.error = String(error);
        throw error;
      } finally {
        await writeFile(
          join(directory, `${name}-report.json`),
          JSON.stringify(report, null, 2) + '\n',
        );
      }
    }
  } finally {
    await application.close();
  }
});

test('T27 rejects muxed video and audio timestamp shifts', async () => {
  const project = auditProjects().cuts!;
  project.clips = [{ ...project.clips[0]!, sourceOut: time(30) }];
  const path = join(directory, 'timestamp-regression.json');
  await writeFile(path, serializeProject(project));
  const output = exportProject(directory, 'timestamp-regression', path);
  const { frameCount, frameRate, width, height } = planProjectRender(project);
  const indices = [0, 15, 29];
  const original = decodeFrames(output, indices, width, height);
  const videoTimestamps = verifyVideoTimestamps(output, frameRate, frameCount);
  expect(decodeAudio(output).startSeconds).toBe(0);
  for (const shifted of ['video', 'audio'] as const) {
    const remux = join(directory, `shifted-${shifted}.mp4`);
    ffmpeg([
      '-copyts',
      '-itsoffset',
      '0.1',
      '-i',
      output,
      '-i',
      output,
      '-map',
      shifted === 'video' ? '0:v:0' : '1:v:0',
      '-map',
      shifted === 'audio' ? '0:a:0' : '1:a:0',
      '-c',
      'copy',
      '-avoid_negative_ts',
      'disabled',
      '-n',
      remux,
    ]);
    const frames = decodeFrames(remux, indices, width, height);
    for (const frame of indices)
      expect(frames.get(frame)!.equals(original.get(frame)!)).toBe(true);
    if (shifted === 'video') {
      expect(decodeAudio(remux).startSeconds).toBe(0);
      expect(() => verifyVideoTimestamps(remux, frameRate, frameCount)).toThrow(
        /Video frame 0 PTS .* off the project grid/,
      );
    } else {
      expect(verifyVideoTimestamps(remux, frameRate, frameCount)).toEqual(
        videoTimestamps,
      );
      expect(() => decodeAudio(remux)).toThrow(
        /Audio frame 0 PTS .* does not match sample 0/,
      );
    }
  }
});

test('T34 edited multilingual subtitle cues match Chromium Canvas and burned-in video', async () => {
  const video = 't34-source.mp4';
  const width = 640;
  const height = 360;
  ffmpeg([
    '-n',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x242937:s=640x360:r=30:d=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-threads',
    '1',
    join(directory, video),
  ]);
  const project = createProject({
    name: 'T34 Subtitles',
    settings: {
      width,
      height,
      frameRate: { numerator: 30, denominator: 1 },
    },
  });
  project.assets = [
    {
      id: 'base',
      name: video,
      file: { type: 'relative', path: video },
      mediaTypes: ['video'],
      duration: time(60),
    },
  ];
  project.tracks = [{ id: 'video', name: 'Video', type: 'video' }];
  project.clips = [
    {
      id: 'base-clip',
      trackId: 'video',
      assetId: 'base',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(60),
    },
  ];
  await compareScenario(
    't34-subtitles',
    project,
    [
      { frame: 0, textVisible: false, subtitleCount: 0 },
      { frame: 3, textVisible: false, subtitleCount: 0 },
      { frame: 4, textVisible: true, subtitleCount: 1 },
      { frame: 12, textVisible: true, subtitleCount: 1 },
      { frame: 13, textVisible: true, subtitleCount: 2 },
      { frame: 18, textVisible: true, subtitleCount: 2 },
      { frame: 19, textVisible: true, subtitleCount: 1 },
      { frame: 27, textVisible: true, subtitleCount: 1 },
      { frame: 28, textVisible: false, subtitleCount: 0 },
      { frame: 59, textVisible: false, subtitleCount: 0 },
    ],
    undefined,
    {
      guiExport: true,
      fontWarning: false,
      async edit(application, page, path) {
        const cues = parseSubtitles(
          await readFile(
            resolve('tests/fixtures/subtitles/multilingual.vtt'),
            'utf8',
          ),
          'vtt',
        );
        await commitReviewEdit(page, path, { type: 'subtitle.import', cues });
        const clips = page.locator('.timeline-clip.subtitle');
        await expect(clips).toHaveCount(2);
        await restoreReviewEdit(page, path, 'undo');
        await expect(clips).toHaveCount(0);
        const srt = parseSubtitles(
          await readFile(
            resolve('tests/fixtures/subtitles/multilingual.srt'),
            'utf8',
          ),
          'srt',
        );
        await commitReviewEdit(page, path, {
          type: 'subtitle.import',
          cues: srt,
        });
        const [first, second] = deserializeProject(await readFile(path, 'utf8'))
          .subtitles!.cues;
        await commitReviewEdit(
          page,
          path,
          {
            type: 'subtitle.set',
            id: first!.id,
            start: { numerator: 23, denominator: 200 },
            end: { numerator: 61, denominator: 100 },
          },
          {
            type: 'subtitle.style',
            style: {
              fontSize: 37,
              color: '#fff0bb',
              background: { color: '#526884', padding: 8 },
            },
          },
        );
        const sidecar = join(directory, 't34-sidecar.vtt');
        await application.evaluate(({ dialog }, file) => {
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: file,
          });
        }, sidecar);
        await page.getByText('More export options', { exact: true }).click();
        await page
          .getByRole('button', { name: 'Export VTT', exact: true })
          .click();
        await expect(page.getByText(/Exported 2 subtitle cues/)).toBeVisible();
        const sidecarCues = parseSubtitles(
          await readFile(sidecar, 'utf8'),
          'vtt',
        );
        expect(sidecarCues[0]).toMatchObject({
          start: { numerator: 23, denominator: 200 },
          text: first!.text,
        });
        expect(sidecarCues[1]?.text).toBe(second!.text);
        await page
          .getByRole('button', {
            name: 'Inspect subtitle ' + first!.id,
            exact: true,
          })
          .press('Enter');
        await expect(
          page.getByRole('complementary', { name: 'Inspector' }),
        ).toContainText(first!.text.split('\n')[0]!);
        await page
          .getByRole('slider', { name: 'Seek timeline', exact: true })
          .fill('13');
        await expect(page.locator('#project-viewer canvas')).toHaveAttribute(
          'data-presented-layers',
          JSON.stringify(['base-clip', first!.id, second!.id]),
        );
        const diagnostics = page.locator('.timeline-diagnostics[open] summary');
        if (await diagnostics.count()) await diagnostics.click();
        await page.screenshot({
          path: join(directory, 't34-subtitle-editor.png'),
        });
        return deserializeProject(await readFile(path, 'utf8'));
      },
    },
  );
  const clean = join(directory, 't34-clean.mp4');
  command(process.execPath, [
    resolve('apps/cli/dist/index.js'),
    'project',
    'render',
    join(directory, 't34-subtitles.json'),
    '--output',
    clean,
    '--no-subtitles',
    '--json',
  ]);
  verifyVideoTimestamps(clean, project.settings.frameRate, 60);
  const cleanFrames = decodeFrames(clean, [0, 13], width, height);
  const burnedFrames = decodeFrames(
    join(directory, 't34-subtitles.mp4'),
    [13],
    width,
    height,
  );
  expect(
    compareRgb(cleanFrames.get(0)!, cleanFrames.get(13)!, tolerance).passed,
  ).toBe(true);
  expect(
    compareRgb(cleanFrames.get(13)!, burnedFrames.get(13)!, tolerance).passed,
  ).toBe(false);
});

test('T37 headless keyframes survive edits and match encoded animation', async () => {
  const width = 320;
  const height = 180;
  const project = createProject({
    name: 'T37 keyframe animation',
    settings: { width, height, frameRate: { numerator: 30, denominator: 1 } },
  });
  const file = 't37-source.mp4';
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=30:d=4,drawbox=x=4:y=8:w=28:h=42:c=white:t=fill',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=4',
    '-vf',
    "drawbox=x=70:y=32:w=30:h=20:c=blue:t=fill:enable='gte(n,48)'",
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    join(directory, file),
  ]);
  const still = 't37-still.png';
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "nullsrc=s=72x32,format=rgba,geq=r=30:g=230:b=30:a='if(lt(X,36),0,160)'",
    '-frames:v',
    '1',
    '-threads',
    '1',
    join(directory, still),
  ]);
  project.assets = [
    {
      id: 'asset',
      name: 'Animation source',
      file: { type: 'relative', path: file },
      mediaTypes: ['video', 'audio'],
    },
    {
      id: 'image',
      name: 'Alpha still',
      file: { type: 'relative', path: still },
      mediaTypes: ['video'],
      metadata: {
        kind: 'image',
        formatName: 'png_pipe',
        durationSeconds: null,
        width: 72,
        height: 32,
        videoCodec: 'png',
        audioCodec: null,
        frameRate: null,
        frameRateRatio: null,
        hasAudio: false,
      },
    },
  ];
  project.tracks = [
    { id: 'video', name: 'Video', type: 'video' },
    { id: 'text', name: 'Title', type: 'video' },
    { id: 'still', name: 'Still', type: 'video' },
  ];
  project.clips = [
    {
      id: 'animated',
      assetId: 'asset',
      trackId: 'video',
      timelineStart: time(0),
      sourceIn: time(12),
      sourceOut: time(102),
    },
    {
      id: 'title',
      trackId: 'text',
      timelineStart: time(0),
      sourceIn: time(0),
      sourceOut: time(60),
      text: { content: 'T37', fontSize: 36 },
      visual: { y: 60 },
      keyframes: {
        opacity: [
          { time: time(0), value: 0, easing: 'linear' },
          { time: time(60), value: 1, easing: 'linear' },
        ],
      },
    },
    {
      id: 'still-clip',
      assetId: 'image',
      trackId: 'still',
      timelineStart: time(12),
      sourceIn: time(0),
      sourceOut: time(48),
      visual: { x: -100, y: -58, scale: 0.25, fit: 'cover' },
      keyframes: {
        rotation: [
          { time: time(0), value: -25, easing: 'ease-in-out' },
          { time: time(48), value: 25, easing: 'linear' },
        ],
      },
    },
  ];

  const expected = [
    { frame: 0, x: -80, y: -12, scale: 0.5, opacity: 0.3, rotation: 0 },
    {
      frame: 10,
      x: -62.2222222222,
      y: -4,
      scale: 0.7777777778,
      opacity: 0.5333333333,
      rotation: 15,
    },
    {
      frame: 19,
      x: -15.8222222222,
      y: 3.2,
      scale: 0.9327777778,
      opacity: 0.7433333333,
      rotation: 28.5,
    },
    {
      frame: 20,
      x: -8.8888888889,
      y: 4,
      scale: 0.9444444444,
      opacity: 0.7666666667,
      rotation: 30,
    },
    { frame: 30, x: 80, y: 12, scale: 1, opacity: 1, rotation: 30 },
    { frame: 44, x: 80, y: 12, scale: 1, opacity: 1, rotation: 30 },
    { frame: 59, x: 80, y: 12, scale: 1, opacity: 1, rotation: 30 },
  ];
  await compareScenario(
    't37-keyframe-animation',
    project,
    expected.map(({ frame }) => ({ frame })),
    undefined,
    {
      guiExport: true,
      fontWarning: false,
      edit: async (_application, page, path) => {
        const seek = page.getByRole('slider', {
          name: 'Seek timeline',
          exact: true,
        });
        const saved = async () =>
          deserializeProject(await readFile(path, 'utf8'));
        const keys = [
          ['x', 0, -80, 'ease-in'],
          ['x', 45, 80, 'linear'],
          ['y', 0, -12, 'linear'],
          ['y', 45, 12, 'linear'],
          ['scale', 0, 0.5, 'ease-out'],
          ['scale', 45, 1, 'linear'],
          ['opacity', 0, 0.3, 'linear'],
          ['opacity', 45, 1, 'linear'],
          ['rotation', 0, 0, 'linear'],
          ['rotation', 45, 45, 'linear'],
        ] as const;
        await commitReviewEdit(
          page,
          path,
          ...keys.map(([property, frame, value, easing]): EditOperation => ({
            type: 'clip.keyframe.add',
            id: 'animated',
            property,
            time: time(frame),
            value,
            easing,
          })),
        );
        await commitReviewEdit(page, path, {
          type: 'clip.keyframe.set',
          id: 'animated',
          property: 'rotation',
          time: time(45),
          newTime: time(30),
          value: 30,
        });
        await commitReviewEdit(page, path, {
          type: 'clip.keyframe.remove',
          id: 'animated',
          property: 'rotation',
          time: time(30),
        });
        await restoreReviewEdit(page, path, 'undo');
        expect((await saved()).clips[0]?.keyframes?.rotation).toHaveLength(2);
        await commitReviewEdit(
          page,
          path,
          {
            type: 'clip.speed',
            id: 'animated',
            speed: { numerator: 3, denominator: 2 },
          },
          { type: 'clip.split', id: 'animated', at: 20 },
        );
        const snapshot = await saved();
        for (const { frame, ...properties } of expected) {
          const visual = evaluateTimelineFrame(snapshot, frame).visualClips[0]!
            .visual;
          for (const [property, value] of Object.entries(properties))
            expect(
              visual[property as keyof typeof properties],
              `${frame} ${property}`,
            ).toBeCloseTo(value, 6);
        }
        const canvas = page.locator('#project-viewer canvas');
        await seek.fill('8');
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await expect
          .poll(async () => {
            const [n, d] = (
              (await canvas.getAttribute('data-position')) ?? '0/1'
            )
              .split('/')
              .map(Number);
            return n! / d!;
          })
          .toBeGreaterThan(0.5);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        return snapshot;
      },
    },
  );
  const output = join(directory, 't37-keyframe-animation.mp4');
  const { samples } = decodeAudio(output);
  expect(exportAmplitudes(samples, 1)[0]).toBeGreaterThan(0.035);
  const frames = decodeFrames(output, [0, 30], width, height);
  const red = (frame: number, x: number, y: number) =>
    frames.get(frame)![(y * width + x) * 3]!;
  expect(red(0, 80, 80)).toBeGreaterThan(60);
  expect(red(0, 200, 80)).toBeLessThan(5);
  expect(red(30, 220, 130)).toBeGreaterThan(220);
  const png = join(directory, 't37-frame-30.png');
  command(process.execPath, [
    resolve('apps/cli/dist/index.js'),
    'preview',
    'frame',
    join(directory, 't37-keyframe-animation.json'),
    '--frame',
    '30',
    '--output',
    png,
    '--json',
  ]);
  expect(
    compareRgb(
      decodeFrames(png, [0], width, height).get(0)!,
      frames.get(30)!,
      tolerance,
    ).passed,
  ).toBe(true);
});

test('T38 mixed-rate dissolve and canvas fades match Electron and export', async () => {
  const project = createProject({
    name: 'T38 transitions',
    settings: {
      width: 320,
      height: 180,
      frameRate: { numerator: 30, denominator: 1 },
      backgroundColor: '#206040',
    },
  });
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "color=red:s=320x180:r=30:d=3,drawbox=x=12:y=12:w=32:h=24:c=white:t=fill:enable='gte(n,42)'",
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    join(directory, 't38-landscape.mp4'),
  ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "color=blue:s=96x160:r=25:d=3,drawbox=x=16:y=16:w=24:h=20:c=yellow:t=fill:enable='gte(n,17)'",
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuv420p',
    join(directory, 't38-portrait.webm'),
  ]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=white:s=32x16,format=rgba,colorchannelmixer=aa=0.6',
    '-frames:v',
    '1',
    join(directory, 't38-overlay.png'),
  ]);
  project.assets = [
    't38-landscape.mp4',
    't38-portrait.webm',
    't38-overlay.png',
  ].map((path, i) => ({
    id: `asset-${i}`,
    name: path,
    file: { type: 'relative', path },
    mediaTypes: i === 0 ? ['video', 'audio'] : ['video'],
    ...(i < 2 && { duration: time(90) }),
    metadata: {
      kind: i < 2 ? 'video' : 'image',
      formatName: null,
      durationSeconds: i < 2 ? 3 : null,
      width: [320, 96, 32][i]!,
      height: [180, 160, 16][i]!,
      frameRate: [30, 25, null][i]!,
      frameRateRatio: null,
      videoCodec: ['h264', 'vp9', 'png'][i]!,
      audioCodec: i === 0 ? 'aac' : null,
      hasAudio: i === 0,
    },
  }));
  project.tracks = [
    { id: 'picture', name: 'Picture', type: 'video' },
    { id: 'overlay', name: 'Overlay', type: 'video' },
  ];
  project.clips = [
    {
      id: 'red',
      trackId: 'picture',
      assetId: 'asset-0',
      timelineStart: time(0),
      sourceIn: time(12),
      sourceOut: time(42),
    },
    {
      id: 'blue',
      trackId: 'picture',
      assetId: 'asset-1',
      timelineStart: time(30),
      sourceIn: time(20),
      sourceOut: time(65),
      speed: { numerator: 3, denominator: 2 },
    },
    {
      id: 'still',
      trackId: 'overlay',
      assetId: 'asset-2',
      timelineStart: time(20),
      sourceIn: time(0),
      sourceOut: time(20),
      visual: { scale: 0.2, x: -100, y: 50 },
    },
  ];
  await compareScenario(
    't38-transitions',
    project,
    [0, 1, 3, 5, 6, 24, 25, 26, 29, 30, 34, 35, 53, 54, 56, 58, 59, 60].map(
      (frame) => ({ frame }),
    ),
    undefined,
    {
      observeAudio: true,
      edit: async (application, page, path) => {
        await commitReviewEdit(
          page,
          path,
          {
            type: 'transition.add',
            transition: { kind: 'fade-in', clipId: 'red', frames: 6 },
          },
          {
            type: 'transition.add',
            transition: {
              kind: 'cross-dissolve',
              from: 'red',
              to: 'blue',
              frames: 10,
            },
          },
        );
        const cross = deserializeProject(
          await readFile(path, 'utf8'),
        ).transitions!.find(({ kind }) => kind === 'cross-dissolve')!;
        await commitReviewEdit(page, path, {
          type: 'transition.remove',
          id: cross.id,
        });
        await expect(
          page.getByRole('button', { name: 'Cross-dissolve, 10 frames' }),
        ).toHaveCount(0);
        await restoreReviewEdit(page, path, 'undo');
        await expect(
          page.getByRole('button', { name: 'Cross-dissolve, 10 frames' }),
        ).toBeVisible();
        await commitReviewEdit(page, path, {
          type: 'transition.add',
          transition: { kind: 'fade-out', clipId: 'blue', frames: 6 },
        });
        const saved = deserializeProject(await readFile(path, 'utf8'));
        expect(saved.clips).toEqual(project.clips);
        expect(saved.transitions?.map(({ frames }) => frames)).toEqual([
          6, 10, 6,
        ]);
        expect(planProjectRender(saved).frameCount).toBe(60);
        await page
          .getByRole('slider', { name: 'Seek timeline', exact: true })
          .fill('15');
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        const audio = await recordPreviewAudio(page, 1.35);
        const beforeCut = audio.filter(
          ({ time }) => time >= 25 / 30 && time < 1,
        );
        const afterCut = audio.filter(
          ({ time }) => time >= 1.09 && time < 34 / 30,
        );
        expect(beforeCut.some(({ hz440 }) => hz440 > 0.04)).toBe(true);
        expect(afterCut.length).toBeGreaterThan(0);
        expect(afterCut.every(({ hz440 }) => hz440 < 0.01)).toBe(true);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();

        const output = await exportTextFromDesktop(
          application,
          page,
          join(directory, 't38-independent.mp4'),
          false,
        );
        const rgb = decodeFrames(output, [0, 30, 59], 320, 180);
        const pixel = (frame: number, x = 160) => [
          ...rgb
            .get(frame)!
            .subarray((90 * 320 + x) * 3, (90 * 320 + x) * 3 + 3),
        ];
        for (const frame of [0, 59]) {
          const [r, g, b] = pixel(frame);
          expect(Math.abs(r! - 32)).toBeLessThan(5);
          expect(Math.abs(g! - 96)).toBeLessThan(5);
          expect(Math.abs(b! - 64)).toBeLessThan(5);
        }
        const [r, g, b] = pixel(30);
        expect(Math.abs(r! - 113)).toBeLessThan(7);
        expect(g).toBeLessThanOrEqual(8);
        expect(Math.abs(b! - 142)).toBeLessThan(7);

        const matte = pixel(30, 20);
        for (const [channel, expected] of [131, 53, 36].entries())
          expect(Math.abs(matte[channel]! - expected)).toBeLessThanOrEqual(8);
        const { samples } = decodeAudio(output);
        expect(exportAmplitudes(samples, 0.95)[0]).toBeGreaterThan(0.04);
        expect(exportAmplitudes(samples, 1.1)[0]).toBeLessThan(0.01);
        const png = join(directory, 't38-frame.png');
        command(process.execPath, [
          resolve('apps/cli/dist/index.js'),
          'preview',
          'frame',
          path,
          '--frame',
          '30',
          '--output',
          png,
        ]);
        const preview = decodeFrames(png, [0], 320, 180).get(0)!;
        expect(compareRgb(preview, rgb.get(30)!, tolerance).passed).toBe(true);
        return saved;
      },
    },
  );
});
