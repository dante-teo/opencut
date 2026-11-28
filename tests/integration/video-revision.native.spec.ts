import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { compareAudioPackets } from '../../packages/media/dist/index.js';
import { maxRenderedSubtitleCues } from '../../packages/shared/dist/index.js';
import { fixtureDirectory } from '../fixture-paths.js';
import { runTool } from '../../scripts/fixture-lib.js';

const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
function command(args: string[], expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout || result.stderr.trim().split('\n').at(-1)!);
}

async function fixture(run: (directory: string) => Promise<void>) {
  await mkdir(fixtureDirectory, { recursive: true });
  const directory = await mkdtemp(join(fixtureDirectory, 'revision-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const ffmpeg = (...args: string[]) =>
  runTool('ffmpeg', ['-v', 'error', '-nostdin', '-n', ...args]);
const draft = (path: string, definition: unknown) =>
  writeFile(path, 'export default ' + JSON.stringify(definition) + ';\n');

test('review and remix use bounded ranges and verified export picture without a picture cache', () =>
  fixture(async (dir) => {
    const path = (file: string) => join(dir, file);
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=72x128:rate=12:duration=4',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      path('picture.mp4'),
    );
    for (const [id, freq] of [
      ['voice', 400],
      ['musicA', 260],
      ['musicB', 660],
    ])
      ffmpeg(
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=' + freq + ':sample_rate=48000:duration=4',
        path(id + '.wav'),
      );

    const baseline = {
      canvas: { width: 72, height: 128, frameRate: 12, durationFrames: 48 },
      assets: {
        plate: { kind: 'video', path: 'picture.mp4' },
        voice: { kind: 'audio', path: 'voice.wav' },
        musicA: { kind: 'audio', path: 'musicA.wav' },
        musicB: { kind: 'audio', path: 'musicB.wav' },
      },
      tracks: [
        {
          type: 'video',
          id: 'picture',
          clips: [{ id: 'shot', asset: 'plate', at: 0, sourceOut: 48 }],
        },
        {
          type: 'audio',
          id: 'narration',
          audioRole: 'dialogue',
          clips: [
            { id: 'read', asset: 'voice', at: 0, sourceOut: 48, volume: 0.8 },
          ],
        },
        ...['musicA', 'musicB'].map((asset, i) => ({
          type: 'audio',
          id: 'bed-' + (i + 1),
          audioRole: 'music',
          clips: [
            {
              id: 'cue-' + (i + 1),
              asset,
              at: 0,
              sourceOut: 48,
              volume: 0.25 + i * 0.15,
            },
          ],
        })),
      ],
      musicComparison: {
        candidates: [{ trackId: 'bed-1' }, { trackId: 'bed-2' }],
        selected: 'bed-1',
      },
      subtitles: {
        style: { fontSize: 12, y: 35 },
        cues: [
          {
            id: 'word',
            start: { numerator: 1, denominator: 1 },
            end: { numerator: 2, denominator: 1 },
            text: 'Before',
          },
        ],
      },
    };
    await draft(path('before.video.ts'), baseline);
    await writeFile(
      path('edit.json'),
      JSON.stringify({
        operations: [{ operation: 'caption', id: 'word', text: 'After' }],
      }),
    );
    const original = await readFile(path('before.video.ts'));
    const dryRun = command([
      'timeline',
      'patch',
      path('before.video.ts'),
      '--edit',
      path('edit.json'),
      '--dry-run',
    ]);
    assert.deepEqual(await readFile(path('before.video.ts')), original);
    assert.deepEqual(dryRun.affectedRange, { startFrame: 12, endFrame: 24 });
    command([
      'timeline',
      'patch',
      path('before.video.ts'),
      '--edit',
      path('edit.json'),
      '--output',
      path('after.video.ts'),
    ]);
    const report = command([
      'render',
      path('before.video.ts'),
      '--revision-evidence',
      '--output',
      path('baseline.mp4'),
    ]);
    await writeFile(path('baseline.render.json'), JSON.stringify(report));
    const remix = (
      definition: string,
      mp4: string,
      output: string,
      ...args: string[]
    ) => [
      'remix',
      path(definition),
      '--music-candidate',
      'bed-2',
      '--picture-from',
      path(mp4),
      '--render-report',
      path('baseline.render.json'),
      '--output',
      path(output),
      ...args,
    ];
    const preflight = command(
      remix('before.video.ts', 'baseline.mp4', 'mix.mp4', '--preflight'),
    );
    assert.equal(preflight.status, 'reuse');
    await assert.rejects(stat(path('mix.mp4')), { code: 'ENOENT' });
    const revised = command(
      remix('before.video.ts', 'baseline.mp4', 'mix.mp4'),
    );
    for (const [name, result] of [
      ['baseline', report],
      ['mix', revised],
    ] as const) {
      const reportPath = path(`${name}.render.json`);
      await writeFile(reportPath, JSON.stringify(result));
      const inspection = command([
        'inspect',
        'dependencies',
        path('before.video.ts'),
        '--recipe-cache',
        path('recipes'),
        '--render-report',
        reportPath,
      ]);
      assert.ok(
        inspection.files.some(
          (file: { resolvedPath: string; roles: string[] }) =>
            file.resolvedPath === path(`${name}.mp4`) &&
            file.roles.includes('export'),
        ),
      );
    }
    assert.equal(revised.pictureReuse.pictureFramesRendered, 0);
    assert.equal(
      revised.revisionEvidence.packetHash,
      report.revisionEvidence.packetHash,
    );
    assert.equal(
      revised.revisionEvidence.timingHash,
      report.revisionEvidence.timingHash,
    );
    assert.notDeepEqual(
      await readFile(path('baseline.mp4')),
      await readFile(path('mix.mp4')),
    );
    const changedAudio = await compareAudioPackets(
      path('baseline.mp4'),
      path('mix.mp4'),
    );
    assert.equal(changedAudio.passed, false);
    const blocked = command(
      remix('after.video.ts', 'baseline.mp4', 'blocked.mp4'),
      1,
    );
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.affectedRanges.length, 1);
    assert.equal(blocked.affectedRanges[0].startFrame, 12);
    assert.equal(blocked.affectedRanges[0].endFrame, 24);
    assert.ok(blocked.affectedRanges[0].reasons.includes('caption word'));
    const wrong = command(
      remix('before.video.ts', 'picture.mp4', 'blocked.mp4'),
      1,
    );
    assert.equal(wrong.status, 'blocked');
    await writeFile(
      path('baseline.render.json'),
      JSON.stringify({ outputFingerprint: report.outputFingerprint }),
    );
    const legacy = command(
      remix('before.video.ts', 'baseline.mp4', 'blocked.mp4'),
      1,
    );
    assert.equal(legacy.status, 'blocked');
    assert.match(legacy.reasons[0], /compatible revision evidence/);
    await writeFile(path('baseline.render.json'), JSON.stringify(report));

    await assert.rejects(stat(path('blocked.mp4')), { code: 'ENOENT' });

    await writeFile(
      path('Reactive.tsx'),
      `
import { useGraphicAudio } from '@opencut/graphics/react';
export default function Meter() {
  const audio = useGraphicAudio();
  return <svg width="72" height="128"><rect width={(audio?.rms ?? 0) * 72} height="12" fill="white"/></svg>;
}
`,
    );
    await draft(path('reactive.video.ts'), {
      ...baseline,
      assets: {
        ...baseline.assets,
        meter: {
          kind: 'graphic',
          renderer: 'react',
          path: 'Reactive.tsx',
          durationFrames: 12,
          audioAnalysis: {
            version: 1,
            source: 'mix',
            window: 1024,
            hop: 512,
            waveform: 16,
            bins: 8,
          },
        },
      },
      tracks: [
        ...baseline.tracks,
        {
          id: 'graphics',
          type: 'video',
          clips: [{ id: 'reactive', asset: 'meter', at: 24, sourceOut: 12 }],
        },
      ],
    });
    const reactive = command([
      'render',
      path('reactive.video.ts'),
      '--revision-evidence',
      '--output',
      path('reactive.mp4'),
    ]);
    await writeFile(path('baseline.render.json'), JSON.stringify(reactive));
    const reaction = command(
      remix('reactive.video.ts', 'reactive.mp4', 'reaction.mp4'),
      1,
    );
    assert.equal(reaction.status, 'blocked');
    assert.ok(
      reaction.affectedRanges.some(
        ({
          startFrame,
          endFrame,
          reasons,
        }: {
          startFrame: number;
          endFrame: number;
          reasons: string[];
        }) =>
          startFrame === 24 &&
          endFrame === 36 &&
          reasons.includes('audio-driven graphic reactive'),
      ),
    );
    await assert.rejects(stat(path('reaction.mp4')), { code: 'ENOENT' });
    await writeFile(path('baseline.render.json'), JSON.stringify(report));

    const automatic = command([
      'review',
      path('after.video.ts'),
      '--against',
      path('baseline.mp4'),
      '--render-report',
      path('baseline.render.json'),
      '--output',
      path('auto'),
    ]);
    assert.equal(automatic.candidates[0].changes.ranges[0].affects, 'picture');
    assert.equal(automatic.candidates[0].marks[0].after.startFrame, 6);
    assert.equal(automatic.candidates[0].marks[0].after.endFrame, 30);
    assert.equal(automatic.candidates[0].listening, 'pending');

    await writeFile(
      path('marks.json'),
      JSON.stringify([
        { name: 'opening', start: 0, end: 1 },
        { name: 'ending', start: '5/2', end: 4 },
      ]),
    );
    await writeFile(
      path('notes.json'),
      JSON.stringify([{ range: 'ending', text: 'Check the final movement.' }]),
    );
    const pairs = command([
      'review',
      path('before.video.ts'),
      '--against',
      path('before.video.ts'),
      '--against-music',
      'bed-1',
      '--music-candidate',
      'bed-1',
      '--music-option',
      'bed-2',
      '--music-loudness',
      'matched',
      '--marks',
      path('marks.json'),
      '--notes',
      path('notes.json'),
      '--output',
      path('pairs'),
    ]);
    assert.equal(pairs.notes.length, 1);
    assert.equal(pairs.candidates.length, 2);
    assert.equal(
      pairs.candidates[0].marks[0].before.file,
      pairs.candidates[1].marks[0].before.file,
    );
    const html = await readFile(path('pairs/index.html'), 'utf8');
    const playerScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(playerScript);
    assert.doesNotThrow(() => new Script(playerScript));

    for (const candidate of pairs.candidates) {
      assert.equal(candidate.sharedVoiceSettings, true);
      assert.equal(candidate.viewing, 'pending');
      assert.equal(candidate.marks.length, 2);
      for (const mark of candidate.marks) {
        assert.deepEqual(mark.before.startTime, mark.after.startTime);
        assert.equal(
          mark.before.musicLoudness.targetLufs,
          mark.after.musicLoudness.targetLufs,
        );
        await stat(path('pairs/' + mark.after.file));
      }
    }
  }));

test('graphic hold frames match normal sampling and a component change invalidates the hold', () =>
  fixture(async (dir) => {
    const path = (file: string) => join(dir, file);
    const component = (color: string) => `
import { useGraphicFrame } from '@opencut/graphics/react';
export default function Card() {
  const frame = useGraphicFrame();
  const x = Math.min(frame, 5) * 2;
  return <svg width="72" height="128"><rect x={x} width="28" height="80" fill="${color}" /></svg>;
}`;
    await writeFile(path('Card.tsx'), component('#f08d3d'));
    const asset = {
      kind: 'graphic',
      renderer: 'react',
      path: 'Card.tsx',
      durationFrames: 24,
    };
    const definition = {
      canvas: { width: 72, height: 128, frameRate: 12, durationFrames: 24 },
      assets: { card: asset },
      tracks: [
        {
          type: 'video',
          id: 'cards',
          clips: [{ id: 'card-clip', asset: 'card', at: 0, sourceOut: 24 }],
        },
      ],
    };
    await draft(path('normal.video.ts'), definition);
    await draft(path('hold.video.ts'), {
      ...definition,
      assets: {
        card: { ...asset, staticRanges: [{ startFrame: 5, endFrame: 24 }] },
      },
    });
    const render = (name: string, output: string) =>
      command([
        'render',
        path(name + '.video.ts'),
        '--output',
        path(output),
        '--picture-cache',
        path('cache'),
      ]);
    render('normal', 'normal.mp4');
    const hold = render('hold', 'held.mp4');
    assert.deepEqual(hold.graphicSampling, { holdRenders: 1, holdReuses: 18 });
    const decoded = (file: string) => {
      const result = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          path(file),
          '-map',
          '0:v',
          '-f',
          'framemd5',
          'pipe:1',
        ],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(decoded('normal.mp4'), decoded('held.mp4'));
    await writeFile(path('Card.tsx'), component('#2288ee'));
    const changed = render('hold', 'changed.mp4');
    assert.equal(changed.graphicSampling.holdReuses, 18);
    assert.notEqual(decoded('held.mp4'), decoded('changed.mp4'));
  }));

test('clip ripple moves the next shot, transition and caption and rejects an invalid trim atomically', () =>
  fixture(async (dir) => {
    const path = (file: string) => join(dir, file);
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=72x128:rate=12:duration=4',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      path('source.mp4'),
    );
    await draft(path('before.video.ts'), {
      canvas: { width: 72, height: 128, frameRate: 12, durationFrames: 36 },
      assets: { plate: { kind: 'video', path: 'source.mp4' } },
      tracks: [
        {
          id: 'shots',
          type: 'video',
          clips: [
            { id: 'duo', asset: 'plate', at: 0, sourceOut: 18 },
            { id: 'card', asset: 'plate', at: 18, sourceIn: 12, sourceOut: 30 },
          ],
        },
      ],
      transitions: [
        {
          id: 'ending',
          kind: 'cross-dissolve',
          from: 'duo',
          to: 'card',
          frames: 4,
        },
      ],
      subtitles: {
        style: {},
        cues: [
          {
            id: 'contact',
            text: 'Contact',
            start: { numerator: 3, denominator: 2 },
            end: { numerator: 2, denominator: 1 },
          },
        ],
      },
    });
    const patch = (sourceOut: number) =>
      writeFile(
        path('changes.json'),
        JSON.stringify({
          operations: [
            { operation: 'trim', id: 'duo', sourceOut, placement: 'ripple' },
          ],
        }),
      );
    const run = (...args: string[]) => [
      'timeline',
      'patch',
      path('before.video.ts'),
      '--edit',
      path('changes.json'),
      ...args,
    ];
    const original = await readFile(path('before.video.ts'));
    await patch(24);
    const dry = command(run('--dry-run'));
    assert.equal(dry.operations[0].rippleFrames, 6);
    assert.equal(dry.operations[0].source.availableThroughFrame, 48);
    assert.deepEqual(dry.duration, { before: 36, after: 42, deltaFrames: 6 });
    assert.equal(
      dry.affected.find(({ id }: { id: string }) => id === 'ending')
        .movementFrames,
      6,
    );
    assert.equal(
      dry.affected.find(({ id }: { id: string }) => id === 'contact')
        .movementFrames,
      6,
    );
    await patch(50);
    const invalid = command(run('--output', path('after.video.ts')), 1);
    assert.match(invalid.error.message, /Insufficient source footage/);
    await assert.rejects(stat(path('after.video.ts')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path('before.video.ts')), original);
    await patch(24);
    command(run('--output', path('after.video.ts')));
    assert.equal(command(['validate', path('after.video.ts')]).frameCount, 42);
  }));

