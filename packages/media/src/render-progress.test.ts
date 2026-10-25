import { describe, expect, it, vi } from 'vitest';
import { renderProgress } from './render-progress.js';

describe('structured FFmpeg progress', () => {
  it('parses split/coalesced CRLF records, ignores unknown fields and keeps progress monotonic', () => {
    const callback = vi.fn();
    const progress = renderProgress(20, callback);
    progress.start();
    progress.chunk(Buffer.from('fra'));
    progress.chunk(Buffer.from('me=5\r\nfps=30\r\nprogress=cont'));
    expect(callback).toHaveBeenCalledTimes(1);
    progress.chunk(
      Buffer.from(
        'inue\r\nframe=2\nprogress=continue\nframe=N/A\nprogress=continue\n',
      ),
    );
    progress.chunk(
      Buffer.from(
        'frame=99999999999999999999\nprogress=continue\nframe=25\nprogress=end\n',
      ),
    );
    progress.verifying();
    const events = callback.mock.calls.map(([event]) => event);
    expect(events.map((event) => event.processedFrames)).toEqual([
      0, 5, 5, 5, 5, 20, 20,
    ]);
    expect(events[0]).toMatchObject({
      event: 'progress',
      phase: 'rendering',
      percent: 0,
      remainingSeconds: null,
    });
    expect(events[1]).toMatchObject({
      percent: 25,
      totalFrames: 20,
      remainingSeconds: expect.any(Number),
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'verifying',
      percent: 100,
      remainingSeconds: null,
    });
    for (const event of events) {
      expect(event.elapsedSeconds).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });
});
