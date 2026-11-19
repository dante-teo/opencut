import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import { MediaError } from './process.js';
import { sampleProcessMemory } from './process-memory.js';
import { hostRenderResources, sampleMemoryPressure } from './host-resources.js';

interface RenderBudget {
  remainingBytes: number | undefined;
  maxNativeBytes: number;
  children: Map<number, (error: Error) => void>;
  samplerFailure?: MediaError;
}

const storage = new AsyncLocalStorage<RenderBudget>();

/** Each batch slot has its own share of the temporary disk and native budget. */
export async function withRenderBudget<T>(
  limits: { maxTemporaryBytes?: number; maxNativeBytes: number },
  render: () => Promise<T>,
) {
  const children = new Map<number, (error: Error) => void>();
  const budget: RenderBudget = {
    remainingBytes: limits.maxTemporaryBytes,
    maxNativeBytes: limits.maxNativeBytes,
    children,
  };
  let sampling = false;
  const monitor = setInterval(() => {
    if (sampling || budget.samplerFailure || !children.size) return;
    sampling = true;
    const active = [...children];
    sampleProcessMemory(
      { pids: active.map(([pid]) => pid) },
      (error, bytes) => {
        sampling = false;
        if (error) {
          budget.samplerFailure = error;
          for (const stop of children.values()) stop(error);
          return;
        }
        if (bytes > limits.maxNativeBytes)
          for (const [pid, stop] of active)
            if (children.has(pid))
              stop(new MediaError('Render exceeded its native memory budget.'));
      },
    );
  }, 50);
  try {
    return await storage.run(budget, render);
  } finally {
    clearInterval(monitor);
  }
}

export async function withDefaultRenderBudget<T>(
  signal: AbortSignal | undefined,
  render: () => Promise<T>,
) {
  if (storage.getStore() || !['darwin', 'linux'].includes(process.platform))
    return render();
  const pressure = await sampleMemoryPressure(signal);
  if (pressure === 'critical')
    throw new MediaError(
      'System memory pressure is critical. Free memory and retry rendering.',
    );
  const { nativeBudgetBytes } = hostRenderResources();
  return withRenderBudget(
    {
      maxNativeBytes:
        pressure === 'warning'
          ? Math.floor(nativeBudgetBytes / 2)
          : nativeBudgetBytes,
    },
    render,
  );
}

export function accountRenderBytes(bytes: number) {
  const budget = storage.getStore();
  if (budget?.remainingBytes === undefined) return;
  if (bytes > budget.remainingBytes)
    throw new MediaError('Render exceeded its temporary disk budget.');
  budget.remainingBytes -= bytes;
}

export async function accountRenderFile(file: string) {
  if (storage.getStore()?.remainingBytes !== undefined)
    accountRenderBytes((await stat(file)).size);
}

export function trackRenderProcess(
  pid: number | undefined,
  stop: (error: Error) => void,
) {
  const children = storage.getStore()?.children;
  if (pid === undefined || !children) return () => {};
  children.set(pid, stop);
  return () => children.delete(pid);
}

/** Bound individual writes at the OS level before charging the finished file. */
export function renderToolCommand(
  tool: string,
  args: string[],
  writesFile = false,
) {
  const budget = storage.getStore();
  if (!budget) return { tool, args };
  if (budget.samplerFailure) throw budget.samplerFailure;
  const bounded =
    tool === 'ffmpeg' || tool === 'ffprobe'
      ? [
          '-max_alloc',
          String(Math.min(budget.maxNativeBytes, 2_147_483_647)),
          ...args,
        ]
      : args;
  if (!writesFile || budget.remainingBytes === undefined)
    return { tool, args: bounded };
  if (budget.remainingBytes < 1024)
    throw new MediaError(
      'Render has less than 1024 bytes of temporary disk budget remaining.',
    );
  return {
    tool: '/bin/bash',
    args: [
      '-c',
      'ulimit -f "$1" || exit 125; shift; exec "$@"',
      'opencut-render',
      String(Math.floor(budget.remainingBytes / 1024)),
      tool,
      ...bounded,
    ],
  };
}
