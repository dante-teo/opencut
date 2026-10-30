import { parentPort } from 'node:worker_threads';
import {
  MediaCache,
  type CacheLimits,
  type ProxyResult,
  type RenderProgress,
} from '@opencut/media';

const cache = new MediaCache();
interface ProxyJob {
  state:
    'queued' | 'generating' | 'ready' | 'original' | 'failed' | 'cancelled';
  progress: RenderProgress | null;
  error: string;
  controller: AbortController;
}
const jobs = new Map<string, ProxyJob>();
let queue = Promise.resolve();
let enabled = true;
let revision = 0;
let shuttingDown = false;
const requests = new Map<AbortController, Promise<unknown>>();
let generation = 0;
function start(path: string, force = false) {
  const previous = jobs.get(path);
  if (previous && !force) return true;
  if (previous && ['queued', 'generating'].includes(previous.state))
    return true;
  if (
    [...jobs.values()].filter((j) => ['queued', 'generating'].includes(j.state))
      .length >= 16
  )
    return false;
  if (jobs.size >= 64) {
    for (const [key, job] of jobs)
      if (!['queued', 'generating'].includes(job.state)) {
        jobs.delete(key);
        break;
      }
  }
  const job: ProxyJob = {
    state: 'queued',
    progress: null,
    error: '',
    controller: new AbortController(),
  };
  jobs.set(path, job);
  const work = queue.then(async () => {
    if (job.controller.signal.aborted) {
      job.state = 'cancelled';
      return;
    }
    job.state = 'generating';
    try {
      const result = await cache.generateProxy(path, {
        signal: job.controller.signal,
        force,
        onProgress: (progress) => {
          job.progress = progress;
        },
      });
      job.state = result.proxy ? 'ready' : 'original';
      if (result.proxy) revision++;
      job.error = result.reason ?? '';
    } catch (error) {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = String(error);
    }
  });
  queue = work.catch(() => {});
  return true;
}
async function cancel(invalidate = false) {
  generation++;
  for (const [path, job] of jobs) {
    job.controller.abort();
    if (invalidate && ['queued', 'generating'].includes(job.state))
      jobs.delete(path);
  }
  for (const controller of requests.keys()) controller.abort();
  await Promise.allSettled([queue, ...requests.values()]);
}
parentPort!.on(
  'message',
  (request: {
    id: number;
    method: string;
    path?: string;
    auto?: boolean;
    timestamp?: number;
    limits?: CacheLimits;
  }) => {
    void (async () => {
      let value: unknown;
      if (shuttingDown) throw new Error('Media worker is closing.');
      if (request.method === 'shutdown') {
        shuttingDown = true;
        await cancel();
        value = null;
      } else if (request.method === 'select') {
        let result: ProxyResult;
        const selectionGeneration = generation;
        const controller = new AbortController();
        try {
          if (enabled) {
            const work = cache.select(request.path!, controller.signal);
            requests.set(controller, work);
            result = await work;
          } else result = { path: request.path!, key: '', proxy: false };
        } catch {
          result = { path: request.path!, key: '', proxy: false };
        } finally {
          requests.delete(controller);
        }
        if (
          selectionGeneration === generation &&
          enabled &&
          !result.proxy &&
          request.auto
        ) {
          // A ready entry may have been evicted or corrupted. Retry rather than trust job history.
          if (jobs.get(request.path!)?.state === 'ready')
            jobs.delete(request.path!);
          start(request.path!);
        }
        value = result;
      } else if (request.method === 'status')
        value = {
          ...(await cache.status()),
          enabled,
          revision,
          jobs: [...jobs].map(([path, job]) => ({
            name: path.split(/[\\/]/).at(-1),
            state: job.state,
            progress: job.progress,
            error: job.error,
          })),
        };
      else if (request.method === 'generate') {
        if (!start(request.path!, true))
          throw new Error(
            'Proxy job queue is full (16). Retry after pending jobs finish.',
          );
        value = null;
      } else if (
        request.method === 'cancel' ||
        request.method === 'invalidate'
      ) {
        await cancel(request.method === 'invalidate');
        value = null;
      } else if (request.method === 'clear') {
        await cancel();
        jobs.clear();
        value = await cache.clear();
      } else if (request.method === 'cleanup') {
        await cancel();
        value = await cache.cleanup();
      } else if (request.method === 'configure') {
        await cancel();
        value = await cache.configure(request.limits!);
      } else if (request.method === 'enable') {
        enabled = request.auto!;
        value = null;
      } else if (request.method === 'frame') {
        const controller = new AbortController();
        const work = cache.frame(
          request.path!,
          request.timestamp!,
          controller.signal,
        );
        requests.set(controller, work);
        try {
          value = `data:image/png;base64,${(await work).toString('base64')}`;
        } finally {
          requests.delete(controller);
        }
      } else throw new Error('Unknown media worker method.');
      parentPort!.postMessage({ id: request.id, value });
    })().catch((error: unknown) =>
      parentPort!.postMessage({ id: request.id, error: String(error) }),
    );
  },
);
