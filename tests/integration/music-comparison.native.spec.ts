import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileVideo, defineVideo, renderVideo } from '@opencut/sdk';
import { planProjectRender } from '@opencut/core';
import { fixtureDirectory } from '../fixture-paths.js';
import { decodeAudio } from './audio-comparison.js';
import { ffmpeg, verifyVideoTimestamps } from './media-comparison.js';

test('music candidates match their authored excerpts, retain dialogue, and reuse the encoded picture', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'music-comparison-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rate = { numerator: 30, denominator: 1 };
  const file = join(directory, 'scene.video.ts');
  for (const [name, gain, hz] of [
    ['voice', 0.12, 400],
    ['bright', 0.2, 700],
    ['soft', 0.02, 900],
  ] as const) {
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=${gain}*sin(2*PI*${hz}*t):s=48000:d=4`,
      '-c:a',
      'pcm_f32le',
      join(directory, `${name}.wav`),
    ]);
  }
  const definition = defineVideo({
    canvas: { width: 160, height: 90, frameRate: rate, durationFrames: 120 },
    assets: {
      voice: { path: 'voice.wav', kind: 'audio' },
      bright: { path: 'bright.wav', kind: 'audio' },
      soft: {
        path: 'soft.wav',
        kind: 'audio',
        provenance: {
          provider: 'commons',
          creator: 'Composer',
          sourceUrl: 'https://example.org/soft',
          license: 'CC0',
          licenseUrl: 'https://example.org/cc0',
        },
      },
    },
    tracks: [
      {
        id: 'speech',
        type: 'audio',
        audioRole: 'dialogue',
        clips: [{ asset: 'voice', at: 0, sourceOut: 120 }],
      },
      {
        id: 'bright-bed',
        type: 'audio',
        name: 'Bright',
        audioRole: 'music',
        clips: [{ asset: 'bright', at: 0, sourceOut: 90, fadeOut: 6 }],
      },
      {
        id: 'soft-bed',
        type: 'audio',
        name: 'Soft',
        audioRole: 'music',
        clips: [
          { asset: 'soft', at: 30, sourceIn: 20, sourceOut: 110, fadeIn: 12 },
        ],
      },
      {
        id: 'muted-take',
        type: 'audio',
        muted: true,
        clips: [{ asset: 'soft', at: 0, sourceOut: 30 }],
      },
    ],
    musicComparison: {
      selected: 'bright-bed',
      matchLoudness: true,
      candidates: [
        { trackId: 'bright-bed' },
        {
          trackId: 'soft-bed',
          ducking: { depthDb: 9 },
          previouslyUsedIn: ['April delivery'],
        },
      ],
    },
  });
  const save = () =>
    writeFile(file, 'export default ' + JSON.stringify(definition));
  await save();
  const pictureCacheDirectory = join(directory, 'cache');
  const bright = await renderVideo(file, join(directory, 'bright.mp4'), {
    pictureCacheDirectory,
    pictureVersion: 'save',
  });
  const soft = await renderVideo(file, join(directory, 'soft.mp4'), {
    pictureCacheDirectory,
    pictureVersion: bright.pictureVersion!.id,
    musicSelection: { candidate: 'soft-bed' },
  });
  assert.deepEqual(soft.pictureVersion, {
    id: bright.pictureVersion!.id,
    status: 'reused',
  });
  verifyVideoTimestamps(soft.path, rate, 120);
  assert.equal(soft.musicComparison?.selected, 'soft-bed');
  const selected = soft.musicComparison?.candidates[1];
  assert.deepEqual(selected?.previouslyUsedIn, ['April delivery']);
  assert.deepEqual(
    selected?.sources.map(({ path, provenance, reusedInProject }) => [
      path,
      provenance?.creator,
      reusedInProject,
    ]),
    [['soft.wav', 'Composer', true]],
  );
  assert.equal(
    bright.musicLoudness?.targetLufs,
    soft.musicLoudness?.targetLufs,
  );
  const a = bright.musicLoudness!;
  const b = soft.musicLoudness!;
  assert.ok(b.gainDb - a.gainDb > 12);
  assert.ok(
    Math.abs(
      a.candidates['bright-bed']!.integratedLufs! +
        a.gainDb -
        (b.candidates['soft-bed']!.integratedLufs! + b.gainDb),
    ) < 0.01,
  );

  const original = decodeAudio(bright.path).samples;
  const revision = decodeAudio(soft.path).samples;
  function amplitude(pcm: Float32Array, hz: number, from: number) {
    const window = pcm.subarray(from * 48000, from * 48000 + 4800);
    return Math.abs(
      (2 *
        window.reduce(
          (sum, value, i) =>
            sum + value * Math.sin(2 * Math.PI * hz * (from + i / 48000)),
          0,
        )) /
        window.length,
    );
  }
  assert.ok(
    Math.abs(amplitude(original, 400, 1.5) - amplitude(revision, 400, 1.5)) <
      0.003,
  );
  assert.ok(
    amplitude(original, 700, 1.5) > 0.02 &&
      amplitude(revision, 700, 1.5) < 0.002,
  );
  assert.ok(
    amplitude(revision, 900, 1.5) > 0.02 &&
      amplitude(revision, 900, 0.5) < 0.002,
  );

  definition.professionalMix = {
    preset: 'natural-cinematic',
    ducking: { depthDb: 15, holdMs: 100 },
  };
  await save();
  const compiled = await compileVideo(file, {
    musicSelection: { candidate: 'soft-bed' },
  });
  const baseMix = compiled.project.professionalMix!;
  assert.deepEqual(baseMix.ducking, { depthDb: 15, holdMs: 100 });
  const overriddenDucking = {
    depthDb: 9,
    holdMs: 100,
  };
  assert.deepEqual(
    (await compiled.resolveRender()).professionalMix?.ducking,
    overriddenDucking,
  );
  const savedProject = structuredClone(compiled.project);
  assert.deepEqual(
    planProjectRender(savedProject).professionalMix?.ducking,
    overriddenDucking,
  );
  assert.deepEqual(savedProject.professionalMix?.ducking, baseMix.ducking);
  const edited = await compileVideo(file, {
    musicSelection: { candidate: 'bright-bed' },
    audioMixEdit: { mix: { ...baseMix, clarity: 0.7 } },
  });
  assert.deepEqual((await edited.resolveRender()).professionalMix, {
    ...baseMix,
    clarity: 0.7,
  });
  await assert.rejects(
    compileVideo(file, { musicSelection: { candidate: 'unknown' } }),
    /Unknown music candidate/,
  );
});
