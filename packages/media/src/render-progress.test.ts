import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { renderProgress, withExportProgress } from './render-progress.js';

describe('structured FFmpeg progress', () => {
  it('keeps reporting the active stage through quiet work and stops after failure', async () => {
    const report = vi.fn();
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const attempt = withExportProgress(report, async (tracked) => {
        await withExportProgress(tracked, async (nested) => {
          const stage = renderProgress(120, nested, {
            stage: 'composition',
            indeterminate: true,
          });
          stage.start();
          now = 5000;
          vi.advanceTimersByTime(5000);
          now = 10000;
          vi.advanceTimersByTime(5000);
          stage.update(60);
          throw new Error('cancelled');
        });
      });
      await expect(attempt).rejects.toThrow('cancelled');
      expect(
        report.mock.calls.map(([event]) => [
          event.stage,
          event.exportElapsedSeconds,
          event.idleSeconds,
          event.heartbeat,
        ]),
      ).toEqual([
        ['preparation', 0, 0, undefined],
        ['composition', 0, 0, undefined],
        ['composition', 5, 5, true],
        ['composition', 10, 10, true],
        ['composition', 10, 0, undefined],
      ]);
      expect(report.mock.calls[2]?.[0]).toMatchObject({
        remainingSeconds: null,
      });
      now = 20000;
      vi.advanceTimersByTime(10000);
      expect(report).toHaveBeenCalledTimes(5);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

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
