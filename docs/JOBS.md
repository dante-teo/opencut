# Durable local jobs (T43)

OpenCut can export a saved project in a separate local process. The current job
type is `render`. Use `project render` for foreground rendering, caller-selected
MP4 destinations and JSONL streaming. The desktop export still uses its
foreground lifecycle.

## Submit and recover from the CLI

```sh
opencut jobs submit /path/project.json --expected-revision 12 --idempotency-key review-cut-12 --json
opencut jobs list --state running --json
opencut jobs status JOB_ID --json
opencut jobs cancel JOB_ID --json
opencut jobs retry JOB_ID --attempt 1 --json
opencut jobs start --json
```

Submission acknowledges a durable queue entry. The CLI can exit immediately.
Poll `status` for the job state and use `result.path` after it reports
`completed`. Copy the resulting MP4 to another directory if needed. The queue
uses `~/.opencut/jobs` by default. Set `OPENCUT_JOBS_DIRECTORY` or pass
`--directory` to every command to select a different private directory on a
local filesystem. The worker runs on macOS and Linux. Use a filesystem that
supports SQLite locks, directory synchronization and hard links. New submissions
require local FFmpeg and ffprobe on PATH.

Keep the same key and request when replaying a submission after a client
timeout. The key is unique within its queue. An identical request returns its
existing ID even if the original project has changed or disappeared. Changing
the project path, expected revision or parameters for an existing key gives
`IDEMPOTENCY_CONFLICT`. Omit the key for a fresh submission and a generated
key. Use `--quality`, `--resolution`, `--codec` and `--no-subtitles` to set
CLI render parameters. Discover commands with `opencut help jobs --json`.

| State         | How to use it                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `queued`      | The job is waiting for a worker slot.                                                                     |
| `running`     | Poll progress. A cancellation request shows up in `cancelRequested` while the worker stops and cleans up. |
| `completed`   | The render was verified and committed. Read `result.path`.                                                |
| `cancelled`   | Cancellation stopped the attempt or took it out of the queue.                                             |
| `failed`      | Inspect `error.code`, `error.message` and `error.retryable`.                                              |
| `interrupted` | The worker stopped before verification finished, or publication and cleanup need reconciliation.          |

`status` includes ordered logs with sequence numbers, attempt numbers and
structured codes. `progress.phase` moves through preparation, rendering,
verification and publication. Rendering progress is monotonic within each
attempt. The `preparing` and `publishing` phases have a null percentage.
Verification can run after rendering reaches 100%. The state determines when
the output is ready.

A retry uses the same ID and immutable inputs. Pass the attempt you observed
so concurrent or repeated retry requests advance it only once. Cancelled
attempts and failures or interruptions with `error.retryable: true` can be
retried, up to three attempts total. Retries are explicit. A resource failure
can be retried after adjusting limits. Changed source files, unsupported
encoders and invalid input require a corrected submission. The status of a
successful submission remains available after the worker exits.

The worker starts on demand. After a crash or system restart, use `jobs start`
to resume queued work and reconcile old attempts. A new submission or a status
query for active work also wakes the worker. A graceful shutdown via SIGTERM or
SIGINT stops active attempts and hands queued work to a successor if work is
waiting. Treat `workerPid` as diagnostic because it can be stale.

- For `WORKER_INTERRUPTED`, retry with the attempt number from status to render
  the original inputs again.
- For `PUBLICATION_UNCERTAIN`, resolve the filesystem issue and retry with the
  same attempt number. An unrelated file at the destination is preserved. Once
  its owner has moved it, retry can publish the verified render already on disk.
- For `RECOVERY_BLOCKED`, restore access to the private job directory or lease
  file, then retry with the same attempt number. Other jobs can continue while
  access is blocked.

Check the state returned by retry. Reconciliation can complete the original
attempt or leave it interrupted if the blocker persists. A retry that starts a
new render advances the attempt number.

## TypeScript SDK

```ts
import { LocalJobs } from '@opencut/sdk';

const jobs = new LocalJobs();
const submitted = await jobs.submit(
  {
    type: 'render',
    projectPath: '/path/project.json',
    expectedRevision: 12,
    parameters: { quality: 'high', codec: 'h264' },
  },
  { idempotencyKey: 'review-cut-12' },
);
const current = await jobs.status(submitted.id);
if (current.state === 'completed') {
  console.log(current.result?.path);
}
```

`new LocalJobs({ directory })` selects a queue. Use `list(state?)`, `cancel(id)`,
`retry(id, attempt)`, `start()`, `limits()` and `configure(limits)`.
The render request also accepts `outputSize`, `outputFrameRate`,
`videoBitrateKbps`, `audioBitrateKbps`, `audioSampleRate` and
`audioChannels` in `parameters`. Use saved project content as the input.

## Resource budgets

```sh
opencut jobs limits --json
opencut jobs configure --concurrency 2 --cpu-seconds 1800 --job-memory-mib 4096 --scratch-mib 32768 --json
```

Defaults are one concurrent attempt, 1800 CPU seconds per attempt, 4096 MiB of
resident memory and 32768 MiB of scratch space. Configuration is per queue and
can change while there are no running attempts. Each attempt gets an equal
share of the configured memory and scratch totals based on the concurrency
setting. The worker samples attempt process groups and scratch files roughly
every 200 ms, including FFmpeg, ffprobe, Canvas native allocations and
intermediate FFV1 data. Hard-linked names for the same file count once. The
worker also checks free space on the scratch filesystem. Status reports peak
sampled resident memory and scratch bytes and cumulative observed CPU seconds. Budget violations stop the attempt, clean its scratch
space and report a structured error.

The limits are sampled safeguards. Brief bursts and CPU from subprocesses that
start and exit between samples can escape measurement. RSS can count shared
pages more than once and cannot account for separate GPU allocations. Current
render jobs use the CPU compositor and software encoders. Future GPU job types
will need their own device-memory accounting. Completed output and SQLite
history persist outside the scratch budget. Separate queues have independent
budgets. Keep the queue on local storage with enough room for verified exports
and intermediate files.

## Revision, publication and recovery semantics

The queue saves a detached project content snapshot with its original revision
and a snapshot digest. It captures the processing parameters, resolved source
paths and file identities, and the identities and versions of both media tools.
Rendering checks the source and tool identities before and after processing.
Keep original media in place until work completes. File identity checks detect
ordinary replacement or edits and rely on local filesystem metadata. The queue
references the media in place. Rendering takes place outside the project writer
lock and reports the output against the captured revision.

The typed request accepts a local project and allowlisted render settings.
Source media is restricted to file protocols and standalone image, video and
audio demuxers. Playlist and concat inputs are outside this job contract. The executing tools are selected from the submitting
process's PATH and bound to the captured executables.

SQLite provides queue durability and leases released by the OS when a worker
process dies. An attempt supervisor stays in its own process group and observes
the worker via a private IPC channel. Losing that channel or requesting
cancellation triggers group termination and a forced kill after a short grace
period. Recovery uses leases and live IPC. A system restart ends all groups. Simultaneously killing both an attempt supervisor and
its runner can leave external processes behind until they exit.

The renderer writes to private scratch, verifies output streams and frame count,
then records a receipt for the verified file. The worker rechecks the scratch
budget before linking an unpublished result, including during crash recovery.
Publication creates an exclusive hard link and synchronizes the directory
before recording completion. If the
worker dies between the link and the database commit, recovery matches the
output identity against the receipt and finishes without rendering twice.
Cancellation accepted before publication prevents a new link. A committed link
takes precedence over a later cancellation. The queue offers idempotency for
submission and publication. An interrupted computation can run again.