async function renderReport(
  definition: string,
  output: string,
  ...options: string[]
) {
  const report = command([
    'render',
    definition,
    '--output',
    output,
    '--revision-evidence',
    ...options,
  ]);
  const reportPath = output + '.render.json';
  await writeFile(reportPath, JSON.stringify(report));
  return { report, reportPath };
}

test('review quality override is reflected in the picture comparison against a render report', () =>
  fixture(async (dir) => {
    const definition = join(dir, 'edit.video.ts');
    const baseline = join(dir, 'baseline.mp4');
    await draft(definition, {
      canvas: { width: 72, height: 128, frameRate: 12, durationFrames: 12 },
      tracks: [],
    });
    const { reportPath } = await renderReport(
      definition,
      baseline,
      '--quality',
      'quality',
    );
    const review = (quality: string) =>
      command([
        'review',
        definition,
        '--against',
        baseline,
        '--render-report',
        reportPath,
        '--quality',
        quality,
        '--output',
        join(dir, quality),
      ]).candidates[0];

    assert.equal(review('quality').samePicture, true);
    const fast = review('fast');
    assert.equal(fast.samePicture, false);
    assert.deepEqual(fast.changes.ranges, [
      {
        startFrame: 0,
        endFrame: 12,
        affects: 'picture',
        reasons: ['picture render settings'],
      },
    ]);
    await stat(join(dir, 'fast', fast.marks[0].after.file));
  }));

