import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMediaTool } from './process.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const end = vi.fn();

function respond(error: Error | null, stdout = '', stderr = ''): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (
      error: Error | null,
      stdout: Buffer,
      stderr: Buffer,
    ) => void;
    callback(error, Buffer.from(stdout), Buffer.from(stderr));
    return { stdin: { end } } as unknown as ChildProcess;
  });
}

beforeEach(() => vi.resetAllMocks());

describe('media subprocesses', () => {
  it('passes literal arguments with no shell, bounded resources and closed stdin', async () => {
    respond(null, '{}');
    const args = ['-i', "/tmp/-clip $(touch surprise); quote's.mp4"];
    expect(await runMediaTool('ffprobe', args)).toEqual(Buffer.from('{}'));
    expect(execFile).toHaveBeenCalledWith(
      'ffprobe',
      args,
      expect.objectContaining({
        shell: false,
        encoding: 'buffer',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        killSignal: 'SIGKILL',
      }),
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it('explains missing executables', async () => {
    respond(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(runMediaTool('ffmpeg', [])).rejects.toThrow(
      "'ffmpeg' was not found on PATH. Install",
    );
  });

  it.each([
    'permission denied',
    'process killed after timeout',
    'stdout maxBuffer length exceeded',
  ])('reports execution failures: %s', async (message) => {
    respond(new Error(message));
    await expect(runMediaTool('ffprobe', [])).rejects.toThrow(message);
  });

  it.each([null, new Error('exit 1')])(
    'reports decoder diagnostics even on exit zero',
    async (error) => {
      respond(error, '', 'Invalid data found when processing input');
      await expect(runMediaTool('ffprobe', [])).rejects.toThrow(
        'Invalid data found',
      );
    },
  );
});

describe('render subprocess lifecycle', () => {
  function pending() {
    const stdout = new PassThrough();
    const kill = vi.fn();
    let finish!: (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      finish = args[3] as typeof finish;
      return { stdin: { end }, stdout, kill } as unknown as ChildProcess;
    });
    return {
      stdout,
      kill,
      close: (error: Error | null = null, diagnostics = '') =>
        finish(error, Buffer.alloc(0), Buffer.from(diagnostics)),
    };
  }

  it('rejects an already aborted signal without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runMediaTool('ffmpeg', [], undefined, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('streams progress, gracefully stops, escalates and waits for process closure', async () => {
    vi.useFakeTimers();
    try {
      const child = pending();
      const controller = new AbortController();
      const onStdout = vi.fn();
      const promise = runMediaTool('ffmpeg', [], undefined, 600000, {
        signal: controller.signal,
        onStdout,
      });
      let settled = false;
      const caught = promise.catch((error: unknown) => {
        settled = true;
        return error;
      });
      child.stdout.write('frame=1\nprogress=continue\n');
      expect(onStdout).toHaveBeenCalledWith(
        Buffer.from('frame=1\nprogress=continue\n'),
      );
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2000);
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
      expect(settled).toBe(false);
      child.close(new Error('terminated'));
      expect(await caught).toMatchObject({ name: 'RenderCancelledError' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds runtime and retains timeout diagnostics after child closure', async () => {
    vi.useFakeTimers();
    try {
      const child = pending();
      const promise = runMediaTool('ffprobe', [], undefined, 50, {});
      const caught = promise.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.close(new Error('terminated'), 'decoder stalled');
      expect(await caught).toMatchObject({
        message: 'ffprobe timed out after 50 ms: decoder stalled',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the child when a progress consumer throws and removes abort handlers', async () => {
    const child = pending();
    const controller = new AbortController();
    const promise = runMediaTool('ffmpeg', [], undefined, 600000, {
      signal: controller.signal,
      onStdout: () => {
        throw new Error('consumer failure');
      },
    });
    const caught = promise.catch((error: unknown) => error);
    child.stdout.write('frame=1\n');
    expect(child.kill).toHaveBeenCalledOnce();
    child.close();
    expect(await caught).toMatchObject({ message: 'consumer failure' });
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
