import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isErrno } from './job-store.js';
import {
  type JobFailure,
  type JobLimits,
  type JobResources,
} from './job-contract.js';

const exec = promisify(execFile);
const MiB = 1024 * 1024;

function scratchBytes(path: string, seen: Set<string>): number {
  try {
    const info = lstatSync(path, { bigint: true });
    if (info.isDirectory())
      return readdirSync(path).reduce(
        (total, name) => total + scratchBytes(join(path, name), seen),
        0,
      );
    if (info.isFile()) {
      const identity = `${info.dev}:${info.ino}`;
      if (seen.has(identity)) return 0;
      seen.add(identity);
    }
    return Math.max(Number(info.size), Number(info.blocks) * 512);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0;
    throw error;
  }
}

export function sampleScratch(path: string, limits: JobLimits) {
  const bytes = scratchBytes(path, new Set());
  const { bavail, bsize } = statfsSync(path);
  let error: JobFailure | undefined;
  if (bavail * bsize < 64 * MiB)
    error = {
      code: 'DISK_SPACE_LOW',
      message: 'Scratch filesystem has less than 64 MiB available.',
      retryable: true,
    };
  else if (bytes > Math.floor((limits.scratchMiB * MiB) / limits.concurrency))
    error = {
      code: 'SCRATCH_BUDGET_EXCEEDED',
      message: 'Attempt exceeded its share of the scratch budget.',
      retryable: true,
    };
  return { bytes, error };
}

function cpuSeconds(time: string) {
  return time
    .split(/[-:]/)
    .reduceRight(
      (sum, part, index, parts) =>
        sum +
        Number(part) * ([1, 60, 3600, 86400][parts.length - 1 - index] ?? 0),
      0,
    );
}

export function resourceMeter(
  group: number,
  scratch: string,
  limits: JobLimits,
) {
  const cpu = new Map<number, number>();
  const peak: JobResources = { cpuSeconds: 0, memoryBytes: 0, scratchBytes: 0 };
  return async () => {
    const { stdout } = await exec(
      '/bin/ps',
      ['-axo', 'pid=,pgid=,rss=,time='],
      {
        timeout: 1500,
        maxBuffer: 8 * MiB,
      },
    );
    const { bytes, error: diskError } = sampleScratch(scratch, limits);
    let totalMemory = 0;
    let found = false;
    for (const line of stdout.trim().split('\n')) {
      const [pid, pgid, rss, time] = line.trim().split(/\s+/);
      if (Number(pgid) !== group || !time || !Number.isFinite(Number(rss)))
        continue;
      found = true;
      const seconds = cpuSeconds(time);
      if (!Number.isFinite(seconds))
        throw new Error('Unexpected process CPU accounting format.');
      cpu.set(Number(pid), Math.max(cpu.get(Number(pid)) ?? 0, seconds));
      totalMemory += Number(rss) * 1024;
    }
    if (!found)
      throw new Error(
        'Worker process group is missing from process accounting.',
      );
    peak.cpuSeconds = [...cpu.values()].reduce(
      (sum, seconds) => sum + seconds,
      0,
    );
    peak.memoryBytes = Math.max(peak.memoryBytes, totalMemory);
    peak.scratchBytes = Math.max(peak.scratchBytes, bytes);
    if (diskError) return { resources: { ...peak }, error: diskError };

    let error: JobFailure | undefined;
    if (totalMemory > Math.floor((limits.memoryMiB * MiB) / limits.concurrency))
      error = {
        code: 'MEMORY_BUDGET_EXCEEDED',
        message: 'Attempt exceeded its share of the resident-memory budget.',
        retryable: true,
      };
    else if (peak.cpuSeconds > limits.cpuSecondsPerJob)
      error = {
        code: 'CPU_BUDGET_EXCEEDED',
        message: 'Attempt exceeded its CPU-time budget.',
        retryable: true,
      };
    return { resources: { ...peak }, error };
  };
}