test('review of a subtitle-free report accepts a definition above the subtitle burn-in limit', () =>
  fixture(async (dir) => {
    const definition = join(dir, 'edit.video.ts');
    const baseline = join(dir, 'baseline.mp4');
    const marks = join(dir, 'marks.json');
    const cues = Array.from(
      { length: maxRenderedSubtitleCues + 1 },
      (_, i) => ({
        id: 'caption-' + i,
        text: 'Caption',
        start: { numerator: i, denominator: 12 },
        end: { numerator: i + 1, denominator: 12 },
      }),
    );
    await draft(definition, {
      canvas: {
        width: 72,
        height: 128,
        frameRate: 12,
        durationFrames: cues.length,
      },
      tracks: [],
      subtitles: { style: {}, cues },
    });
    await writeFile(
      marks,
      JSON.stringify([{ name: 'opening', start: 0, end: 1 }]),
    );
    const { reportPath } = await renderReport(
      definition,
      baseline,
      '--no-subtitles',
    );
    const output = join(dir, 'review');
    const result = command([
      'review',
      definition,
      '--against',
      baseline,
      '--render-report',
      reportPath,
      '--marks',
      marks,
      '--output',
      output,
    ]);
    const candidate = result.candidates[0];
    assert.equal(candidate.samePicture, true);
    assert.deepEqual(candidate.changes.ranges, []);
    await stat(join(output, candidate.marks[0].after.file));
  }));

