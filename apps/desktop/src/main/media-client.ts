import { Worker } from 'node:worker_threads';

/** Main only forwards authorized requests; hashing/cache I/O runs in this worker. */
export class MediaClient {
  private readonly worker = new Worker(
    new URL('./media-worker.js', import.meta.url),
  );
  private next = 0;
  private failed: Error | null = null;
  private readonly pending = new Map<
    number,
    (error: Error | null, value?: unknown) => void
  >();
  constructor() {
    this.worker.unref();
    this.worker.on(
      'message',
      (reply: { id: number; value?: unknown; error?: string }) => {
        const pending = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        pending?.(reply.error ? new Error(reply.error) : null, reply.value);
      },
    );
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) =>
      this.fail(new Error(`Media worker exited (${code}).`)),
    );
  }
  private fail(error: Error) {
    this.failed = error;
    for (const finish of this.pending.values()) finish(error);
    this.pending.clear();
  }
  request<T>(
    method: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    if (signal?.aborted)
      return Promise.reject(new Error('Media request cancelled.'));
    if (this.pending.size >= 128)
      return Promise.reject(new Error('Media worker request limit reached.'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.next;
      const abort = () => this.worker.postMessage({ id, method: 'abort' });
      this.pending.set(id, (error, value) => {
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value as T);
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({ id, method, ...input });
    });
  }
  async close() {
    const closed = this.request('shutdown');
    this.failed = new Error('Media worker is closing.');
    await closed.catch(() => {});
    await this.worker.terminate();
  }
}
