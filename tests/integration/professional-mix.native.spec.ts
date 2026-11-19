import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  analyzeVideoMix,
  compileVideo,
  previewVideo,
  renderCompiledVideo,
  renderVideo,
} from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import { withRenderBudget } from '../../packages/media/dist/index.js';
import { fixtureDirectory } from '../fixture-paths.js';

function ffmpeg(args: string[]) {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-xerror', ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

function makeAudio(path: string, source: string, codec: string) {
  ffmpeg(['-f', 'lavfi', '-i', source, '-c:a', codec, path]);
}

function channelTone(
  path: string,
  from: number,
  frequency: number,
  channel: number,
) {
  const pcm = ffmpeg([
    '-ss',
    String(from),
    '-i',
    path,
    '-t',
    '0.12',
    '-map',
    '0:a:0',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    'f32le',
    '-',
  ]);
  let x = 0;
  let y = 0;
  const samples = pcm.length / 8;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readFloatLE(8 * i + channel * 4);
    const angle = (2 * Math.PI * frequency * i) / 48000;
    x += value * Math.sin(angle);
    y += value * Math.cos(angle);
  }
  return (2 * Math.hypot(x, y)) / samples;
}

const cli = (args: string[]) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/cli/dist/index.js', ...args, '--json'],
      { encoding: 'utf8' },
    ),
  ) as unknown;

