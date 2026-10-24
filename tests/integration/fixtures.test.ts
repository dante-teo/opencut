import { describe, expect, it } from 'vitest';
import {
  fixtures,
  requireTool,
  runTool,
  validateProbe,
} from '../../scripts/fixture-lib.js';
import type { Probe } from '../../scripts/fixture-lib.js';

const medium = fixtures.find((fixture) => fixture.file === 'video-medium.mp4');
if (!medium) throw new Error('Missing medium fixture.');
const valid: Probe = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 640,
      height: 360,
      avg_frame_rate: '30/1',
      nb_frames: '90',
      nb_read_frames: '90',
      duration: '3.0',
      start_time: '0',
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 1,
      duration: '3.0',
      start_time: '0',
    },
  ],
  format: { duration: '3.0', start_time: '0' },
};

describe('fixture metadata contract (no native tools required)', () => {
  it('accepts expected metadata and AAC duration rounding', () => {
    const probe = structuredClone(valid);
    probe.format = { duration: '3.02' };
    expect(() => validateProbe(medium, probe)).not.toThrow();
  });
  it('rejects missing audio', () => {
    expect(() =>
      validateProbe(medium, {
        ...valid,
        streams: valid.streams?.slice(0, 1) ?? [],
      }),
    ).toThrow('stream count');
  });
  it('rejects wrong resolution', () => {
    const probe = structuredClone(valid);
    probe.streams![0]!.width = 1280;
    expect(() => validateProbe(medium, probe)).toThrow('resolution');
  });
  it('rejects the wrong frame rate', () => {
    const probe = structuredClone(valid);
    probe.streams![0]!.avg_frame_rate = '24/1';
    expect(() => validateProbe(medium, probe)).toThrow('frame rate');
  });
  it('rejects missing frames', () => {
    const probe = structuredClone(valid);
    probe.streams![0]!.nb_read_frames = '89';
    expect(() => validateProbe(medium, probe)).toThrow('frame count');
  });
  it('rejects missing readable-frame counts even when headers claim all frames exist', () => {
    const probe = structuredClone(valid);
    delete probe.streams![0]!.nb_read_frames;
    expect(() => validateProbe(medium, probe)).toThrow('frame count');
  });
  it('rejects incorrect container durations', () => {
    expect(() =>
      validateProbe(medium, { ...valid, format: { duration: '2.4' } }),
    ).toThrow('duration');
  });
  it.each(['0.2', '', '   '])(
    'rejects invalid audio timestamps %j',
    (start) => {
      const probe = structuredClone(valid);
      probe.streams![1]!.start_time = start;
      expect(() => validateProbe(medium, probe)).toThrow('audio start');
    },
  );
  it('rejects wrong sample rate', () => {
    const probe = structuredClone(valid);
    probe.streams![1]!.sample_rate = '44100';
    expect(() => validateProbe(medium, probe)).toThrow('sample rate');
  });
  it('rejects decoder errors even when the tool exits successfully', () => {
    expect(() =>
      runTool(process.execPath, [
        '-e',
        "process.stderr.write('decode failed')",
      ]),
    ).toThrow('decode failed');
  });
  it('explains missing optional prerequisites without downloading anything', () => {
    expect(() => requireTool('opencut-nonexistent-fixture-tool')).toThrow(
      'Install it manually',
    );
  });
});
