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
