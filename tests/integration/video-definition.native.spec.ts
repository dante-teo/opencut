import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileVideo, defineVideo, migrateProject } from '@opencut/sdk';
import { createProject, serializeProject } from '@opencut/core';
import { describeMediaAsset } from '../../packages/core/src/assets.js';
import {
  decodeStillFrame,
  probeMedia,
  renderTimelineFrame,
  renderVideoTimeline,
} from '../../packages/media/src/index.js';
import { compareRgb, decodeFrames } from '../desktop/t27-comparison.js';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';
import type { Probe } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const example = (extension: string) =>
  fileURLToPath(
    new URL(
      `../../examples/video/showcase.video.${extension}`,
      import.meta.url,
    ),
  );
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('T44 public CLI renders equivalent 20-second definitions and legacy projects', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(generated, 't44-'));
  const sources = [
    example('ts'),
    example('json'),
    join(generated, 'video-long.mp4'),
    join(generated, 'audio-tone.wav'),
    join(generated, 'still.png'),
  ];
  const before = await Promise.all(sources.map(hash));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    });
  const cli = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const { path: tsPath, ...ts } = cli('inspect', example('ts'));
    const { path: jsonPath, ...json } = cli('inspect', example('json'));
    assert.notEqual(tsPath, jsonPath);
    assert.deepEqual(ts, json);
    const alias = join(directory, 'alias.video.json');
    await symlink(example('json'), alias, 'file');
    assert.deepEqual(cli('inspect', alias), { path: jsonPath, ...json });
    await rm(alias);
    for (const extension of ['ts', 'json']) {
      cli('validate', example(extension));
      cli('render', example(extension), '--output', `${extension}.mp4`);
      for (const frame of [30, 96, 414, 479])
        cli(
          'preview',
          'frame',
          example(extension),
          '--frame',
          String(frame),
          '--output',
          `${extension}-${frame}.png`,
        );
    }
    assert.equal(
      await hash(join(directory, 'ts.mp4')),
      await hash(join(directory, 'json.mp4')),
    );
    for (const frame of [30, 96, 414, 479])
      assert.equal(
        await hash(join(directory, `ts-${frame}.png`)),
        await hash(join(directory, `json-${frame}.png`)),
      );
    assert.notEqual(
      await hash(join(directory, 'ts-96.png')),
      await hash(join(directory, 'ts-479.png')),
    );
    const probe: Probe = JSON.parse(
      runTool('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        join(directory, 'ts.mp4'),
      ]),
    );
    const video = probe.streams?.find(
      ({ codec_type }) => codec_type === 'video',
    );
    const audio = probe.streams?.find(
      ({ codec_type }) => codec_type === 'audio',
    );
    assert.equal(video?.codec_name, 'h264');
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.equal(video.avg_frame_rate, '24/1');
    assert.equal(video.nb_read_frames, '480');
    assert.equal(Number(probe.format?.duration), 20);
    assert.equal(audio?.codec_name, 'aac');
    assert.equal(Number(audio.duration), 20);

    for (const frame of [30, 96, 414, 479]) {
      const preview = decodeRgb(join(directory, `ts-${frame}.png`));
      const rendered = decodeRgb(join(directory, 'ts.mp4'), frame);
      assert.equal(preview.length, 320 * 180 * 3);
      assert.equal(rendered.length, preview.length);
      const error =
        preview.reduce(
          (sum, value, index) => sum + Math.abs(value - rendered[index]!),
          0,
        ) / preview.length;
      assert.ok(error < 10, `Frame ${frame} mean RGB error: ${error}`);
    }

    const tooLong = JSON.parse(await readFile(example('json'), 'utf8'));
    tooLong.assets.camera.path = '../video-long.mp4';
    tooLong.assets.music.path = '../audio-tone.wav';
    tooLong.assets.still.path = '../still.png';
    tooLong.tracks[0].clips[1].sourceOut = 132;
    await writeFile(
      join(directory, 'invalid.video.json'),
      JSON.stringify(tooLong),
    );
    const invalid = run(
      'render',
      'invalid.video.json',
      '--output',
      'invalid.mp4',
    );
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /Out point exceeds the duration/);
    assert.ok(!(await readdir(directory)).includes('invalid.mp4'));

    const replaced = run('render', example('json'), '--output', 'ts.mp4');
    assert.equal(replaced.status, 1, replaced.stderr);
    assert.match(replaced.stderr, /Refusing to overwrite/);
    assert.equal(
      await hash(join(directory, 'ts.mp4')),
      await hash(join(directory, 'json.mp4')),
    );
    assert.equal((await readdir(directory)).length, 11);

    const project = structuredClone(
      (await compileVideo(example('json'))).project,
    );
    delete project.settings.durationFrames;
    for (const asset of project.assets)
      asset.file.path = join(
        '..',
        asset.file.path.split('/').at(-1)!,
      ).replaceAll('\\', '/');
    const legacy = join(directory, 'legacy.video.json');
    const original = serializeProject(project);
    await writeFile(legacy, original);
    const legacyPreview = cli(
      'preview',
      'frame',
      legacy,
      '--frame',
      '96',
      '--output',
      'legacy.png',
    );
    assert.equal(legacyPreview.projectPath, legacy);
    assert.equal(
      await hash(join(directory, 'legacy.png')),
      await hash(join(directory, 'json-96.png')),
    );
    const legacyRender = run(
      'project',
      'render',
      legacy,
      '--output',
      'legacy.mp4',
    );
    assert.equal(legacyRender.status, 0, legacyRender.stderr);
    const result = JSON.parse(legacyRender.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.event, 'completed');
    assert.equal(result.frameCount, 456);
    assert.equal(await readFile(legacy, 'utf8'), original);
    assert.deepEqual(await Promise.all(sources.map(hash)), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function decodeRgb(path: string, frame?: number) {
  const result = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    ...(frame === undefined ? [] : ['-vf', `select=eq(n\\,${frame})`]),
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test('T45 migration preserves mixed tracks, subtitles, grading, effects and exact timing', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(generated, 't45-'));
  const definitions = join(directory, 'definitions');
  const ts = join(definitions, 'converted.video.ts');
  const json = join(definitions, 'converted.video.json');
  const legacy = join(directory, 'legacy.opencut.json');
  const titleFont = fileURLToPath(
    new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
  );
  const rate = { numerator: 24, denominator: 1 };
  const frame = (numerator: number) => ({ numerator, denominator: 24 });
  const exact = (numerator: number, denominator = 1) => ({
    numerator,
    denominator,
  });
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    await mkdir(definitions);
    const [video, tone, image] = await Promise.all(
      ['video-long.mp4', 'audio-tone.wav', 'still.png'].map((file) =>
        probeMedia(join(generated, file)),
      ),
    );
    const embeddedFont = (await readFile(titleFont)).toString('base64');
    const project = createProject({
      id: 'original',
      name: 'T45 round trip',
      createdAt: '2024-03-02T01:02:03.456Z',
      settings: {
        frameRate: rate,
        width: 320,
        height: 180,
        backgroundColor: '#193149A0',
      },
    });
    project.assets = [
      {
        ...describeMediaAsset(video!),
        id: 'camera',
        name: 'Camera',
        file: { type: 'relative', path: '../video-long.mp4' },
      },
      {
        ...describeMediaAsset(tone!),
        id: 'voice',
        name: 'Voice',
        file: { type: 'absolute', path: join(generated, 'audio-tone.wav') },
      },
      {
        ...describeMediaAsset(image!),
        id: 'held',
        name: 'Previously frozen frame',
        file: { type: 'relative', path: '../still.png' },
      },
    ];
    project.tracks = [
      {
        id: 'picture',
        name: 'Picture and freeze',
        type: 'video',
        volume: 0.7,
        locked: true,
      },
      { id: 'titles', name: 'Titles', type: 'video' },
      { id: 'audio', name: 'Audio', type: 'audio', volume: 0.6 },
    ];
    const grade = {
      exposure: 0.3,
      contrast: 1.1,
      saturation: 0.8,
      temperature: 0.1,
      tint: 0.05,
      curve: [
        { input: 0.25, output: 0.35 },
        { input: 0.8, output: 0.72 },
      ],
    };
    project.clips = [
      {
        id: 'opening',
        assetId: 'camera',
        trackId: 'picture',
        timelineStart: frame(0),
        sourceIn: frame(12),
        sourceOut: frame(36),
        grade,
        speed: exact(3, 2),
        muted: true,
        linkId: 'sync',
        visual: {
          fit: 'cover',
          crop: { left: 0.05, right: 0.02, top: 0.1, bottom: 0.08 },
        },
        keyframes: {
          scale: [
            {
              time: exact(0),
              value: 0.8,
              easing: 'ease-in-out',
              curve: [0.1, 0.9],
            },
            { time: frame(16), value: 1.05, easing: 'linear' },
          ],
        },
      },
      {
        id: 'incoming',
        assetId: 'camera',
        trackId: 'picture',
        timelineStart: frame(16),
        sourceIn: frame(48),
        sourceOut: frame(64),
        volume: 0.35,
      },
      {
        id: 'freeze',
        assetId: 'held',
        trackId: 'picture',
        timelineStart: frame(32),
        sourceIn: frame(1),
        sourceOut: frame(9),
        visual: { scale: 0.8, rotation: 5 },
        grade,
      },
      {
        id: 'heading',
        trackId: 'titles',
        timelineStart: frame(2),
        sourceIn: frame(2),
        sourceOut: frame(15),
        text: {
          content: '☺',
          embeddedFont,
          canvasFill: '#00000020',
          fontSize: 24,
          rotation: 8,
          fontWeight: 700,
          emphasis: ['☺'],
        },
        visual: { y: -40, opacity: 0.8 },
      },
      {
        id: 'dialogue',
        assetId: 'camera',
        trackId: 'audio',
        timelineStart: frame(0),
        sourceIn: frame(12),
        sourceOut: frame(36),
        speed: exact(3, 2),
        detachedAudio: true,
        linkId: 'sync',
        effects: [
          { type: 'eq', frequency: 300, db: -3 },
          { type: 'compressor', threshold: -18, ratio: 3 },
          { type: 'limiter', ceiling: -2 },
        ],
        gainKeys: [
          { time: exact(1, 1000), value: 0.2 },
          { time: frame(15), value: 0.75 },
        ],
        fadeIn: { duration: exact(1, 100), from: 0.25 },
        fadeOut: { duration: exact(1, 10), to: 0.3 },
      },
      {
        id: 'music',
        assetId: 'voice',
        trackId: 'audio',
        timelineStart: exact(25, 36),
        sourceIn: exact(1, 111),
        sourceOut: exact(2, 3),
        volume: 0.4,
      },
    ];
    project.transitions = [
      { id: 'up', kind: 'fade-in', clipId: 'opening', frames: 3 },
      {
        id: 'dissolve',
        kind: 'cross-dissolve',
        from: 'opening',
        to: 'incoming',
        frames: 6,
      },
      { id: 'down', kind: 'fade-out', clipId: 'incoming', frames: 4 },
    ];
    project.markers = [{ id: 'cut', frame: 16, name: 'Cut' }];
    project.subtitles = {
      style: { color: '#FFFFFF', fontSize: 22, embeddedFont },
      cues: [
        {
          id: 'cue',
          text: '☺ ☻',
          start: exact(113, 1000),
          end: exact(32, 25),
          pop: true,
          emphasis: ['☺'],
          style: {
            x: 10,
            stroke: { width: 1, color: '#000000' },
            embeddedFont: null,
          },
          words: [
            { from: 0, to: 1, start: exact(0), end: exact(25, 73) },
            { from: 2, to: 3, start: exact(25, 73), end: exact(109, 100) },
          ],
        },
      ],
    };
    const saved = serializeProject(project);
    await writeFile(legacy, saved);
    const report = JSON.parse(run('migrate', legacy, '--output', json));
    assert.deepEqual(report, {
      sourcePath: legacy,
      path: json,
      historyOmitted: false,
    });
    run('migrate', legacy, '--output', ts);
    const converted = await compileVideo(json);
    const { assets, ...content } = converted.project;
    assert.equal(
      serializeProject({ ...content, assets: [...project.assets] }),
      saved,
    );
    const originalAssets = new Map(
      project.assets.map(({ id, ...asset }) => [id, asset]),
    );
    for (const { id, file, ...asset } of assets) {
      assert.deepEqual(
        { ...asset, file: originalAssets.get(id)!.file },
        originalAssets.get(id),
      );
      assert.equal(file.type, 'relative');
      assert.ok(file.path.startsWith('../../'));
    }
    const jsonText = JSON.parse(await readFile(json, 'utf8'));
    assert.equal(Object.keys(jsonText.fonts).length, 1);
    assert.equal(
      jsonText.tracks[1].clips[0].text.font,
      jsonText.subtitles.style.font,
    );
    assert.equal(
      serializeProject((await compileVideo(ts)).project),
      serializeProject(converted.project),
    );
    assert.equal(
      serializeProject((await compileVideo(json)).project),
      serializeProject(converted.project),
    );
    run('project', 'render', legacy, '--output', 'legacy.mp4');
    run('render', json, '--output', 'converted.mp4');
    run('render', ts, '--output', 'typescript.mp4');
    assert.equal(
      await hash(join(directory, 'converted.mp4')),
      await hash(join(directory, 'legacy.mp4')),
    );
    assert.equal(
      await hash(join(directory, 'typescript.mp4')),
      await hash(join(directory, 'legacy.mp4')),
    );

    const frames = [2, 5, 14, 17, 29, 35, 39];
    const rendered = decodeFrames(
      join(directory, 'legacy.mp4'),
      frames,
      320,
      180,
    );
    const convertedFrames = decodeFrames(
      join(directory, 'converted.mp4'),
      frames,
      320,
      180,
    );
    for (const index of frames) {
      run(
        'preview',
        'frame',
        legacy,
        '--frame',
        String(index),
        '--output',
        `legacy-${index}.png`,
      );
      run(
        'preview',
        'frame',
        json,
        '--frame',
        String(index),
        '--output',
        `converted-${index}.png`,
      );
      assert.equal(
        await hash(join(directory, `converted-${index}.png`)),
        await hash(join(directory, `legacy-${index}.png`)),
      );
      // Compare the two decoded exports with the project's consistency metrics.
      // PNG-to-H.264 chroma subsampling is independent of the migration.
      const migratedRgb = convertedFrames.get(index)!;
      const comparison = compareRgb(migratedRgb, rendered.get(index)!, {
        mean: 8,
        p95: 25,
        largePixelFraction: 0.025,
      });
      assert.ok(
        comparison.passed,
        `Frame ${index} ${JSON.stringify(comparison.metrics)}`,
      );
    }
    assert.equal(await readFile(legacy, 'utf8'), saved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T45 source-backed freezes match the corresponding extracted image and support relative fonts', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(generated, 't45-held-'));
  try {
    const video = await probeMedia(join(generated, 'video-long.mp4'));
    const frameTime = { numerator: 1, denominator: 2 };
    runTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-i',
      join(generated, 'audio-tone.wav'),
      '-itsoffset',
      '1',
      '-i',
      video.path,
      '-map',
      '1:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      join(directory, 'delayed.mp4'),
    ]);
    const delayed = await probeMedia(join(directory, 'delayed.mp4'));
    assert.equal(delayed.startTimeSeconds, 0);
    assert.equal(delayed.video?.startTimeSeconds, 1);
    const still = await decodeStillFrame(video, 0.5, true);
    await writeFile(join(directory, 'held.png'), still);
    const fontPath = fileURLToPath(
      new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
    );
    await copyFile(fontPath, join(directory, 'font.ttf'));
    const path = join(directory, 'held.video.json');
    const definition = defineVideo({
      canvas: { width: 320, height: 180, frameRate: 24, durationFrames: 12 },
      assets: {
        frame: {
          path: 'delayed.mp4',
          kind: 'image',
          freezeFrame: frameTime,
        },
      },
      fonts: { emoji: { path: 'font.ttf' } },
      tracks: [
        {
          type: 'image',
          id: 'freeze',
          clips: [{ at: 2, duration: 8, asset: 'frame' }],
        },
        {
          type: 'image',
          id: 'graded',
          clips: [
            {
              at: 3,
              duration: 6,
              asset: 'frame',
              grade: {
                exposure: 0.5,
                contrast: 1.5,
                saturation: 0.8,
                temperature: 0.04,
                tint: -0.1,
                curve: [],
              },
              visual: {
                scale: 0.5,
                x: 25,
                opacity: 0.7,
                crop: { left: 0.1, top: 0.15, right: 0, bottom: 0 },
              },
              keyframes: {
                rotation: [
                  {
                    time: { numerator: 0, denominator: 1 },
                    value: -10,
                    easing: 'linear',
                  },
                  {
                    time: { numerator: 1, denominator: 4 },
                    value: 10,
                    easing: 'linear',
                  },
                ],
              },
            },
          ],
        },
        {
          type: 'text',
          clips: [
            { at: 3, duration: 6, text: { content: '☺', font: 'emoji' } },
          ],
        },
      ],
    });
    await writeFile(path, JSON.stringify(definition));
    const compiled = await compileVideo(path);
    assert.equal(
      compiled.project.clips.at(-1)?.text?.embeddedFont,
      (await readFile(fontPath)).toString('base64'),
    );
    assert.deepEqual((await compiled.resolveRender()).audioClips, []);
    const attached = await compiled.resolveRender();
    const extracted = await (
      await compileVideo(await writeStillDefinition())
    ).resolveRender();
    const a = join(directory, 'video.mp4');
    const b = join(directory, 'still.mp4');
    await renderVideoTimeline({ ...attached, output: a });
    await renderVideoTimeline({ ...extracted, output: b });
    const selections = [1, 2, 5, 8, 9, 10];
    const other = decodeFrames(b, selections, 320, 180);
    for (const [index, rgb] of decodeFrames(a, selections, 320, 180))
      assert.deepEqual(rgb, other.get(index), `Freeze frame ${index}`);
    for (const startFrame of [1, 5, 10]) {
      const output = join(directory, `held-${startFrame}.png`);
      const reference = join(directory, `still-${startFrame}.png`);
      const range = { startFrame, endFrame: startFrame + 1 };
      await renderTimelineFrame({ ...attached, output, range });
      await renderTimelineFrame({ ...extracted, output: reference, range });
      assert.equal(await hash(output), await hash(reference));
    }
    const republished = join(directory, 'held.opencut.json');
    await writeFile(republished, serializeProject(compiled.project));
    const migrated = join(directory, 'migrated.video.json');
    await migrateProject(republished, migrated);
    assert.deepEqual(
      await (await compileVideo(migrated)).resolveRender(),
      attached,
    );

    async function writeStillDefinition() {
      const path = join(directory, 'still.video.json');
      await writeFile(
        path,
        JSON.stringify({
          ...definition,
          assets: { frame: { kind: 'image', path: 'held.png' } },
        }),
      );
      return path;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T45 single-frame previews support definitions above the full-render subtitle cap', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(generated, 't45-cues-'));
  try {
    const definition = defineVideo({
      canvas: { width: 320, height: 180, frameRate: 24 },
      tracks: [],
      subtitles: {
        style: {},
        cues: Array.from({ length: 257 }, (_, index) => ({
          id: `cue-${index}`,
          text: `Caption ${index}`,
          start: { numerator: index, denominator: 24 },
          end: { numerator: index + 1, denominator: 24 },
        })),
      },
    });
    const json = JSON.stringify(definition);
    for (const format of ['json', 'ts']) {
      const input = `captions.video.${format}`;
      await writeFile(
        join(directory, input),
        format === 'ts' ? `export default ${json};\n` : json,
      );
      const result = spawnSync(
        process.execPath,
        [
          entry,
          'preview',
          'frame',
          input,
          '--frame',
          '256',
          '--output',
          `${format}.png`,
          '--json',
        ],
        { cwd: directory, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).frame, 256);
    }
    assert.equal(
      await hash(join(directory, 'json.png')),
      await hash(join(directory, 'ts.png')),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
