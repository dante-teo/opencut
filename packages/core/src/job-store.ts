import { randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  defaultJobLimits,
  isActiveJob,
  JobError,
  jobLimitsSchema,
  MAX_ATTEMPTS,
  type JobDetails,
  type JobFailure,
  type JobInputs,
  type JobLimits,
  type JobLog,
  type JobProgress,
  type JobResources,
  type JobState,
  type JobStatus,
} from './job-contract.js';
import type { VideoTimelineResult } from '@opencut/media';
import type { ProjectSnapshot } from './project.js';

const require = createRequire(import.meta.url);

export function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new JobError(
      'JOB_STORE_SECURITY',
      'Job storage must be a private directory owned by the current user.',
    );
  return realpathSync(path);
}

export function jobDirectory(directory?: string) {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new JobError(
      'JOBS_UNSUPPORTED',
      'Local jobs require macOS or Linux.',
    );
  return privateDirectory(
    resolve(
      directory ??
        process.env.OPENCUT_JOBS_DIRECTORY ??
        join(homedir(), '.opencut', 'jobs'),
    ),
  );
}

function privateDatabase(path: string) {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new JobError(
      'JOB_STORE_SECURITY',
      'Job databases must be private regular files owned by the current user.',
    );
  const { DatabaseSync } =
    require('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path);
}

/** A separate rollback-mode database provides an OS-backed lease without blocking the queue. */
export function tryLease(path: string) {
  const db = privateDatabase(path);
  try {
    db.exec('BEGIN EXCLUSIVE');
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      db.close();
    };
  } catch (error) {
    db.close();
    if (error instanceof Error && 'errcode' in error && error.errcode === 5)
      return null;
    throw error;
  }
}

interface PreparedOutput {
  identity: string;
  result: VideoTimelineResult;
}
const parse = <T>(json: unknown) => JSON.parse(json as string) as T;
const parseNullable = <T>(json: unknown) =>
  json === null ? null : parse<T>(json);

export class JobStore {
  private readonly db: DatabaseSync;

