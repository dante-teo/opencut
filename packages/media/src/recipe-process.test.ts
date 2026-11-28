import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runRecipeProcess } from './recipe-process.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

describe.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'FFmpeg recipe allocation limit',
  () => {
    const limits = {
      maxTemporaryBytes: 64 * 1024 ** 2,
      maxNativeBytes: 32 * 1024 ** 2,
      maxBufferedFrames: 32,
      maxPixels: 3840 * 2160,
      timeoutMs: 10_000,
    };

    function failBeforeSample(...diagnostics: string[]) {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
      const outcome = runRecipeProcess(
        ['-f', 'null', '-'],
        limits,
        new AbortController().signal,
        vi.fn(),
      );
      for (const diagnostic of diagnostics) child.stderr.write(diagnostic);
      child.emit('close', 244, null);
      return outcome;
    }

    it('reports an oversized packet as a native memory limit before RSS sampling', async () => {
      await expect(
        failBeforeSample(
          '[ffv1 @ 0xca9054700] Failed to allocate packet of size 285',
          '575476\n[enc:ffv1 @ 0xca9080000] Cannot allocate memory\n',
        ),
      ).rejects.toMatchObject({
        message: 'Recipe step exceeded its native memory limit.',
        cause: {
          message: expect.stringContaining(
            'Failed to allocate packet of size 285575476',
          ),
        },
      });
      const args = vi.mocked(spawn).mock.lastCall?.[1];
      const index = args?.indexOf('-max_alloc') ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      expect(args?.[index + 1]).toBe(String(limits.maxNativeBytes));
    });

    it.each([
      '[ffv1 @ 0xca9054700] Failed to allocate packet of size 32000000',
      '[enc:ffv1 @ 0xca9080000] Error encoding a frame: Cannot allocate memory',
    ])(
      'preserves FFmpeg diagnostics when they do not establish a limit failure',
      async (diagnostic) => {
        await expect(failBeforeSample(diagnostic + '\n')).rejects.toThrow(
          `FFmpeg recipe step failed: ${diagnostic}`,
        );
      },
    );
  },
);
