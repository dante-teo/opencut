import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  fsyncSync,
  rmSync,
} from 'node:fs';
import {
  isErrno,
  jobPaths,
  privateDirectory,
  tryLease,
  type JobStore,
} from './job-store.js';
import type { JobFailure, JobStatus } from './job-contract.js';
import { sampleScratch } from './job-resources.js';

export function outputIdentity(path: string) {
  try {
    const info = lstatSync(path, { bigint: true });
    if (!info.isFile()) return 'non-regular';
    // Creating a hard link changes ctime and the link count.
    return [info.dev, info.ino, info.size, info.mtimeNs].join(':');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

export function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const interrupted: JobFailure = {
  code: 'WORKER_INTERRUPTED',
  message:
    'An attempt stopped before producing a verified output. Retry the saved inputs.',
  retryable: true,
};

export function needsReconciliation(status: JobStatus) {
  return (
    status.state === 'running' ||
    status.error?.code === 'PUBLICATION_UNCERTAIN' ||
    status.error?.code === 'RECOVERY_BLOCKED'
  );
}

/** Take both leases before inspecting or deleting an attempt's files. */
export function reconcileAttempt(store: JobStore, job: JobStatus) {
  let releaseGuardian: (() => void) | null | undefined;
  let releaseRunner: (() => void) | null | undefined;
  try {
    store.transaction(() => {
      const status = store.status(job.id);
      if (status.attempt !== job.attempt || !needsReconciliation(status))
        return;

      const paths = jobPaths(store.directory, status.id, status.attempt);
      try {
        privateDirectory(paths.root);
        releaseGuardian = tryLease(paths.guardianLease);
        if (releaseGuardian) releaseRunner = tryLease(paths.runnerLease);
      } catch (error) {
        status.state = 'interrupted';
        status.workerPid = null;
        status.error = {
          code: 'RECOVERY_BLOCKED',
          message: `Cannot access attempt directory or acquire its leases: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        };
        // Keep the receipt and scratch intact until ownership can be checked.
        store.finalize(status, false);
      }
      if (releaseRunner) finishAttempt(store, status);
    });
  } finally {
    releaseRunner?.();
    releaseGuardian?.();
  }
}

/** Resolve publication and the final state in the caller's queue transaction. */
function finishAttempt(store: JobStore, status: JobStatus) {
  const { id, attempt } = status;
  const { prepared, executionError } = store.outcome(id);
  const paths = jobPaths(store.directory, id, attempt);
  status.workerPid = null;
  status.error = null;
  try {
    const published = outputIdentity(paths.output);
    if (prepared && published === prepared.identity) {
      status.state = 'completed';
      status.result = prepared.result;
    } else if (status.cancelRequested) {
      status.state = 'cancelled';
    } else if (executionError) {
      status.state = 'failed';
      status.error = executionError;
    } else if (prepared && outputIdentity(paths.staged) === prepared.identity) {
      // The receipt can survive a crash before the guardian's final sample.
      const { bytes, error } = sampleScratch(paths.scratch, store.limits());
      if (bytes > (status.resources?.scratchBytes ?? 0))
        status.resources = {
          cpuSeconds: 0,
          memoryBytes: 0,
          ...status.resources,
          scratchBytes: bytes,
        };
      if (error) {
        status.state = 'failed';
        status.error = error;
      } else {
        // The exclusive link also refuses an existing unrelated output.
        linkSync(paths.staged, paths.output);
        status.state = 'completed';
        status.result = prepared.result;
      }
    } else if (prepared && published !== null) {
      throw new Error(
        'The existing output cannot be matched to the verification receipt.',
      );
    } else {
      status.state = 'interrupted';
      status.error = prepared
        ? {
            code: 'VERIFIED_OUTPUT_LOST',
            message:
              'The verified staging file is unavailable. Retry to render the saved inputs.',
            retryable: true,
          }
        : interrupted;
    }
    // Sync a newly linked output before deleting its staging link.
    if (status.state === 'completed') syncDirectory(paths.root);
    rmSync(paths.scratch, { recursive: true, force: true });
    syncDirectory(paths.root);
  } catch (error) {
    // Keep the receipt until a retry can reconcile a possibly committed link.
    status.state = 'interrupted';
    status.result = null;
    status.error = {
      code: 'PUBLICATION_UNCERTAIN',
      message: `Could not reconcile job output or cleanup: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }
  store.finalize(status, !needsReconciliation(status));
}
