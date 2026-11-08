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
import { launchDesktop } from './helpers.js';
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
      ' GUI text matches encoded video at exact project boundaries',
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
            await page
              .getByRole('button', { name: 'Add text', exact: true })
              .click();
            const text = page.getByRole('textbox', {
              name: 'Text',
              exact: true,
            });
            await expect(text).toHaveValue('Text');
            const content = vertical
              ? 'OpenCut Vertical\n繁體中文 😀'
              : 'OpenCut Wide\n简体中文 😀';
            await text.fill(content);
            const input = (name: string) =>
              page.getByRole('spinbutton', { name, exact: true });
            await input('Start frame').fill('8');
            await input('Duration frames').fill('24');
            await input('X').fill(vertical ? '-17' : '29');
            await input('Y').fill(vertical ? '65' : '-27');
            await input('Scale').fill('1.1');
            await input('Opacity').fill('0.82');
            await input('Rotation').fill(vertical ? '12' : '-8');
            await input('Font size').fill('33');
            await input('Wrap width').fill('260');
            await page
              .getByLabel('Weight', { exact: true })
              .selectOption('700');
            await page
              .getByLabel('Alignment', { exact: true })
              .selectOption(vertical ? 'right' : 'left');
            await page
              .getByRole('textbox', { name: 'Color', exact: true })
              .fill('#f9e8b4');
            if (vertical)
              await page
                .getByRole('textbox', { name: 'Font family', exact: true })
                .fill('OpenCut Missing Test Face');
            await page.getByText('Effects', { exact: true }).click();
            await page
              .getByRole('checkbox', { name: 'Stroke', exact: true })
              .check();
            await page
              .getByRole('checkbox', { name: 'Shadow', exact: true })
              .check();
            await page
              .getByRole('checkbox', { name: 'Background', exact: true })
              .check();
            await page
              .getByRole('textbox', { name: 'Background color', exact: true })
              .fill('#50365bbf');
            await page
              .getByRole('button', { name: 'Apply text', exact: true })
              .click();
            await expect(input('Start frame')).toHaveValue('8');
            await page
              .getByRole('button', { name: 'Undo', exact: true })
              .click();
            await expect(text).toHaveValue('Text');
            await page
              .getByRole('button', { name: 'Redo', exact: true })
              .click();
            await expect(text).toHaveValue(content);
            const clip = page.locator('.timeline-clip.text');
            await clip.focus();
            await clip.press('ArrowRight');
            await expect(input('Start frame')).toHaveValue('9');
            await page
              .getByRole('button', { name: 'Save project', exact: true })
              .click();
            await expect(
              page.getByText('Saved project', { exact: true }),
            ).toBeVisible();
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
            await page
              .getByRole('button', { name: 'Open project', exact: true })
              .click();
            await expect(page.locator('.timeline-clip.text')).toBeVisible();
            await page.locator('.timeline-clip.text').focus();
            await page.locator('.timeline-clip.text').press('Enter');
            await expect(text).toHaveValue(content);
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
        const pick = (file: string) =>
          application.evaluate(({ dialog }, selected) => {
            dialog.showOpenDialog = async () => ({
              canceled: false,
              filePaths: [selected],
            });
          }, file);
        const menu = page.locator('.subtitle-menu summary');
        const importFile = async (format: string) => {
          await pick(
            resolve('tests/fixtures/subtitles/multilingual.' + format),
          );
          await menu.click();
          await page
            .getByRole('button', { name: 'Import SRT / WebVTT…' })
            .click();
        };
        const clips = page.locator('.timeline-clip.subtitle');
        await importFile('vtt');
        await expect(clips).toHaveCount(2);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(clips).toHaveCount(0);
        await importFile('srt');
        await expect(clips).toHaveCount(2);
        const snapshot = () =>
          page.evaluate(async () => {
            const reply = await window.opencut.getProject();
            if (!reply.ok || !reply.state) throw new Error('Missing project');
            return reply.state.project;
          });
        const [first, second] = (await snapshot()).subtitles!.cues;
        const select = (id: string) =>
          page.getByRole('button', { name: 'Inspect subtitle ' + id });
        await select(first!.id).focus();
        await select(first!.id).press('Enter');
        const field = (name: string) =>
          page.getByRole('textbox', { name, exact: true });
        const text = field('Subtitle text');
        await expect(text).toHaveValue(first!.text);
        await field('Start seconds').fill('0.115');
        await field('Duration seconds').fill('0.495');
        await expect(field('End seconds')).toHaveValue('');
        await text.fill('Hello, OpenCut!\n你好，世界！');
        await page
          .getByRole('button', { name: 'Apply subtitle', exact: true })
          .click();
        await expect
          .poll(async () => (await snapshot()).subtitles!.cues[0]!.start)
          .toEqual({ numerator: 23, denominator: 200 });
        await expect(field('End seconds')).toHaveValue('0.61');
        const size = page.getByRole('spinbutton', { name: 'Subtitle size' });
        await size.fill('37');
        await expect(size).toHaveValue('37');
        await field('Subtitle color').fill('#fff0bb');
        await page
          .getByRole('checkbox', { name: 'Background', exact: true })
          .check();
        await field('Subtitle background color').fill('#526884');
        await expect(
          page.getByRole('spinbutton', { name: 'Subtitle size' }),
        ).toHaveValue('37');
        await page
          .getByRole('button', { name: 'Apply subtitle style' })
          .click();
        await expect
          .poll(async () => (await snapshot()).subtitles!.style.fontSize)
          .toBe(37);
        await page
          .getByRole('slider', { name: 'Seek timeline', exact: true })
          .fill('12');
        await page.getByRole('button', { name: 'Split at playhead' }).click();
        await expect(clips).toHaveCount(3);
        await menu.click();
        await page
          .getByRole('button', { name: 'Merge with next subtitle' })
          .click();
        await expect(clips).toHaveCount(2);
        await expect(text).toHaveValue(first!.text + '\n' + first!.text);
        await text.fill(first!.text);
        await page
          .getByRole('button', { name: 'Apply subtitle', exact: true })
          .click();
        await select(second!.id).focus();
        await select(second!.id).press('Enter');
        await select(second!.id).press('ArrowRight');
        await expect(field('Start seconds')).toHaveValue('263/600');
        await select(second!.id).press('ArrowLeft');
        await expect(field('Start seconds')).toHaveValue('0.405');
        await page
          .getByRole('button', { name: 'Delete subtitle', exact: true })
          .click();
        await expect(clips).toHaveCount(1);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(clips).toHaveCount(2);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(clips).toHaveCount(1);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(clips).toHaveCount(2);
        const sidecar = join(directory, 't34-sidecar.vtt');
        await application.evaluate(({ dialog }, file) => {
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: file,
          });
        }, sidecar);
        await menu.click();
        await page.getByRole('button', { name: 'Export WebVTT…' }).click();
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
        await pick(path);
        await page
          .getByRole('button', { name: 'Open project', exact: true })
          .click();
        await expect(clips).toHaveCount(2);
        await select(first!.id).focus();
        await select(first!.id).press('Enter');
        await expect(text).toHaveValue(first!.text);
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
