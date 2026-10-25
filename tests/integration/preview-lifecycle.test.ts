import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  benchmarkPreview,
  seekPresented,
} from '../../apps/desktop/src/renderer/preview.js';

// Only the video APIs needed to drive completion/failure, without a DOM or codecs.
class PreviewVideo extends EventTarget {
  duration = 2;
  playbackRate = 1;
  paused = true;
  seekError: Error | null = null;
  playError: Error | null = null;
  presentOnSeek = true;
  private time = 0;
  private nextCallback = 0;
  private callbacks = new Map<number, VideoFrameRequestCallback>();

  get pendingFrameCallbacks() {
    return this.callbacks.size;
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(target: number) {
    if (this.seekError) throw this.seekError;
    this.time = target;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('seeked'));
      if (!this.presentOnSeek) return;
      const callbacks = [...this.callbacks.values()];
      this.callbacks.clear();
      for (const callback of callbacks)
        callback(performance.now(), {
          mediaTime: target,
        } as VideoFrameCallbackMetadata);
    });
  }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    const id = ++this.nextCallback;
    this.callbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number) {
    this.callbacks.delete(id);
  }
  pause() {
    this.paused = true;
  }
  async play() {
    if (this.playError) throw this.playError;
    this.paused = false;
  }
  getVideoPlaybackQuality() {
    return {
      totalVideoFrames: 0,
      droppedVideoFrames: 0,
    } as VideoPlaybackQuality;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('preview failure cleanup', () => {
  it('aborts an in-flight seek immediately and removes callbacks and timeout', async () => {
    vi.useFakeTimers();
    const video = new PreviewVideo();
    video.presentOnSeek = false;
    const controller = new AbortController();
    const pending = seekPresented(
      video as unknown as HTMLVideoElement,
      1,
      controller.signal,
    );
    const result = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await result;
    expect(video.pendingFrameCallbacks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a benchmark during playback without leaving its observers or timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const controller = new AbortController();
    const video = new PreviewVideo();
    const playing = vi.spyOn(video, 'play');
    const pending = benchmarkPreview(
      video as unknown as HTMLVideoElement,
      30,
      async () => ({ cpuPercent: 0, workingSetMiB: 0, processCount: 1 }),
      controller.signal,
    );
    const result = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() => expect(playing).toHaveBeenCalled());
    controller.abort();
    await result;
    expect(video.paused).toBe(true);
    expect(video.pendingFrameCallbacks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases the frame callback and timer if setting the seek position throws', async () => {
    vi.useFakeTimers();
    const video = new PreviewVideo();
    video.seekError = new Error('Seek rejected');
    await expect(
      seekPresented(video as unknown as HTMLVideoElement, 1),
    ).rejects.toThrow('Seek rejected');
    expect(video.pendingFrameCallbacks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a pending callback when a seek never presents a frame', async () => {
    vi.useFakeTimers();
    const video = new PreviewVideo();
    video.presentOnSeek = false;
    const result = expect(
      seekPresented(video as unknown as HTMLVideoElement, 1),
    ).rejects.toThrow('No presented frame within 5 seconds');
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(video.pendingFrameCallbacks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['metrics', 'play'] as const)(
    'stops observing frames if benchmark %s initialization fails',
    async (failure) => {
      vi.stubGlobal('document', { visibilityState: 'visible' });
      const video = new PreviewVideo();
      const error = new Error('Initialization failed');
      if (failure === 'play') video.playError = error;
      const metrics = async () => {
        if (failure === 'metrics') throw error;
        return { cpuPercent: 0, workingSetMiB: 0, processCount: 1 };
      };
      await expect(
        benchmarkPreview(video as unknown as HTMLVideoElement, 30, metrics),
      ).rejects.toThrow('Initialization failed');
      expect(video.paused).toBe(true);
      expect(video.pendingFrameCallbacks).toBe(0);
    },
  );
});
