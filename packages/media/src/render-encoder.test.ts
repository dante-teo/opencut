import { describe, expect, it, vi } from 'vitest';
import { selectRenderEncoder } from './render-encoder.js';
import { MediaError, runMediaTool } from './process.js';

vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));

const target = {
  codec: 'hevc',
  quality: 'quality',
  width: 2160,
  height: 3840,
  rate: { numerator: 60, denominator: 1 },
} as const;

describe('render encoder selection', () => {
  it('preserves the default and checks the exact hardware configuration only when requested', async () => {
    vi.mocked(runMediaTool).mockReset().mockResolvedValue(Buffer.alloc(0));
    expect((await selectRenderEncoder(undefined, target)).name).toBe('libx265');
    expect(runMediaTool).not.toHaveBeenCalled();
    expect(await selectRenderEncoder('auto', target)).toMatchObject({
      requested: 'auto',
      selected: 'videotoolbox',
      name: 'hevc_videotoolbox',
      settings: { allowSoftware: false, rateControl: { mode: 'bitrate' } },
    });
    expect(vi.mocked(runMediaTool).mock.calls[0]![1]).toEqual(
      expect.arrayContaining([
        'color=s=2160x3840:r=60/1,format=yuv420p',
        'hevc_videotoolbox',
        '-allow_sw',
        '0',
      ]),
    );
  });
  it('reports automatic fallback and refuses an unavailable explicit backend', async () => {
    vi.mocked(runMediaTool)
      .mockReset()
      .mockImplementation(async (_, args) => {
        if (args.includes('hevc_videotoolbox'))
          throw new MediaError('hardware unavailable');
        return Buffer.alloc(0);
      });
    expect(await selectRenderEncoder('auto', target)).toMatchObject({
      requested: 'auto',
      selected: 'software',
      name: 'libx265',
      fallbackReason: expect.stringContaining('hardware unavailable'),
    });
    await expect(selectRenderEncoder('videotoolbox', target)).rejects.toThrow(
      /Use --encoder software/,
    );
    expect(runMediaTool).toHaveBeenCalledTimes(3);
  });
});
