import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { totalmem, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const helper = new URL('../../apps/cli/dist/system-probe', import.meta.url);
const runNode = (...args: string[]) =>
  spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: tmpdir(),
    timeout: 20000,
  });
const run = (...args: string[]) => runNode(entry, ...args);

it('reports the render memory helper independently of FFmpeg availability', () => {
  const { status, stdout } = run('doctor', '--json');
  expect(status).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.graphicsSchemas).toBeTypeOf('object');
  expect(report.media.engine).toEqual({
    status: 'available',
    version: report.application.version,
    protocol: 1,
  });
  expect(report.media.rssHelper).toEqual(
    process.platform === 'darwin'
      ? { status: 'available', version: report.application.version }
      : { status: 'not-applicable', version: null },
  );
});

it('reports compact capabilities with actionable states when FFmpeg is missing', () => {
  const { status, stdout } = spawnSync(
    process.execPath,
    [entry, 'doctor', '--json', '--compact'],
    {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: tmpdir(),
        // Node responds to the backend's --version probe without needing PATH.
        OPENCUT_DEEPFILTER: process.execPath,
        OPENCUT_DEEPFILTER_MODEL: '',
      },
      encoding: 'utf8',
      timeout: 20000,
    },
  );
  expect(status).toBe(0);
  expect(Buffer.byteLength(stdout)).toBeLessThan(10000);
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({
    doctorVersion: 1,
    format: 'compact',
    capabilities: {
      ffmpeg: {
        status: 'unavailable',
        reason: expect.stringContaining('missing'),
        nextStep: expect.stringContaining('FFmpeg'),
      },
      aacEncoding: { status: 'unavailable' },
      defaultMp4: { status: 'unavailable' },
      offlineInterpolation: { status: expect.any(String) },
    },
  });
  for (const name of [
    'dialogueSeparation',
    'dialogueEnhancement',
    'transcription',
    'transcriptAlignment',
  ]) {
    expect(report.capabilities[name]).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('ffmpeg, ffprobe'),
      nextStep: expect.stringContaining('ffmpeg and ffprobe'),
    });
  }
  for (const check of Object.values(report.capabilities)) {
    expect(check).toHaveProperty('status');
    expect(check).toHaveProperty('reason', expect.any(String));
    expect(check).toHaveProperty('nextStep');
  }
  expect(report).not.toHaveProperty('graphicsSchemas');
  expect(run('doctor', '--compact').status).toBe(2);
});

describe('system inspect', () => {
  it('reports this host without a project or disclosing device identifiers', () => {
    const { status, stdout, stderr } = run('system', 'inspect', '--json');
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      systemInspectVersion: 1,
      os: { platform: process.platform },
      architecture: { process: process.arch },
      memory: { installedBytes: totalmem() },
      rendering: {
        defaults: { preview: 'fast', render: 'quality' },
        maximumAiMatchesQuality: true,
        resources: {
          nativeBudgetBytes: expect.any(Number),
          recipeWorkers: expect.any(Number),
        },
      },
    });
    expect(stdout).not.toMatch(
      /serial_number|platform_UUID|provisioning_UDID/u,
    );
    const vt = report.videoToolbox;
    if (process.platform !== 'darwin') {
      expect(vt.status).toBe('not-applicable');
    } else if (existsSync(helper)) {
      expect(vt.status).toBe('probed');
      expect(vt.codecs.decoders.h264).toBeTypeOf('boolean');
      expect(vt.codecs.encoders.hevc.availableAt1920x1080).toBeTypeOf(
        'boolean',
      );
      expect(vt.frameProcessors['frame-rate-conversion'].minimumMacOS).toBe(
        '15.4',
      );
      expect(
        vt.frameProcessors['frame-rate-conversion-quality'].minimumMacOS,
      ).toBe('15.4');
      expect(vt.frameProcessors['temporal-noise-filter'].minimumMacOS).toBe(
        '26.0',
      );
    } else {
      expect(vt).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('Native probe is missing'),
      });
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'keeps hardware diagnostics available without the native helper',
    () => {
      const staging = mkdtempSync(join(tmpdir(), 'opencut-system-test-'));
      try {
        const module = join(staging, 'dist', 'system.mjs');
        mkdirSync(join(staging, 'dist'));
        symlinkSync(
          fileURLToPath(new URL('../node_modules', pathToFileURL(entry))),
          join(staging, 'node_modules'),
          'dir',
        );
        copyFileSync(new URL('./system.js', pathToFileURL(entry)), module);
        const result = runNode(
          '--input-type=module',
          '-e',
          'const { inspectSystem } = await import(process.argv[1]); console.log(JSON.stringify(await inspectSystem()));',
          pathToFileURL(module).href,
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toMatchObject({
          memory: { installedBytes: totalmem() },
          videoToolbox: {
            status: 'unavailable',
            reason: expect.stringContaining('Native probe is missing'),
          },
        });
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  );

  it('advertises the command and rejects operands and project options', () => {
    const help = run('help', 'system', 'inspect', '--json');
    expect(JSON.parse(help.stdout).commands).toEqual([
      expect.objectContaining({ name: 'system inspect', arguments: [] }),
    ]);
    for (const args of [['another-file'], ['--width', '1920']]) {
      const result = run('system', 'inspect', '--json', ...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).ok).toBe(false);
    }
  });
});
