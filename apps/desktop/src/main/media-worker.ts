import { parentPort } from 'node:worker_threads';
import {
  MediaCache,
  ThumbnailCache,
  rasterizeTextLayer,
  type CacheLimits,
  type ProxyResult,
  type RenderProgress,
} from '@opencut/media';
import type { TextLayer, VisualTransform } from '@opencut/shared';

const cache = new MediaCache();
const thumbnails = new ThumbnailCache();
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
const requests = new Map<
  number,
  {
    controller: AbortController;
    work: Promise<unknown>;
    text?: 'preview' | 'export';
  }
>();
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
async function cancel(invalidate = false, includeAll = false) {
  generation++;
  for (const [path, job] of jobs) {
    job.controller.abort();
    if (invalidate && ['queued', 'generating'].includes(job.state))
      jobs.delete(path);
  }
  const pending = [...requests.values()].filter(
    ({ text }) => includeAll || !text || (invalidate && text === 'preview'),
  );
  for (const { controller } of pending) controller.abort();
  await Promise.allSettled([queue, ...pending.map(({ work }) => work)]);
}
parentPort!.on(
  'message',
  (request: {
    id: number;
    method: string;
    path?: string;
    auto?: boolean;
    timestamp?: number;
    hardware?: boolean;
    count?: number;
    interval?: number;
    limits?: CacheLimits;
    width?: number;
    height?: number;
    text?: TextLayer;
    visual?: VisualTransform;
  }) => {
    if (request.method === 'abort') {
      requests.get(request.id)?.controller.abort();
      return;
    }
    void (async () => {
      let value: unknown;
      if (shuttingDown) throw new Error('Media worker is closing.');
      if (request.method === 'shutdown') {
        shuttingDown = true;
        await cancel(false, true);
        value = null;
      } else if (request.method === 'select') {
        let result: ProxyResult;
        const selectionGeneration = generation;
        const controller = new AbortController();
        try {
          if (enabled) {
            const work = cache.select(request.path!, controller.signal);
            requests.set(request.id, { controller, work });
            result = await work;
          } else result = { path: request.path!, key: '', proxy: false };
        } catch {
          result = { path: request.path!, key: '', proxy: false };
        } finally {
          requests.delete(request.id);
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
        thumbnails.clear();
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
      } else if (
        request.method === 'text' ||
        request.method === 'export-text'
      ) {
        const controller = new AbortController();
        const forExport = request.method === 'export-text';
        const work = rasterizeTextLayer(
          request.width!,
          request.height!,
          request.text!,
          request.visual!,
          controller.signal,
        );
        requests.set(request.id, {
          controller,
          work,
          text: forExport ? 'export' : 'preview',
        });
        try {
          const { png, ...raster } = await work;
          value = forExport
            ? { ...raster, png }
            : {
                ...raster,
                url: png
                  ? 'data:image/png;base64,' + png.toString('base64')
                  : null,
              };
        } finally {
          requests.delete(request.id);
        }
      } else if (['thumbnail', 'waveform', 'frame'].includes(request.method)) {
        const controller = new AbortController();
        const path = request.path!;
        const timestamp = request.timestamp!;
        const { signal } = controller;
        let work: Promise<Buffer | null>;
        if (request.method === 'thumbnail') {
          work = thumbnails
            .get(path, timestamp, {
              hardware: request.hardware ?? false,
              adaptive: true,
              count: request.count ?? 1,
              interval: request.interval ?? 0,
              signal,
            })
            .then((result) => result.bytes);
        } else {
          work =
            request.method === 'waveform'
              ? cache.waveform(path, timestamp, signal)
              : cache.frame(path, timestamp, signal);
        }
        requests.set(request.id, { controller, work });
        try {
          const bytes = await work;
          const format = request.method === 'thumbnail' ? 'jpeg' : 'png';
          value =
            request.method === 'waveform'
              ? (bytes ?? new Uint8Array())
              : `data:image/${format};base64,${bytes!.toString('base64')}`;
        } finally {
          requests.delete(request.id);
        }
      } else throw new Error('Unknown media worker method.');
      parentPort!.postMessage({ id: request.id, value });
    })().catch((error: unknown) =>
      parentPort!.postMessage({ id: request.id, error: String(error) }),
    );
  },
);
