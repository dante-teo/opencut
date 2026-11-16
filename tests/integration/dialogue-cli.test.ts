import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureDirectory } from '../fixture-paths.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const audioProbe = {
  format: { format_name: 'wav', duration: '1' },
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le' }],
};

describe.skipIf(process.platform === 'win32')('dialogue CLI preflight', () => {
  let directory: string;

  beforeEach(() => {
    mkdirSync(fixtureDirectory, { recursive: true });
    directory = mkdtempSync(join(fixtureDirectory, 'dialogue-cli-'));
    writeFileSync(join(directory, 'source.wav'), '');
    writeFileSync(
      join(directory, 'ffprobe'),
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(audioProbe)}'\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function runDialogue(python: string) {
    return spawnSync(
      process.execPath,
      [entry, 'separate-dialogue', 'source.wav', '-o', 'stems', '--json'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 4000,
        env: {
          ...process.env,
          HOME: directory,
          PATH: [directory, dirname(process.execPath)].join(delimiter),
          OPENCUT_DIALOGUE_PYTHON: python,
          NODE_NO_WARNINGS: '1',
        },
      },
    );
  }

  it('reports a missing Python backend as a missing dependency', () => {
    const result = runDialogue(join(directory, 'absent-python'));
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: 'MISSING_DEPENDENCY',
        message: expect.stringContaining('opencut models inspect'),
      },
    });
  });

  it.each([
    { probe: 'version', signal: 'SIGINT', exitCode: 130 },
    { probe: 'runtime', signal: 'SIGTERM', exitCode: 143 },
  ])(
    'cancels while the Python $probe probe is running',
    ({ probe, signal, exitCode }) => {
      const python = join(directory, 'python');
      writeFileSync(
        python,
        `#!/usr/bin/env node
const probingVersion = process.argv.at(-1).includes('version("eluate")');
if (${probe === 'runtime'} && probingVersion) {
  console.log('0.0.3');
} else {
  process.kill(process.ppid, '${signal}');
  setTimeout(() => {}, 6000);
}
`,
        { mode: 0o755 },
      );
      const result = runDialogue(python);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(exitCode);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { message: 'Render cancelled.' },
      });
    },
  );
});