  constructor(readonly directory: string) {
    this.db = privateDatabase(join(directory, 'queue.sqlite'));
    try {
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          request TEXT NOT NULL,
          status TEXT NOT NULL,
          prepared TEXT,
          execution_error TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state);
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, limits TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS logs (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          at TEXT NOT NULL,
          level TEXT NOT NULL,
          code TEXT NOT NULL,
          message TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS logs_job ON logs (id, sequence);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  transaction<T>(operation: () => T, mode: 'write' | 'read' = 'write'): T {
    this.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requiredRow<T>(row: T | undefined, id: string): T {
    if (!row) throw new JobError('JOB_NOT_FOUND', `No local job '${id}'.`);
    return row;
  }

  submitted(key: string, request: string): JobStatus | undefined {
    const row = this.db
      .prepare('SELECT status, request FROM jobs WHERE key = ?')
      .get(key);
    if (!row) return;
    if (row.request !== request)
      throw new JobError(
        'IDEMPOTENCY_CONFLICT',
        'The key already belongs to a different job request.',
      );
    return parse<JobStatus>(row.status);
  }

  status(id: string) {
    const row = this.requiredRow(
      this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id),
      id,
    );
    return parse<JobStatus>(row.status);
  }

  snapshot(id: string) {
    const row = this.requiredRow(
      this.db.prepare('SELECT snapshot FROM jobs WHERE id = ?').get(id),
      id,
    );
    return parse<ProjectSnapshot>(row.snapshot);
  }

  outcome(id: string) {
    const row = this.requiredRow(
      this.db
        .prepare('SELECT prepared, execution_error FROM jobs WHERE id = ?')
        .get(id),
      id,
    );
    return {
      prepared: parseNullable<PreparedOutput>(row.prepared),
      executionError: parseNullable<JobFailure>(row.execution_error),
    };
  }

  count(state: JobState) {
    return this.db
      .prepare('SELECT count(*) AS count FROM jobs WHERE state = ?')
      .get(state)!.count as number;
  }

  list(state?: JobState, limit = -1) {
    const rows = state
      ? this.db
          .prepare(
            'SELECT status FROM jobs WHERE state = ? ORDER BY rowid LIMIT ?',
          )
          .all(state, limit)
      : this.db.prepare('SELECT status FROM jobs ORDER BY rowid').all();
    return rows.map((row) => parse<JobStatus>(row.status));
  }

  details(id: string): JobDetails {
    const status = this.status(id);
    const logs = this.db
      .prepare(
        'SELECT sequence, attempt, at, level, code, message FROM logs WHERE id = ? ORDER BY sequence',
      )
      .all(id);
    return { ...status, logs: logs as unknown as JobLog[] };
  }

  claim(workerPid: number) {
    return this.transaction(() => {
      const available = Math.max(
        0,
        this.limits().concurrency - this.count('running'),
      );
      const queued = this.list('queued', available);
      for (const job of queued) {
        job.state = 'running';
        job.progress = { phase: 'preparing', percent: null };
        job.workerPid = workerPid;
        this.update(job);
        this.log(job, 'STARTED', 'Worker claimed the attempt.');
      }
      return queued;
    });
  }

  requestCancellation(status: JobStatus) {
    if (!isActiveJob(status.state) || status.cancelRequested) return;
    status.cancelRequested = true;
    const queued = status.state === 'queued';
    if (queued) status.state = 'cancelled';
    this.update(status);
    this.log(
      status,
      queued ? 'CANCELLED' : 'CANCEL_REQUESTED',
      queued ? 'Queued job cancelled.' : 'Cancellation requested.',
    );
  }

  requeue(status: JobStatus, attempt: number) {
    if (attempt < status.attempt) return;
    if (attempt !== status.attempt)
      throw new JobError(
        'ATTEMPT_CONFLICT',
        'Retry must reference the current or an earlier attempt.',
      );
    if (
      status.state === 'completed' ||
      status.error?.code === 'PUBLICATION_UNCERTAIN' ||
      status.error?.code === 'RECOVERY_BLOCKED'
    )
      return;
    if (isActiveJob(status.state))
      throw new JobError(
        'JOB_ACTIVE',
        'Wait for the current attempt to finish or be reconciled.',
      );
    if (
      attempt >= status.maxAttempts ||
      (status.state !== 'cancelled' && !status.error?.retryable)
    )
      throw new JobError(
        'JOB_NOT_RETRYABLE',
        'The error is permanent or the retry limit has been reached.',
      );
    status.attempt++;
    status.state = 'queued';
    status.cancelRequested = false;
    status.error = null;
    status.progress = null;
    status.resources = null;
    this.update(status);
    this.log(status, 'RETRY_QUEUED', 'Retry queued with the original inputs.');
  }

  insert(
    idempotencyKey: string,
    request: string,
    inputs: JobInputs,
    snapshot: ProjectSnapshot,
  ) {
    const now = new Date().toISOString();
    const status: JobStatus = {
      id: randomUUID(),
      idempotencyKey,
      state: 'queued',
      attempt: 1,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      inputs,
      progress: null,
      resources: null,
      result: null,
      error: null,
      workerPid: null,
    };
    this.db
      .prepare(
        'INSERT INTO jobs (id, key, state, snapshot, request, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        status.id,
        idempotencyKey,
        status.state,
        JSON.stringify(snapshot),
        request,
        JSON.stringify(status),
      );
    this.log(status, 'QUEUED', 'Job submitted.');
    return status;
  }

  recordProgress(id: string, progress: JobProgress) {
    this.transaction(() => {
      const status = this.status(id);
      if (status.progress?.phase !== progress.phase)
        this.log(
          status,
          progress.phase.toUpperCase(),
          `Render began ${progress.phase}.`,
        );
      status.progress = progress;
      this.update(status);
    });
  }

  recordVerified(id: string, receipt: PreparedOutput) {
    this.transaction(() => {
      const status = this.status(id);
      if (status.cancelRequested) return;
      status.progress = { phase: 'publishing', percent: null };
      this.update(status);
      this.db
        .prepare('UPDATE jobs SET prepared = ? WHERE id = ?')
        .run(JSON.stringify(receipt), id);
      this.log(status, 'VERIFIED', 'Verified output is ready for publication.');
    });
  }

  recordResources(id: string, resources: JobResources, failure?: JobFailure) {
    this.transaction(() => {
      const status = this.status(id);
      status.resources = resources;
      this.update(status);
      if (failure) this.setExecutionError(id, failure);
    });
  }

  recordExecutionFailure(id: string, failure: JobFailure) {
    this.transaction(() => {
      if (!this.outcome(id).executionError) this.setExecutionError(id, failure);
    });
  }

  finalize(status: JobStatus, reconciled: boolean) {
    if (reconciled)
      this.db
        .prepare(
          'UPDATE jobs SET prepared = NULL, execution_error = NULL WHERE id = ?',
        )
        .run(status.id);
    this.update(status);
    const error = status.error;
    this.log(
      status,
      error?.code ?? status.state.toUpperCase(),
      error?.message ??
        (status.state === 'completed'
          ? 'Verified output published.'
          : 'Job cancelled.'),
      error ? 'error' : 'info',
    );
  }

  private update(status: JobStatus) {
    status.updatedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE jobs SET state = ?, status = ? WHERE id = ?')
      .run(status.state, JSON.stringify(status), status.id);
  }

  private setExecutionError(id: string, error: JobFailure) {
    this.db
      .prepare('UPDATE jobs SET execution_error = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...error, message: error.message.slice(0, 8192) }),
        id,
      );
  }

  private log(
    status: JobStatus,
    code: string,
    message: string,
    level: JobLog['level'] = 'info',
  ) {
    this.db
      .prepare(
        'INSERT INTO logs (id, attempt, at, level, code, message) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        status.id,
        status.attempt,
        new Date().toISOString(),
        level,
        code,
        message.slice(0, 8192),
      );
  }

  limits() {
    const row = this.db
      .prepare('SELECT limits FROM settings WHERE id = 1')
      .get();
    return row
      ? jobLimitsSchema.parse(JSON.parse(row.limits as string))
      : { ...defaultJobLimits };
  }

  configure(limits: JobLimits) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (id, limits) VALUES (1, ?)')
      .run(JSON.stringify(limits));
  }
}

export function jobPaths(directory: string, id: string, attempt: number) {
  // Identifiers originate in the store. Still constrain all filesystem operations.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_ATTEMPTS
  )
    throw new JobError('INVALID_JOB', 'Invalid job or attempt identifier.');
  const root = join(directory, id);
  const scratch = join(root, `attempt-${attempt}`);
  return {
    root,
    scratch,
    staged: join(scratch, 'verified.mp4'),
    output: join(root, 'output.mp4'),
    guardianLease: join(root, 'guardian.sqlite'),
    runnerLease: join(root, 'runner.sqlite'),
  };
}