test(
  'professional mix exports a verified master, routes stereo and round-trips edited curves through the CLI',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      join(fixtureDirectory, 'professional-mix-'),
    );
    try {
      const file = join(directory, 'session.video.ts');
      const dialogue = join(directory, 'session.flac');
      const music = join(directory, 'bed.wav');
      // Two differently recorded synthetic utterances. The two music tracks
      // overlap, and an unrelated stereo effect must remain unducked.
      makeAudio(
        dialogue,
        'aevalsrc=if(between(t\\,0.40\\,1.10)\\,0.22*(sin(2*PI*317*t)+0.25*sin(2*PI*951*t))\\,if(between(t\\,1.20\\,1.75)\\,0.05*sin(2*PI*377*t)\\,0)+0.002*sin(2*PI*61*t)):s=32000:d=2',
        'flac',
      );
      makeAudio(
        music,
        'aevalsrc=0.10*sin(2*PI*600*t)|0.10*sin(2*PI*800*t):s=44100:d=6',
        'pcm_s16le',
      );
      makeAudio(
        join(directory, 'effects.wav'),
        'aevalsrc=0|0.035*sin(2*PI*1275*t):s=48000:d=6',
        'pcm_s16le',
      );
      const original = createHash('sha256')
        .update(await readFile(dialogue))
        .digest('hex');
      const definition: VideoDefinition = {
        canvas: { width: 160, height: 90, frameRate: 30, durationFrames: 180 },
        assets: {
          take: { path: 'session.flac', kind: 'audio' },
          bed: { path: 'bed.wav', kind: 'audio' },
          fx: { path: 'effects.wav', kind: 'audio' },
        },
        tracks: [
          {
            type: 'audio',
            id: 'voice',
            audioRole: 'dialogue',
            clips: [{ id: 'speaker', asset: 'take', at: 30, sourceOut: 60 }],
          },
          {
            type: 'audio',
            id: 'voiceB',
            audioRole: 'dialogue',
            clips: [
              {
                id: 'reply',
                asset: 'take',
                at: 90,
                sourceIn: 36,
                sourceOut: 60,
              },
            ],
          },
          {
            type: 'audio',
            id: 'music',
            audioRole: 'music',
            volume: 0.35,
            clips: [{ asset: 'bed', at: 0, sourceOut: 180 }],
          },
          {
            type: 'audio',
            id: 'musicB',
            audioRole: 'music',
            volume: 0.15,
            clips: [{ asset: 'bed', at: 0, sourceOut: 180 }],
          },
          {
            type: 'audio',
            id: 'effect',
            audioRole: 'other',
            clips: [{ asset: 'fx', at: 0, sourceOut: 180 }],
          },
        ],
        professionalMix: {
          preset: 'natural-cinematic',
          matching: { amount: 0.8, referenceClip: 'speaker' },
          ducking: { depthDb: 12, attackMs: 180, holdMs: 200, releaseMs: 300 },
          delivery: { preset: 'web', truePeakDbtp: -1.5 },
        },
      };
      await writeFile(file, 'export default ' + JSON.stringify(definition));
      const video = await compileVideo(file);
      const path = join(directory, 'after.mp4');
      const after = await renderCompiledVideo(video, path);
      const report = after.audioMix!;
      assert.ok(report.automation.dialogue.speaker?.length);
      assert.ok(report.automation.dialogue.reply?.length);
      assert.ok(report.automation.music.some((point) => point.db === -12));
      assert.ok(
        report.automation.music.some(
          (point) => point.sample < 1.4 * 48000 && point.db === 0,
        ),
      );
      assert.ok(
        report.output.integratedLufs !== null &&
          Math.abs(report.output.integratedLufs + 16) < 1,
      );
      assert.ok(
        report.output.truePeakDbtp !== null &&
          report.output.truePeakDbtp <= -1.5,
      );
      assert.equal(after.metadata.audio!.startTimeSeconds, 0);
      assert.equal(after.metadata.audio!.durationSeconds, 6);
      assert.ok(
        channelTone(path, 1.55, 600, 0) < channelTone(path, 4.9, 600, 0) * 0.33,
      );
      assert.ok(
        channelTone(path, 4.9, 600, 1) < channelTone(path, 4.9, 600, 0) * 0.08,
      );
      const effect =
        channelTone(path, 1.55, 1275, 1) / channelTone(path, 4.9, 1275, 1);
      assert.ok(
        effect > 0.9 && effect < 1.1,
        `Other audio was affected by ducking: ${effect}`,
      );

      const before = await renderCompiledVideo(
        video,
        join(directory, 'before.mp4'),
        { audioComparison: 'before' },
      );
      assert.ok(
        Math.abs(
          before.audioMix!.output.integratedLufs! -
            report.output.integratedLufs!,
        ) < 1,
      );
      const clip = await previewVideo(video).clip(
        { startFrame: 30, endFrame: 90 },
        join(directory, 'clip.mp4'),
      );
      assert.deepEqual(clip.audioMix!.automation, report.automation);
      const analysis = await analyzeVideoMix(video);
      assert.deepEqual(analysis, report);
      assert.deepEqual(cli(['mix', 'analyze', file]), report);

      const edit = join(directory, 'edit.json');
      await writeFile(
        edit,
        JSON.stringify({
          mix: {
            ...definition.professionalMix,
            automation: { ...report.automation, music: [] },
          },
        }),
      );
      const cliFile = join(directory, 'cli.mp4');
      const overridden = cli([
        'render',
        file,
        '--output',
        cliFile,
        '--mix-settings',
        edit,
        '--audio-rate',
        '44100',
        '--audio-channels',
        '1',
      ]) as typeof after;
      assert.deepEqual(overridden.audioMix!.automation.music, []);
      assert.equal(overridden.metadata.audio!.sampleRate, 44100);
      assert.equal(overridden.metadata.audio!.channels, 1);
      const bypass = await renderVideo(file, join(directory, 'bypass.mp4'), {
        audioMixEdit: { mix: null },
      });
      assert.equal(bypass.audioMix, undefined);
      assert.equal(
        createHash('sha256')
          .update(await readFile(dialogue))
          .digest('hex'),
        original,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'professional mix preserves late timeline alignment at fractional frame rates',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      join(fixtureDirectory, 'professional-mix-sync-'),
    );
    try {
      const audio = join(directory, 'sync.wav');
      makeAudio(
        audio,
        'aevalsrc=if(between(t\\,0.32\\,0.42)\\,0.45*sin(2*PI*321*t)\\,0.004*sin(2*PI*81*t)):s=48000:d=2',
        'pcm_s16le',
      );
      const frameRate = { numerator: 24000, denominator: 1001 };
      const at = 7900;
      const file = join(directory, 'sync.video.ts');
      const definition: VideoDefinition = {
        canvas: { width: 64, height: 36, frameRate, durationFrames: at + 96 },
        assets: { take: { path: 'sync.wav', kind: 'audio' } },
        tracks: [
          {
            type: 'audio',
            id: 'dial',
            audioRole: 'dialogue',
            clips: [
              { id: 'first-marker', asset: 'take', at: 0, sourceOut: 39 },
              { id: 'last-marker', asset: 'take', at, sourceOut: 39 },
            ],
          },
        ],
        professionalMix: {
          preset: 'clear-voiceover',
          cleanup: 1,
          delivery: { preset: 'broadcast' },
        },
      };
      await writeFile(file, 'export default ' + JSON.stringify(definition));
      const path = join(directory, 'sync.mp4');
      const result = await renderVideo(file, path, { quality: 'fast' });
      const late = (at * frameRate.denominator) / frameRate.numerator;
      const times = [0, late].map((clipStart) => {
        const pcm = ffmpeg([
          '-i',
          path,
          '-af',
          `atrim=start_sample=${Math.round(clipStart * 48000)},asetpts=N/SR/TB`,
          '-t',
          '0.6',
          '-vn',
          '-ac',
          '1',
          '-f',
          'f32le',
          '-',
        ]);
        const windows: number[] = [];
        for (let from = 0; from < pcm.length / 4 - 240; from += 240) {
          let energy = 0;
          for (let i = from; i < from + 240; i++)
            energy += pcm.readFloatLE(i * 4) ** 2;
          windows.push(Math.sqrt(energy / 240));
        }
        const peak = Math.max(...windows);
        return (
          windows.findIndex(
            (rms, i) => rms > peak * 0.5 && (windows[i + 1] ?? 0) > peak * 0.5,
          ) * 0.005
        );
      });
      assert.ok(
        times[0]! > 0.31 && times[0]! < 0.34,
        `DSP shifted onset: ${times[0]}`,
      );
      assert.ok(
        Math.abs(times[0]! - times[1]!) <= 0.0051,
        `Markers drifted: ${times}`,
      );
      assert.ok(
        Math.abs(
          result.metadata.audio!.durationSeconds! - result.durationSeconds,
        ) < 0.001,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'crossfades dialogue source handles without moving the incoming edit',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(
      join(fixtureDirectory, 'professional-mix-crossfade-'),
    );
    try {
      makeAudio(
        join(directory, 'a.wav'),
        'sine=frequency=260:d=2',
        'pcm_s16le',
      );
      makeAudio(
        join(directory, 'b.wav'),
        'sine=frequency=720:d=2',
        'pcm_s16le',
      );
      const file = join(directory, 'cut.video.ts');
      const mix = {
        preset: 'natural-cinematic',
        highPassHz: 0,
        clarity: 0,
        warmth: 0,
        deEsser: 0,
        cleanup: 0,
        consistency: 0,
        matching: { amount: 0 },
        crossfadeMs: 200,
      } satisfies VideoDefinition['professionalMix'];
      const definition: VideoDefinition = {
        canvas: { width: 64, height: 36, frameRate: 30, durationFrames: 60 },
        assets: {
          a: { path: 'a.wav', kind: 'audio' },
          b: { path: 'b.wav', kind: 'audio' },
        },
        tracks: [
          {
            type: 'audio',
            audioRole: 'dialogue',
            clips: [
              { asset: 'a', at: 0, sourceOut: 30 },
              { asset: 'b', at: 30, sourceIn: 15, sourceOut: 45 },
            ],
          },
        ],
        professionalMix: mix,
      };
      await writeFile(file, 'export default ' + JSON.stringify(definition));
      const withFade = (await renderVideo(file, join(directory, 'with.mp4')))
        .path;
      const withoutFade = (
        await renderVideo(file, join(directory, 'without.mp4'), {
          audioMixEdit: { mix: { ...mix, crossfadeMs: 0 } },
        })
      ).path;
      const incoming = channelTone(withFade, 0.84, 720, 0);
      assert.ok(incoming > 0.025);
      assert.ok(incoming > 10 * channelTone(withoutFade, 0.84, 720, 0));
      assert.ok(channelTone(withFade, 0.84, 260, 0) > 0.025);
      const after =
        channelTone(withFade, 1.2, 720, 0) /
        channelTone(withoutFade, 1.2, 720, 0);
      assert.ok(after > 0.93 && after < 1.07);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'preserves continuous dialogue across one-frame splits at quarter speed',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(
      join(fixtureDirectory, 'professional-mix-tempo-'),
    );
    try {
      makeAudio(
        join(directory, 'voice.wav'),
        'sine=frequency=400:sample_rate=48000:duration=1',
        'pcm_s16le',
      );
      const time = (numerator: number) => ({ numerator, denominator: 120 });
      const speed = { numerator: 1, denominator: 4 };
      const definition: VideoDefinition = {
        canvas: { width: 64, height: 36, frameRate: 30, durationFrames: 30 },
        assets: { voice: { path: 'voice.wav', kind: 'audio' } },
        tracks: [
          {
            type: 'audio',
            audioRole: 'dialogue',
            clips: [{ asset: 'voice', at: 0, sourceOut: time(30), speed }],
          },
        ],
        professionalMix: {
          preset: 'natural-cinematic',
          highPassHz: 0,
          warmth: 0,
          clarity: 0,
          consistency: 0,
          cleanup: 0,
          deEsser: 0,
          compressor: {
            thresholdDb: -17,
            ratio: 1,
            attackMs: 25,
            releaseMs: 270,
          },
          matching: { amount: 0 },
        },
      };
      const render = async (name: string) => {
        const file = join(directory, name + '.video.ts');
        await writeFile(file, 'export default ' + JSON.stringify(definition));
        const result = await renderVideo(file, join(directory, name + '.mp4'));
        return ffmpeg([
          '-i',
          result.path,
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-f',
          'f32le',
          '-',
        ]);
      };
      const continuous = await render('continuous');
      definition.tracks[0]!.clips = Array.from({ length: 30 }, (_, frame) => ({
        asset: 'voice',
        at: frame,
        sourceIn: time(frame),
        sourceOut: time(frame + 1),
        speed,
      }));
      const split = await render('split');
      const energy = (pcm: Buffer, from: number) => {
        let sum = 0;
        for (let sample = from; sample < from + 640; sample++)
          sum += pcm.readFloatLE(sample * 4) ** 2;
        return sum;
      };
      for (let frame = 1; frame < 27; frame++) {
        const from = frame * 1600 + 880;
        assert.ok(
          energy(split, from) > 0.8 * energy(continuous, from),
          `Split frame ${frame} lost audio.`,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'limits DeepFilterNet output size before the subprocess can finish writing',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(
      join(fixtureDirectory, 'professional-mix-budget-'),
    );
    const before = process.env.OPENCUT_DEEPFILTER;
    try {
      const started = join(directory, 'started');
      const escaped = join(directory, 'exceeded-limit');
      const backend = join(directory, 'deep-filter.cjs');
      await writeFile(
        backend,
        `#!${process.execPath}
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      if (process.argv.includes('--version')) {
        console.log('test DeepFilterNet');
      } else {
        writeFileSync(${JSON.stringify(started)}, '');
        const output = process.argv[process.argv.indexOf('-o') + 1];
        writeFileSync(join(output, 'speech.wav'), Buffer.alloc(2 * 1024 * 1024));
        writeFileSync(${JSON.stringify(escaped)}, '');
      }
    `,
        { mode: 0o755 },
      );
      process.env.OPENCUT_DEEPFILTER = backend;
      makeAudio(
        join(directory, 'voice.wav'),
        'sine=frequency=400:sample_rate=48000:duration=0.5',
        'pcm_s16le',
      );
      const file = join(directory, 'limited.video.ts');
      const definition: VideoDefinition = {
        canvas: { width: 64, height: 36, frameRate: 30, durationFrames: 15 },
        assets: { voice: { path: 'voice.wav', kind: 'audio' } },
        tracks: [
          {
            type: 'audio',
            audioRole: 'dialogue',
            clips: [{ asset: 'voice', at: 0, sourceOut: 15 }],
          },
        ],
        professionalMix: { preset: 'natural-cinematic', ai: 'deepfilternet' },
      };
      await writeFile(file, 'export default ' + JSON.stringify(definition));
      const video = await compileVideo(file);
      await assert.rejects(
        withRenderBudget(
          { maxTemporaryBytes: 512 * 1024, maxNativeBytes: 512 * 1024 * 1024 },
          () => analyzeVideoMix(video),
        ),
        /DeepFilterNet.*temporary disk budget/,
      );
      await readFile(started);
      await assert.rejects(readFile(escaped), { code: 'ENOENT' });
    } finally {
      if (before === undefined) delete process.env.OPENCUT_DEEPFILTER;
      else process.env.OPENCUT_DEEPFILTER = before;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
