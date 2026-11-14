import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { captureRender } from './job-render.js';
import { needsReconciliation, reconcileAttempt } from './job-publication.js';
import { jobDirectory, JobStore } from './job-store.js';
import {
  isActiveJob,
  JobError,
  jobLimitsSchema,
  jobStates,
  localJobRequest,
  type JobLimits,
  type JobState,
  type LocalJobRequest,
} from './job-contract.js';
import { wakeWorker } from './job-launcher.js';

export { JobError, defaultJobLimits } from './job-contract.js';
export type {
  JobBackend,
  JobDetails,
  JobFailure,
  JobInputs,
  JobLimits,
  JobLog,
  JobProgress,
  JobResources,
  JobState,
  JobStatus,
  JobToolIdentity,
  LocalJobRequest,
} from './job-contract.js';

export interface LocalJobsOptions {
  directory?: string | undefined;
}

export interface JobSubmissionOptions {
  idempotencyKey?: string | undefined;
}

/** A client for one private, persistent local queue. All operations may wake its worker. */
export class LocalJobs {
  readonly directory: string;

  constructor(options: LocalJobsOptions = {}) {
    this.directory = jobDirectory(options.directory);
  }

  private use<T>(run: (store: JobStore) => T): T {
    const store = new JobStore(this.directory);
    try {
      return run(store);
    } finally {
      store.close();
    }
  }

  /** Wake the queue after a restart, including reconciliation of old attempts. */
  async start() {
    await wakeWorker(this.directory);
  }

  async submit(spec: LocalJobRequest, options: JobSubmissionOptions = {}) {
    const parsed = localJobRequest.safeParse(spec);
    if (!parsed.success)
      throw new JobError('INVALID_JOB', parsed.error.message);
    const key = options.idempotencyKey ?? randomUUID();
    if (typeof key !== 'string' || !key.trim() || key.length > 256)
      throw new JobError(
        'INVALID_IDEMPOTENCY_KEY',
        'Provide a nonblank key of at most 256 characters.',
      );
    const request = parsed.data;
    // Look up the original requested path before touching the project or sources.
    // Replaying a key after an edit or deletion returns the original revision.
    const projectPath = resolve(request.projectPath);
    const fingerprint = JSON.stringify([
      request.type,
      projectPath,
      request.expectedRevision,
      request.parameters,
    ]);
    const existing = (store: JobStore) => store.submitted(key, fingerprint);
    let status = this.use(existing);
    if (!status) {
      try {
        const { inputs, snapshot } = await captureRender(
          projectPath,
          request.expectedRevision,
          request.parameters,
        );
        status = this.use((store) =>
          store.transaction(
            () =>
              existing(store) ??
              store.insert(key, fingerprint, inputs, snapshot),
          ),
        );
      } catch (error) {
        // A competing submit may have captured the inputs before they changed.
        status = this.use(existing);
        if (!status) throw error;
      }
    }
    await this.start();
    return status;
  }

  async status(id: string) {
    const result = this.use((store) =>
      store.transaction(() => store.details(id), 'read'),
    );
    if (isActiveJob(result.state)) await this.start();
    return result;
  }

  async list(state?: JobState) {
    if (state !== undefined && !jobStates.includes(state))
      throw new JobError(
        'INVALID_JOB_STATE',
        'Choose a supported local job state.',
      );
    const jobs = this.use((store) => store.list(state));
    if (jobs.some(({ state }) => isActiveJob(state))) await this.start();
    return jobs;
  }

  async cancel(id: string) {
    const result = this.use((store) =>
      store.transaction(() => {
        store.requestCancellation(store.status(id));
        return store.details(id);
      }),
    );
    if (result.state === 'running') await this.start();
    return result;
  }

  async retry(id: string, attempt: number) {
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new JobError(
        'INVALID_ATTEMPT',
        'Retry requires the attempt number from job status.',
      );
    const result = this.use((store) => {
      const status = store.status(id);
      if (
        status.attempt === attempt &&
        status.state === 'interrupted' &&
        needsReconciliation(status)
      )
        reconcileAttempt(store, status);
      return store.transaction(() => {
        store.requeue(store.status(id), attempt);
        return store.details(id);
      });
    });
    if (isActiveJob(result.state)) await this.start();
    return result;
  }

  limits(): JobLimits {
    return this.use((store) => store.limits());
  }

  async configure(limits: JobLimits): Promise<JobLimits> {
    const parsed = jobLimitsSchema.safeParse(limits);
    if (!parsed.success)
      throw new JobError('INVALID_JOB_LIMITS', parsed.error.message);
    this.use((store) =>
      store.transaction(() => {
        if (store.count('running'))
          throw new JobError(
            'JOB_WORKER_BUSY',
            'Wait for running attempts to finish before changing limits.',
          );
        store.configure(parsed.data);
      }),
    );
    await this.start();
    return parsed.data;
  }
}
