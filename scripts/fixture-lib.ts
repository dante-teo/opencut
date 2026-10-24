import { spawnSync } from 'node:child_process';
import manifest from '../tests/fixtures/manifest.json' with { type: 'json' };

export interface Fixture {
  file: string;
  durationSeconds?: number;
  video?: { width: number; height: number; frameRate?: number; codec: string };
  audio?: { sampleRate: number; channels: number; codec: string };
  toneHz: number | null;
}

export interface Probe {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    nb_frames?: string;
    nb_read_frames?: string;
    duration?: string;
    start_time?: string;
    sample_rate?: string;
    channels?: number;
  }>;
  format?: { duration?: string; start_time?: string };
}

export const fixtures: readonly Fixture[] = manifest.fixtures;

export function requireTool(tool: string): void {
  const result = spawnSync(tool, ['-version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `Optional prerequisite '${tool}' is unavailable on PATH. Install it manually to use fixtures. Dependency installation and ordinary tests do not require FFmpeg/ffprobe.`,
      { cause: result.error },
    );
  }
  if (result.status !== 0)
    throw new Error(`${tool} could not start: ${result.stderr}`);
}

export function runTool(tool: string, args: string[]): string {
  const result = spawnSync(tool, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${tool} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  // Callers use error-level logging; ffprobe can report decode errors yet exit 0.
  if (result.status !== 0 || result.stderr.trim() !== '') {
    const reason =
      result.stderr.trim() ||
      `process exited with ${result.signal ?? result.status}`;
    throw new Error(`${tool} failed: ${reason}`);
  }
  return result.stdout;
}

export function validateFixture(fixture: Fixture, file: string): void {
  const probe = JSON.parse(
    runTool('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      file,
    ]),
  ) as Probe;
  validateProbe(fixture, probe);
}

export function validateProbe(fixture: Fixture, probe: Probe): void {
  function check(condition: boolean, message: string): void {
    if (!condition) throw new Error(`${fixture.file}: ${message}`);
  }
  function near(
    actual: string | undefined,
    expected: number,
    tolerance: number,
    label: string,
  ): void {
    check(
      actual !== undefined &&
        actual.trim() !== '' &&
        Number.isFinite(Number(actual)) &&
        Math.abs(Number(actual) - expected) <= tolerance,
      `${label}: expected ${expected} ± ${tolerance}, received ${String(actual)}`,
    );
  }
  const streams = probe.streams ?? [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audios = streams.filter((stream) => stream.codec_type === 'audio');
  check(
    streams.length ===
      Number(Boolean(fixture.video)) + Number(Boolean(fixture.audio)),
    'unexpected stream count',
  );
  check(
    videos.length === Number(Boolean(fixture.video)),
    'unexpected video presence',
  );
  check(
    audios.length === Number(Boolean(fixture.audio)),
    'unexpected audio presence',
  );
  const video = videos[0];
  const audio = audios[0];
  if (fixture.video) {
    check(video?.codec_name === fixture.video.codec, 'unexpected video codec');
    check(
      video?.width === fixture.video.width &&
        video?.height === fixture.video.height,
      'unexpected resolution',
    );
    if (fixture.video.frameRate !== undefined) {
      const [numerator, denominator] = (video?.avg_frame_rate ?? '')
        .split('/')
        .map(Number);
      const fps = Number(numerator) / Number(denominator);
      check(
        Math.abs(fps - fixture.video.frameRate) < 0.001,
        'unexpected frame rate',
      );
      check(
        Number(video?.nb_read_frames) ===
          fixture.video.frameRate * Number(fixture.durationSeconds),
        'unexpected readable frame count',
      );
    }
  }
  if (fixture.audio) {
    check(audio?.codec_name === fixture.audio.codec, 'unexpected audio codec');
    check(
      Number(audio?.sample_rate) === fixture.audio.sampleRate,
      'unexpected audio sample rate',
    );
    check(
      audio?.channels === fixture.audio.channels,
      'unexpected audio channels',
    );
  }
  if (fixture.durationSeconds !== undefined) {
    near(
      probe.format?.duration,
      fixture.durationSeconds,
      manifest.durationToleranceSeconds,
      'container duration',
    );
    near(
      probe.format?.start_time ?? '0',
      0,
      manifest.startTimeToleranceSeconds,
      'container start',
    );
    for (const stream of streams) {
      near(
        stream.duration ?? probe.format?.duration,
        fixture.durationSeconds,
        manifest.durationToleranceSeconds,
        `${stream.codec_type} duration`,
      );
      near(
        stream.start_time ?? '0',
        0,
        manifest.startTimeToleranceSeconds,
        `${stream.codec_type} start`,
      );
    }
  }
}
