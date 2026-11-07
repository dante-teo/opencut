import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  on: vi.fn(),
  postMessage: vi.fn(),
  select: vi.fn(),
  generateProxy: vi.fn(),
  status: vi.fn(),
  waveform: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  parentPort: { on: mock.on, postMessage: mock.postMessage },
}));
vi.mock('../../packages/media/dist/index.js', () => ({
  ThumbnailCache: class {
    clear = vi.fn();
  },
  MediaCache: class {
    select = mock.select;
    generateProxy = mock.generateProxy;
    status = mock.status;
    waveform = mock.waveform;
  },
}));
let message: (request: Record<string, unknown>) => void;
let next = 0;
const completed: { path: string; finish(): void; signal: AbortSignal }[] = [];
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  completed.length = 0;
  next = 0;
  mock.select.mockImplementation(async (path: string) => ({
    path,
    key: path,
    proxy: false,
  }));
  mock.status.mockResolvedValue({ entries: [] });
  mock.generateProxy.mockImplementation(
    (path: string, { signal }: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        completed.push({
          path,
          signal,
          finish: () => resolve({ path, proxy: true, key: path }),
        });
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        });
      }),
  );
  await import('../../apps/desktop/src/main/media-worker.js');
  message = mock.on.mock.calls[0]![1] as typeof message;
});
async function request(method: string, input: Record<string, unknown> = {}) {
  const id = ++next;
  message({ id, method, ...input });
  await vi.waitFor(() =>
    expect(mock.postMessage.mock.calls.some(([reply]) => reply.id === id)).toBe(
      true,
    ),
  );
  const reply = mock.postMessage.mock.calls.find(
    ([reply]) => reply.id === id,
  )![0];
  if (reply.error) throw new Error(reply.error);
  return reply.value;
}

it('restarts active and queued automatic proxies on a fresh selection after project invalidation', async () => {
  await request('select', { path: '/a.mp4', auto: true });
  await request('select', { path: '/b.mp4', auto: true });
  expect(completed.map((job) => job.path)).toEqual(['/a.mp4']);
  await request('invalidate');
  expect(completed[0]!.signal.aborted).toBe(true);
  await request('select', { path: '/a.mp4', auto: true });
  await vi.waitFor(() => expect(completed).toHaveLength(2));
  completed[1]!.finish();
  await vi.waitFor(async () =>
    expect((await request('status')).jobs[0].state).toBe('ready'),
  );
  await request('select', { path: '/b.mp4', auto: true });
  await vi.waitFor(() => expect(completed).toHaveLength(3));
  completed[2]!.finish();
  await vi.waitFor(async () =>
    expect((await request('status')).revision).toBe(2),
  );
});

it('preserves deliberate user cancellation across selections and edits until explicit regeneration', async () => {
  await request('select', { path: '/a.mp4', auto: true });
  await request('cancel');
  await request('invalidate');
  await request('select', { path: '/a.mp4', auto: true });
  expect(completed).toHaveLength(1);
  expect((await request('status')).jobs[0].state).toBe('cancelled');
  await request('generate', { path: '/a.mp4' });
  await vi.waitFor(() => expect(completed).toHaveLength(2));
  completed[1]!.finish();
  await vi.waitFor(async () =>
    expect((await request('status')).jobs[0].state).toBe('ready'),
  );
});

it('allows a new selection while invalidated work is still finishing cancellation', async () => {
  await request('select', { path: '/a.mp4', auto: true });
  await Promise.all([
    request('invalidate'),
    request('select', { path: '/a.mp4', auto: true }),
  ]);
  await vi.waitFor(() => expect(completed).toHaveLength(2));
  expect(completed[1]!.signal.aborted).toBe(false);
  completed[1]!.finish();
  await vi.waitFor(async () =>
    expect((await request('status')).jobs[0].state).toBe('ready'),
  );
});

it.each(['invalidate', 'abort'])(
  'cancels an in-flight waveform on %s',
  async (method) => {
    let signal: AbortSignal | undefined;
    mock.waveform.mockImplementation(
      (_path, _start, abort: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = abort;
          abort.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            {
              once: true,
            },
          );
        }),
    );
    const work = request('waveform', {
      path: '/source.wav',
      timestamp: 16,
    });
    const rejected = expect(work).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(signal).toBeDefined());
    if (method === 'invalidate') await request(method);
    else message({ id: next, method });
    await rejected;
    expect(signal!.aborted).toBe(true);
  },
);
