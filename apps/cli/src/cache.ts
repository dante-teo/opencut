import { parseArgs } from 'node:util';
import {
  MediaCache,
  RenderCancelledError,
  validateCacheLimits,
} from '@opencut/media';
import { UsageError } from './timeline.js';

export const cacheHelp = `Usage: opencut cache status|cleanup|clear [--directory <cache-dir>] [--json]
       opencut cache configure --disk-mib <n> --memory-mib <n> [--directory <cache-dir>] [--json]
       opencut cache proxy <source> [--regenerate] [--directory <cache-dir>] [--json]
       opencut cache frame <source> --timestamp <seconds> [--directory <cache-dir>] [--json]

Proxies are disposable preview derivatives. Exports always read original sources.
Proxy progress streams JSONL with --json; SIGINT/SIGTERM cancel with exit 130/143.
Frame returns a bounded PNG data URL. Clear/cleanup affect only owned cache entries.
Defaults: ~/.cache/opencut/media-v1 (or OPENCUT_MEDIA_CACHE), 2048 MiB disk, 64 MiB PNG memory.
`;
export async function runCacheCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      directory: { type: 'string' },
      'disk-mib': { type: 'string' },
      'memory-mib': { type: 'string' },
      timestamp: { type: 'string' },
      regenerate: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(values.json ? JSON.stringify({ help: cacheHelp }) : cacheHelp);
    return;
  }
  const [command, source] = positionals;
  if (
    !command ||
    !['status', 'cleanup', 'clear', 'configure', 'proxy', 'frame'].includes(
      command,
    ) ||
    positionals.length !== (['proxy', 'frame'].includes(command) ? 2 : 1)
  )
    throw new UsageError(cacheHelp);
  for (const [option, applicable] of [
    ['regenerate', command === 'proxy'],
    ['timestamp', command === 'frame'],
    ['disk-mib', command === 'configure'],
    ['memory-mib', command === 'configure'],
  ] as const)
    if (values[option] !== undefined && !applicable)
      throw new UsageError(`--${option} does not apply to cache ${command}.`);
  if (
    command === 'frame' &&
    (!values.timestamp ||
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(values.timestamp) ||
      !Number.isFinite(Number(values.timestamp)))
  )
    throw new UsageError(
      'cache frame requires --timestamp <nonnegative decimal seconds>.',
    );
  const limits = {
    diskBytes: Number(values['disk-mib']) * 1024 ** 2,
    memoryBytes: Number(values['memory-mib']) * 1024 ** 2,
  };
  if (command === 'configure') {
    try {
      validateCacheLimits(limits);
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const cache = new MediaCache(values.directory);
  const controller = new AbortController();
  let exit = 0;
  const interrupt = () => {
    exit = 130;
    controller.abort();
  };
  const terminate = () => {
    exit = 143;
    controller.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    let result: unknown;
    if (command === 'configure') result = await cache.configure(limits);
    else if (command === 'proxy')
      result = await cache.generateProxy(source!, {
        signal: controller.signal,
        force: !!values.regenerate,
        onProgress: (progress) => {
          if (values.json) console.log(JSON.stringify(progress));
          else
            process.stderr.write(
              `\rProxy ${progress.phase} ${progress.percent.toFixed(1)}%`,
            );
        },
      });
    else if (command === 'frame')
      result = {
        dataURL: `data:image/png;base64,${(await cache.frame(source!, Number(values.timestamp), controller.signal)).toString('base64')}`,
      };
    else result = await cache[command as 'status' | 'cleanup' | 'clear']();
    console.log(
      JSON.stringify(
        { event: 'result', result },
        null,
        values.json ? undefined : 2,
      ),
    );
  } catch (error) {
    if (error instanceof RenderCancelledError || controller.signal.aborted)
      process.exitCode = exit || 130;
    else throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
