import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTool } from '../../scripts/fixture-lib.js';
import { fixtureDirectory } from '../fixture-paths.js';

const cli = (directory: string, extension: string) =>
  fileURLToPath(
    new URL(
      '../../apps/cli/' + directory + '/index.' + extension,
      import.meta.url,
    ),
  );

test(
  'transcription finds its worker in both CLI layouts and extracts picture-relative audio',
  {
    skip: process.platform === 'win32',
    timeout: 30_000,
  },
  async () => {
    await mkdir(fixtureDirectory, { recursive: true });
    const directory = await mkdtemp(
      join(fixtureDirectory, 'transcript-clock-'),
    );
    try {
      const media = join(directory, 'lead-in.mkv');
      runTool('ffmpeg', [
        '-v',
        'error',
        '-n',
        '-itsoffset',
        '1',
        '-f',
        'lavfi',
        '-i',
        'color=s=32x32:r=12:d=1',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=if(lt(t\\,1)\\,0\\,0.5*sin(2*PI*440*t)):s=16000:d=2',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'ffv1',
        '-c:a',
        'pcm_s16le',
        media,
      ]);
      const python = join(directory, 'fake-python.cjs');
      await writeFile(
        python,
        `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { dirname, basename } = require('node:path');
const [, , , worker, argument] = process.argv;
const source = readFileSync(worker, 'utf8');
if (!source.includes('def status()')) throw Error('Speech worker is missing.');
if (argument === 'status') {
  console.log(JSON.stringify({ runtime: basename(dirname(worker)), asrModel: true, alignerModel: false }));
} else {
  const request = JSON.parse(readFileSync(argument, 'utf8'));
  const wav = readFileSync(request.audio);
  let cursor = 12;
  while (wav.toString('ascii', cursor, cursor + 4) !== 'data')
    cursor += 8 + wav.readUInt32LE(cursor + 4) + wav.readUInt32LE(cursor + 4) % 2;
  let peak = 0;
  for (let i = cursor + 8; i + 1 < wav.length; i += 2)
    peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  if (peak < 1000) throw Error('Transcription sampled the silent audio lead-in.');
  console.log(JSON.stringify([{ text: 'Tone detected', language: 'English', words: [
    { text: 'Tone', start: 0.1, end: 0.2 },
    { text: 'detected', start: 0.2, end: 0.4 }
  ], reason: null }]));
}
`,
        { mode: 0o755 },
      );
      for (const [layout, args, workerDir] of [
        ['dist', [cli('dist', 'js')], 'dist'],
        ['src', ['--import', 'tsx', cli('src', 'ts')], 'native'],
      ] as const) {
        const out = join(directory, layout + '.json');
        const run = (...command: string[]) => {
          const result = spawnSync(
            process.execPath,
            [...args, ...command, '--json'],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                PATH: [dirname(process.execPath), process.env.PATH].join(':'),
                OPENCUT_SPEECH_PYTHON: python,
              },
              timeout: 12_000,
            },
          );
          assert.equal(
            result.status,
            0,
            result.error?.message ?? result.stderr,
          );
          return JSON.parse(result.stdout);
        };
        assert.equal(run('doctor').ai.transcription.runtime, workerDir);
        const transcript = run(
          'transcribe',
          media,
          '--start',
          '0',
          '--end',
          '0.5',
          '--output',
          out,
        );
        assert.equal(transcript.segments[0].text, 'Tone detected');
        assert.deepEqual(transcript.interval, { start: 0, end: 0.5 });
        assert.equal(transcript.segments[0].words[0].start, 0.1);
        assert.equal(transcript.path, out);
        assert.deepEqual(
          JSON.parse(await readFile(out, 'utf8')).segments,
          transcript.segments,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