test('changing an unselected music candidate flags audio differences in matched exports', () =>
  fixture(async (dir) => {
    const path = (file: string) => join(dir, file);
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      path('tone.wav'),
    );
    const definition = (alternateVolume: number) => ({
      canvas: { width: 72, height: 128, frameRate: 12, durationFrames: 48 },
      assets: { tone: { kind: 'audio', path: 'tone.wav' } },
      tracks: [
        {
          id: 'selected',
          type: 'audio',
          audioRole: 'music',
          clips: [{ id: 'bed', asset: 'tone', at: 0, sourceOut: 48 }],
        },
        {
          id: 'alternate',
          type: 'audio',
          audioRole: 'music',
          clips: [
            {
              id: 'alt',
              asset: 'tone',
              at: 0,
              sourceOut: 48,
              volume: alternateVolume,
            },
          ],
        },
      ],
      musicComparison: {
        selected: 'selected',
        matchLoudness: true,
        candidates: [{ trackId: 'selected' }, { trackId: 'alternate' }],
      },
    });
    await draft(path('before.video.ts'), definition(1));
    await draft(path('after.video.ts'), definition(0.02));
    const before = await renderReport(
      path('before.video.ts'),
      path('before.mp4'),
    );
    const after = await renderReport(path('after.video.ts'), path('after.mp4'));
    assert.ok(
      after.report.musicLoudness.targetLufs <
        before.report.musicLoudness.targetLufs,
    );
    assert.equal(
      (await compareAudioPackets(path('before.mp4'), path('after.mp4'))).passed,
      false,
    );

    const result = command([
      'review',
      path('after.mp4'),
      '--against',
      path('before.mp4'),
      '--render-report',
      before.reportPath,
      '--candidate-report',
      after.reportPath,
      '--output',
      path('review'),
    ]);
    assert.deepEqual(result.candidates[0].changes.ranges, [
      {
        startFrame: 0,
        endFrame: 48,
        affects: 'audio',
        reasons: ['music bed'],
      },
    ]);
    assert.equal(result.candidates[0].samePicture, true);
  }));

