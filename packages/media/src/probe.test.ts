import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeMedia } from './probe.js';
import { runMediaTool } from './process.js';

vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));

const file = fileURLToPath(import.meta.url);
const probe = {
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 640,
      height: 360,
      avg_frame_rate: '30000/1001',
      duration: '3',
      time_base: '1/30000',
      pix_fmt: 'yuv420p',
    },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
      channel_layout: 'stereo',
      duration: '3.02',
      start_time: '-0.02',
      tags: { language: 'eng' },
      disposition: { default: 1 },
    },
  ],
  format: {
    duration: '3.02',
    start_time: '-0.02',
    format_name: 'mov,mp4',
    bit_rate: '10000',
  },
};

function respond(data: unknown): void {
  vi.mocked(runMediaTool).mockResolvedValue(Buffer.from(JSON.stringify(data)));
}

beforeEach(() => vi.resetAllMocks());

describe('media probing', () => {
  it('normalizes metadata and preserves fractional average frame rates', async () => {
    respond(probe);
    const media = await probeMedia(file);
    expect(media).toMatchObject({
      path: file,
      durationSeconds: 3.02,
      hasAudio: true,
      formatName: 'mov,mp4',
      startTimeSeconds: -0.02,
    });
    expect(media.video).toMatchObject({
      index: 0,
      width: 640,
      height: 360,
      codec: 'h264',
      frameRateRatio: '30000/1001',
      pixelFormat: 'yuv420p',
      timeBase: '1/30000',
    });
    expect(media.video?.frameRate).toBeCloseTo(29.97003);
    expect(media.audio).toMatchObject({
      codec: 'aac',
      sampleRate: 48000,
      channels: 2,
      channelLayout: 'stereo',
      language: 'eng',
      startTimeSeconds: -0.02,
    });
    expect(runMediaTool).toHaveBeenCalledWith('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      file,
    ]);
  });

  it('represents absent audio and unknown values explicitly', async () => {
    respond({
      streams: [
        {
          index: 0,
          codec_type: 'video',
          avg_frame_rate: '0/0',
          duration: 'N/A',
          width: 0,
        },
      ],
    });
    const media = await probeMedia(file);
    expect(media).toMatchObject({
      audio: null,
      hasAudio: false,
      durationSeconds: null,
      startTimeSeconds: null,
    });
    expect(media.video).toMatchObject({
      frameRate: null,
      frameRateRatio: null,
      codec: null,
      width: null,
    });
    expect(JSON.stringify(media)).not.toContain('NaN');
  });

  it('handles audio-only files and falls back to stream durations', async () => {
    respond({ streams: [probe.streams[1]] });
    expect(await probeMedia(file)).toMatchObject({
      video: null,
      hasAudio: true,
      durationSeconds: 3.02,
    });
  });

  it('prefers default streams, excludes cover art and retains every stream', async () => {
    respond({
      streams: [
        {
          ...probe.streams[0],
          index: 0,
          disposition: { default: 1, attached_pic: 1 },
        },
        { ...probe.streams[0], index: 2 },
        { ...probe.streams[0], index: 3, disposition: { default: 1 } },
        { index: 4, codec_type: 'subtitle', codec_name: 'subrip' },
      ],
    });
    const media = await probeMedia(file);
    expect(media.video?.index).toBe(3);
    expect(media.streams).toHaveLength(4);
    expect(media.streams[0]?.isAttachedPicture).toBe(true);
  });

  it.each([
    {},
    { streams: [] },
    { streams: [{}] },
    { streams: [{ index: -1, codec_type: 'video' }] },
  ])('rejects unusable metadata %j', async (data) => {
    respond(data);
    await expect(probeMedia(file)).rejects.toThrow(
      /streams|stream information/,
    );
  });

  it('rejects malformed JSON', async () => {
    vi.mocked(runMediaTool).mockResolvedValue(Buffer.from('{'));
    await expect(probeMedia(file)).rejects.toThrow('invalid JSON');
  });

  it('rejects unreadable paths before launching ffprobe', async () => {
    await expect(probeMedia(`${file}.missing`)).rejects.toThrow(
      'Cannot read media',
    );
    await expect(
      probeMedia(new URL('.', import.meta.url).pathname),
    ).rejects.toThrow('Cannot read media');
    expect(runMediaTool).not.toHaveBeenCalled();
  });
});
