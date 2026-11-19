import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMediaTool } from './process.js';
import { withRenderBudget } from './render-budget.js';

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
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      finish = args[3] as typeof finish;
      return {
        pid: 123,
        stdin: { end },
        stdout,
        kill,
      } as unknown as ChildProcess;
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

  const limits = { maxTemporaryBytes: 4096, maxNativeBytes: 1024 };

  it.each(['EPERM', 'ENOENT'])(
    'stops and waits for the media subprocess when RSS sampling fails with %s',
    async (code) => {
      vi.useFakeTimers();
      try {
        const child = pending();
        const cause = Object.assign(new Error(`spawn sampler ${code}`), {
          code,
        });
        vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
          if (code === 'EPERM') throw cause;
          const callback = args[3] as (
            error: Error,
            output: string,
            diagnostic: string,
          ) => void;
          setImmediate(() => callback(cause, '', ''));
          return {} as ChildProcess;
        });
        const render = withRenderBudget(limits, () =>
          runMediaTool('ffmpeg', []),
        );
        const outcome = render.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        child.close(new Error('terminated'));
        expect(await outcome).toMatchObject({
          name: 'MediaError',
          message: expect.stringContaining(
            process.platform === 'darwin' && code === 'ENOENT'
              ? 'Reinstall OpenCut'
              : 'Cannot sample native memory:',
          ),
          cause,
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['ffmpeg', '/local/deep-filter'])(
    'continues sampling %s when the sampled PID has already exited',
    async (tool) => {
      vi.useFakeTimers();
      try {
        const child = pending();
        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
          const callback = args[3] as (
            error: Error | null,
            output: string,
            diagnostic: string,
          ) => void;
          const exited = vi.mocked(execFile).mock.calls.length === 2;
          if (process.platform === 'darwin')
            callback(null, exited ? '0' : '2048', '');
          else if (exited)
            callback(
              Object.assign(new Error('ps exited'), { code: 1 }),
              '',
              '',
            );
          else callback(null, '2', '');
          return {} as ChildProcess;
        });
        const render = withRenderBudget(limits, () => runMediaTool(tool, []));
        const outcome = render.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(50);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        child.close(new Error('terminated'));
        expect(await outcome).toMatchObject({
          message: 'Render exceeded its native memory budget.',
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('rejects an invalid RSS sample and stops the child', async () => {
    vi.useFakeTimers();
    try {
      const child = pending();
      vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
        const callback = args[3] as (
          error: Error | null,
          output: string,
          diagnostic: string,
        ) => void;
        callback(null, 'invalid', '');
        return {} as ChildProcess;
      });
      const render = withRenderBudget(limits, () => runMediaTool('ffmpeg', []));
      const outcome = render.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.close(new Error('terminated'));
      expect(await outcome).toMatchObject({
        message: 'Cannot sample native memory: Invalid RSS sample.',
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
