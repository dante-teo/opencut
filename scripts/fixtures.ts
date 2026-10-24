import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtures,
  requireTool,
  runTool,
  validateFixture,
} from './fixture-lib.js';
import type { Fixture } from './fixture-lib.js';

const output = fileURLToPath(
  new URL('../tests/fixtures/generated/', import.meta.url),
);

function generateArgs(fixture: Fixture): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-fflags',
    '+bitexact',
  ];
  if (fixture.video) {
    const { width, height, frameRate } = fixture.video;
    // Moving patterns plus a top-left white flash at the start of every second.
    const source = `testsrc2=size=${width}x${height}:rate=${frameRate ?? 1}`;
    const flash =
      ",drawbox=x=0:y=0:w=32:h=32:color=white:t=fill:enable='lt(mod(t,1),0.1)'";
    args.push('-f', 'lavfi', '-i', source + (frameRate ? flash : ''));
  }
  if (fixture.audio) {
    // Pulses align with the visual flashes in the video fixtures.
    const tone = `sine=frequency=${fixture.toneHz}:sample_rate=${fixture.audio.sampleRate}`;
    const pulse = fixture.video
      ? ",volume='if(lt(mod(t,1),0.1),1,0)':eval=frame"
      : '';
    args.push('-f', 'lavfi', '-i', tone + pulse);
  }
  if (fixture.durationSeconds !== undefined)
    args.push('-t', String(fixture.durationSeconds));
  if (fixture.video?.frameRate) {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-threads:v',
      '1',
      '-flags:v',
      '+bitexact',
    );
    if (!fixture.audio) args.push('-an');
  } else if (fixture.video) {
    args.push(
      '-frames:v',
      '1',
      '-c:v',
      'png',
      '-threads:v',
      '1',
      '-update',
      '1',
    );
  }
  if (fixture.audio) {
    args.push(
      '-c:a',
      fixture.audio.codec === 'aac' ? 'aac' : 'pcm_s16le',
      '-ar',
      String(fixture.audio.sampleRate),
      '-ac',
      String(fixture.audio.channels),
      '-flags:a',
      '+bitexact',
    );
    if (fixture.audio.codec === 'aac') args.push('-b:a', '96k');
  }
  if (fixture.video?.frameRate) args.push('-movflags', '+faststart');
  args.push('-map_metadata', '-1', join(output, fixture.file));
  return args;
}

async function validate(): Promise<void> {
  for (const fixture of fixtures) {
    const file = join(output, fixture.file);
    validateFixture(fixture, file);
    process.stdout.write(`Validated ${fixture.file}\n`);
  }
}

async function generate(): Promise<void> {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  // Exclusive creation refuses existing directories and symlinks, protecting files.
  try {
    await mkdir(output);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        'Refusing to overwrite tests/fixtures/generated. To regenerate, explicitly remove only that generated directory after reviewing its contents.',
      );
    }
    throw error;
  }
  try {
    for (const fixture of fixtures) {
      runTool('ffmpeg', generateArgs(fixture));
      process.stdout.write(`Generated ${fixture.file}\n`);
    }
    await validate();
  } catch (error) {
    // Only remove the directory exclusively created by this invocation.
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['generate', 'validate'].includes(args[0] ?? '')) {
    throw new Error('Usage: pnpm fixtures:generate | pnpm fixtures:validate');
  }
  if (args[0] === 'generate') await generate();
  else {
    requireTool('ffprobe');
    await validate();
  }
} catch (error) {
  process.stderr.write(
    `Fixtures: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