test('timeline patch trims detached audio while preserving padding past the decoded stream', () =>
  fixture(async (dir) => {
    const path = (file: string) => join(dir, file);
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=72x128:rate=12:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=0.5',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-c:a',
      'aac',
      path('short-audio.mp4'),
    );
    await draft(path('before.video.ts'), {
      canvas: { width: 72, height: 128, frameRate: 12 },
      assets: { source: { kind: 'video', path: 'short-audio.mp4' } },
      tracks: [
        {
          type: 'video',
          muted: true,
          clips: [{ id: 'picture', asset: 'source', at: 0, sourceOut: 12 }],
        },
        {
          type: 'audio',
          clips: [
            {
              id: 'detached',
              asset: 'source',
              detachedAudio: true,
              at: 0,
              sourceOut: 12,
            },
          ],
        },
      ],
    });
    await writeFile(
      path('edit.json'),
      JSON.stringify({
        operations: [
          {
            operation: 'trim',
            id: 'detached',
            sourceOut: 9,
            placement: 'keep',
          },
        ],
      }),
    );
    const patch = [
      'timeline',
      'patch',
      path('before.video.ts'),
      '--edit',
      path('edit.json'),
    ];
    const dry = command([...patch, '--dry-run']);
    assert.deepEqual(dry.operations[0].source, {
      before: { startFrame: 0, endFrame: 12 },
      after: { startFrame: 0, endFrame: 9 },
      availableThroughFrame: 6,
    });
    command([...patch, '--output', path('after.video.ts')]);
    const result = command([
      'render',
      path('after.video.ts'),
      '--output',
      path('after.mp4'),
    ]);
    assert.equal(result.frameCount, 12);
    assert.equal(result.metadata.audio.durationSeconds, 1);
  }));
