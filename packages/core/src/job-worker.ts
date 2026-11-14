import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  reconcileAttempt,
  outputIdentity,
  syncDirectory,
} from './job-publication.js';
import { resourceMeter } from './job-resources.js';
import { renderJob } from './job-render.js';
import { JobStore, jobPaths, privateDirectory, tryLease } from './job-store.js';
import { JobError, type JobFailure } from './job-contract.js';
import {
  launchWorker,
  spawnJobProcess,
  workerLeasePath,
} from './job-launcher.js';

const period = 200;
const grace = 1500;

async function worker(directory: string) {
  const release = tryLease(workerLeasePath(directory));
  if (!release) return;
  const store = new JobStore(directory);
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  let idleSince = Date.now();
  const stop = () => {
    stopping = true;
    for (const child of children.values())
      if (child.connected) child.disconnect();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    for (;;) {
      for (const job of store.list('running')) {
        if (!children.has(job.id)) reconcileAttempt(store, job);
      }
      for (const job of stopping ? [] : store.claim(process.pid)) {
        const child = spawnJobProcess(directory, 'guardian', job);
        children.set(job.id, child);
        // A disconnected IPC channel can outlive the child process.
        child.once('exit', () => children.delete(job.id));
        child.on('error', () => {
          if (child.pid === undefined) children.delete(job.id);
        });
      }
      if (children.size || store.count('running')) idleSince = Date.now();
      else if (stopping || Date.now() - idleSince > 5000) {
        // A submitter that saw our lease needs a successor if we leave its job queued.
        const exit = store.transaction(() => {
          const queued = store.count('queued') > 0;
          if (queued && !stopping) return 'stay';
          release();
          return queued ? 'handoff' : 'exit';
        });
        if (exit === 'handoff') await launchWorker(directory);
        if (exit !== 'stay') return;
      }
      await delay(period);
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    stop();
    store.close();
    // The exit transaction may already have released the lease.
    release();
  }
}

async function guardian(directory: string, id: string, attempt: number) {
  if (!process.connected) return;
  const paths = jobPaths(directory, id, attempt);
  privateDirectory(paths.root);
  const release = tryLease(paths.guardianLease);
  if (!release) return;
  const store = new JobStore(directory);
  let termination: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  const abort = () => {
    if (termination) return;
    process.kill(0, 'SIGTERM');
    termination = delay(grace).then(() => {
      process.kill(0, 'SIGKILL');
    });
  };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  process.once('disconnect', abort);
  try {
    const status = store.status(id);
    if (
      status.state !== 'running' ||
      status.attempt !== attempt ||
      status.cancelRequested ||
      !process.connected
    )
      return;
    await mkdir(paths.scratch, { mode: 0o700 });
    if (termination) return;
    syncDirectory(directory);
    syncDirectory(paths.root);
    const limits = store.limits();
    const sample = resourceMeter(process.pid, paths.scratch, limits);
    let closed = false;
    child = spawnJobProcess(directory, 'runner', { id, attempt });
    child.on('error', () => {
      /* A failed spawn also emits close. */
    });
    child.once('close', (code) => {
      closed = true;
      if (code !== 0) abort();
    });
    for (;;) {
      const stopRequested = store.status(id).cancelRequested;
      if (termination || stopRequested) {
        abort();
        break;
      }
      // A sample started before the runner exits can miss the verified MP4.
      const finalSample = closed;
      const { resources, error } = await sample();
      if (termination) break;
      store.recordResources(id, resources, error);
      if (error) {
        abort();
        break;
      }
      if (finalSample) return;
      if (!closed) await delay(period);
    }
  } catch (error) {
    if (!termination) {
      if (child) abort();
      store.recordExecutionFailure(id, {
        code: 'WORKER_SETUP_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  } finally {
    // Keep the lease and stay in the process group until escalation runs.
    await termination;
    process.removeListener('disconnect', abort);
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    store.close();
    release();
    if (process.connected) process.disconnect?.();
  }
}

function renderFailure(error: unknown): JobFailure {
  if (error instanceof JobError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  const message = error instanceof Error ? error.message : String(error);
  if (
    /unknown encoder|encoder .* not found|encoder .* unavailable/i.test(message)
  )
    return { code: 'UNSUPPORTED_ENCODER', message, retryable: false };
  if (
    /timed out|no space left on device|resource temporarily unavailable/i.test(
      message,
    )
  )
    return { code: 'RENDER_TRANSIENT', message, retryable: true };
  return { code: 'RENDER_FAILED', message, retryable: false };
}

async function runner(directory: string, id: string, attempt: number) {
  // Only signal a group while a member ourselves. If the guardian is killed,
  // the live IPC endpoint closes and we can still safely terminate its group.
  const lostGuardian = () => process.kill(0, 'SIGKILL');
  if (!process.connected) {
    lostGuardian();
    return;
  }
  process.once('disconnect', lostGuardian);
  const paths = jobPaths(directory, id, attempt);
  const release = tryLease(paths.runnerLease);
  if (!release) throw new Error('Render attempt lease already held.');
  const store = new JobStore(directory);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    const status = store.status(id);
    if (
      status.state !== 'running' ||
      status.attempt !== attempt ||
      status.cancelRequested
    )
      return;
    const result = await renderJob(
      status.inputs,
      store.snapshot(id),
      paths.staged,
      controller.signal,
      (progress) => store.recordProgress(id, progress),
    );
    const identity = outputIdentity(paths.staged);
    if (!identity || identity === 'non-regular')
      throw new Error('Verified output is missing.');
    syncDirectory(paths.scratch);
    if (controller.signal.aborted) return;
    store.recordVerified(id, {
      identity,
      result: {
        ...result,
        path: paths.output,
        metadata: { ...result.metadata, path: paths.output },
      },
    });
  } catch (error) {
    if (!controller.signal.aborted)
      store.recordExecutionFailure(id, renderFailure(error));
  } finally {
    release();
    store.close();
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    process.off('disconnect', lostGuardian);
    if (process.connected) process.disconnect?.();
  }
}

// A fixed internal executable protocol. No commands or executable arguments
// come from public job specifications.
const [role, directory, id, attempt] = process.argv.slice(2);
if (!directory) throw new Error('Missing job directory.');
switch (role) {
  case 'worker':
    await worker(directory);
    break;
  case 'guardian':
    if (!process.send) throw new Error('Missing worker IPC channel.');
    await guardian(directory, id!, Number(attempt));
    break;
  case 'runner':
    if (!process.send) throw new Error('Missing supervisor IPC channel.');
    await runner(directory, id!, Number(attempt));
    break;
  default:
    throw new Error('Unknown job worker role.');
}
