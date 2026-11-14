import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  addClip,
  createProject,
  frameTime,
  serializeProject,
} from '@opencut/core';
import { LocalJobs, type JobDetails, type JobStatus } from '@opencut/sdk';
import {
  JobStore,
  jobPaths,
  tryLease,
} from '../../packages/core/src/job-store.js';
import { sampleScratch } from '../../packages/core/src/job-resources.js';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

const exec = promisify(execFile);
const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const rate = { numerator: 30, denominator: 1 };
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function until<T>(
  read: () => Promise<T>,
  yes: (value: T) => boolean,
  message: string,
) {
  for (let tries = 0; tries < 250; tries++) {
    const result = await read();
    if (yes(result)) return result;
    await delay(60);
  }
  assert.fail(message);
}

function example(source: string) {
  const project = createProject({
    name: 'Durable native render',
    settings: { width: 320, height: 180, frameRate: rate },
  });
  project.assets = [
    {
      id: 'asset',
      name: 'Source',
      mediaTypes: ['video'],
      file: { type: 'absolute', path: source },
    },
  ];
  project.tracks = [{ id: 'track', name: 'Visual', type: 'video' }];
  return addClip(project, {
    id: 'clip',
    assetId: 'asset',
    trackId: 'track',
    timelineStart: frameTime(0, rate),
    sourceIn: frameTime(0, rate),
    sourceOut: frameTime(30, rate),
  }).project;
}

test(
  'T43 durable CLI and SDK jobs with native FFmpeg',
  { timeout: 120000 },
  async (t) => {
    requireTool('ffmpeg');
    requireTool('ffprobe');
    const root = await mkdtemp(join(generated, 't43-'));
    const bin = join(root, 'bin');
    const gate = join(root, 'gate');
    const pids = join(root, 'pids');
    const resourceMode = join(root, 'resource-mode');
    const source = join(root, 'source.mp4');
    const projectPath = join(root, 'project.json');
    const directory = join(root, 'queue');
    const ffmpeg = execFileSync('/bin/sh', ['-c', 'command -v ffmpeg'], {
      encoding: 'utf8',
    }).trim();
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      T43_GATE: gate,
      T43_PIDS: pids,
      T43_FFMPEG: ffmpeg,
      T43_RESOURCE_MODE: resourceMode,
    };
    await mkdir(bin);
    // Hold only the encoding tool. Keep a live TERM-resistant descendant to
    // exercise escalation, and delegate execution to real FFmpeg on release.
    await writeFile(
      join(bin, 'ffmpeg'),
      `#!/bin/sh
for arg do
  if [ "$arg" = '-progress' ] && [ -f "$T43_RESOURCE_MODE" ]; then
    case "$(/bin/cat "$T43_RESOURCE_MODE")" in
      cpu) while :; do :; done ;;
      disk)
        for dest do :; done
        dd if=/dev/zero of="$dest.pad" bs=1048576 count=4 2>/dev/null || exit 1
        while :; do sleep 0.1; done
        ;;
    esac
  fi
  if [ "$arg" = '-progress' ] && [ -e "$T43_GATE" ]; then
    /bin/sh -c 'trap "" TERM; while [ -e "$T43_GATE" ]; do sleep 0.1; done' &
    child=$!
    printf '%s %s\\n' "$$" "$child" >> "$T43_PIDS"
    wait "$child"
    break
  fi
done
exec "$T43_FFMPEG" "$@"
`,
    );
    await chmod(join(bin, 'ffmpeg'), 0o700);
    await copyFile(join(generated, 'video-medium.mp4'), source);
    const original = example(source);
    await writeFile(projectPath, serializeProject(original));
    const run = async <T>(...args: string[]) => {
      const { stdout } = await exec(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', entry, ...args, '--json'],
        { env, timeout: 15000 },
      );
      return JSON.parse(stdout) as T;
    };
    const cli = <T>(...args: string[]) =>
      run<T>('jobs', ...args, '--directory', directory);
    const submit = (key: string, ...args: string[]) =>
      cli<JobStatus>('submit', projectPath, '--idempotency-key', key, ...args);
    const status = (id: string) => cli<JobDetails>('status', id);
    const terminal = (id: string) =>
      until(
        () => status(id),
        (job) => !['queued', 'running'].includes(job.state),
        'job did not terminate',
      );
    const rendering = (id: string) =>
      until(
        () => status(id),
        (job) =>
          job.progress?.phase === 'rendering' ||
          !['queued', 'running'].includes(job.state),
        'job did not reach encoding',
      );
    const scratchClean = async (id: string) => {
      assert.equal(
        (await readdir(join(directory, id))).some((name) =>
          name.startsWith('attempt-'),
        ),
        false,
      );
    };
    const sdk = new LocalJobs({ directory });
    const readPids = async () =>
      (await readFile(pids, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ').map(Number));
    const waitForPids = (count: number) =>
      until(
        readPids,
        (groups) => groups.length >= count,
        'encoder did not reach gate',
      );
    const gone = (pid: number) =>
      until(
        () =>
          exec('/bin/ps', ['-o', 'stat=', '-p', String(pid)]).then(
            ({ stdout }) => stdout.trim(),
            () => '',
          ),
        (state) => !state || state.startsWith('Z'),
        `PID ${pid} remained active`,
      );
    // Observe the queue without using commands that implicitly wake workers.
    const inspect = (id: string) => {
      const store = new JobStore(directory);
      try {
        return Promise.resolve(store.status(id));
      } finally {
        store.close();
      }
    };
    const guardianGroup = async (pid: number) => {
      const { stdout } = await exec('/bin/ps', [
        '-o',
        'pgid=',
        '-p',
        String(pid),
      ]);
      const group = Number(stdout.trim());
      assert.ok(Number.isSafeInteger(group) && group > 1);
      return group;
    };
    const leaseReleased = (path: string) =>
      until(
        async () => {
          const release = tryLease(path);
          release?.();
          return Boolean(release);
        },
        Boolean,
        'attempt lease remained held',
      );
    let stoppedGuardian: number | undefined;
    let stoppedWorker: number | undefined;
    try {
      await t.test(
        'detached submit, concurrent deduplication, revision isolation and verified output',
        async () => {
          await writeFile(gate, '');
          const duplicates = await Promise.all(
            Array.from({ length: 5 }, () => submit('revision')),
          );
          const job = duplicates[0]!;
          assert.ok(duplicates.every(({ id }) => id === job.id));
          assert.equal((await cli<JobStatus[]>('list')).length, 1);
          const running = await rendering(job.id);
          assert.equal(running.state, 'running', JSON.stringify(running.error));
          assert.equal(running.progress?.phase, 'rendering');
          await waitForPids(1); // All submitting CLI processes have exited.
          assert.equal(
            await exists(join(directory, job.id, 'output.mp4')),
            false,
          );
          await run(
            'canvas',
            'set',
            projectPath,
            '--width',
            '640',
            '--height',
            '180',
            '--expected-revision',
            String(job.inputs.revision),
          );
          const live = await run<{ revision: number }>(
            'project',
            'inspect',
            projectPath,
          );
          assert.equal(live.revision, job.inputs.revision + 1);
          const replay = await submit('revision');
          assert.equal(replay.id, job.id);
          assert.equal(replay.inputs.revision, job.inputs.revision);
          await assert.rejects(
            submit('revision', '--quality', 'high'),
            /IDEMPOTENCY_CONFLICT/,
          );
          await rm(gate);
          const completed = await terminal(job.id);
          assert.equal(
            completed.state,
            'completed',
            JSON.stringify(completed.error),
          );
          assert.equal(completed.result!.width, 320);
          assert.equal(completed.result!.frameCount, 30);
          assert.equal(completed.inputs.revision, job.inputs.revision);
          assert.ok(completed.logs.some(({ code }) => code === 'VERIFIED'));
          assert.ok(completed.resources!.memoryBytes > 0);
          assert.ok(completed.resources!.scratchBytes > 0);
          runTool('ffmpeg', [
            '-v',
            'error',
            '-i',
            completed.result!.path,
            '-f',
            'null',
            '-',
          ]);
          await scratchClean(job.id);
          assert.equal((await sdk.status(job.id)).state, 'completed');
          assert.equal((await sdk.list('completed'))[0]!.id, job.id);
          assert.equal(
            (await cli<JobStatus[]>('list', '--state', 'completed')).length,
            1,
          );
          t.diagnostic(
            `Baseline native attempt ${JSON.stringify(completed.resources)}`,
          );
        },
      );

      await t.test(
        'queued cancellation and running process-tree termination',
        async () => {
          await writeFile(gate, '');
          const running = await submit('cancel-active');
          const [, descendant] = (await waitForPids(2))[1]!;
          const queued = await submit('cancel-queued');
          assert.equal((await status(queued.id)).state, 'queued');
          assert.equal((await sdk.cancel(queued.id)).state, 'cancelled');
          for (const attempt of [1, 2]) {
            assert.equal(
              (await sdk.retry(queued.id, attempt)).attempt,
              attempt + 1,
            );
            assert.equal((await sdk.cancel(queued.id)).state, 'cancelled');
          }
          await assert.rejects(sdk.retry(queued.id, 3), {
            code: 'JOB_NOT_RETRYABLE',
          });
          const requested = await cli<JobDetails>('cancel', running.id);
          assert.equal(requested.cancelRequested, true);
          const cancelled = await terminal(running.id);
          assert.equal(
            cancelled.state,
            'cancelled',
            JSON.stringify(cancelled.error),
          );
          await gone(descendant!);
          await scratchClean(running.id);
          assert.equal(
            await exists(join(directory, running.id, 'output.mp4')),
            false,
          );
          await rm(gate);
        },
      );

      await t.test(
        'SIGKILL, orphan cleanup, restart and concurrent retry of one attempt',
        async () => {
          await writeFile(gate, '');
          const job = await submit('crash');
          const [, descendant] = (await waitForPids(3))[2]!;
          const active = await status(job.id);
          assert.equal(active.state, 'running');
          process.kill(active.workerPid!, 'SIGKILL');
          await cli('start');
          const interrupted = await terminal(job.id);
          assert.equal(
            interrupted.state,
            'interrupted',
            JSON.stringify(interrupted.error),
          );
          assert.equal(interrupted.error?.code, 'WORKER_INTERRUPTED');
          assert.equal(interrupted.error?.retryable, true);
          assert.equal(
            (await cli<JobStatus[]>('list', '--state', 'completed')).length,
            1,
          );
          await gone(descendant!);
          await scratchClean(job.id);
          assert.equal(
            await exists(join(directory, job.id, 'output.mp4')),
            false,
          );
          await rm(gate);
          const retries = await Promise.all([
            cli<JobDetails>('retry', job.id, '--attempt', '1'),
            cli<JobDetails>('retry', job.id, '--attempt', '1'),
          ]);
          assert.ok(
            retries.every(({ attempt, id }) => attempt === 2 && id === job.id),
          );
          const completed = await terminal(job.id);
          assert.equal(
            completed.state,
            'completed',
            JSON.stringify(completed.error),
          );
          assert.equal(completed.attempt, 2);
          assert.notEqual(
            completed.logs.filter(({ attempt }) => attempt === 1).length,
            0,
          );
          assert.equal(
            completed.logs.filter(({ code }) => code === 'RETRY_QUEUED').length,
            1,
          );
        },
      );

      await t.test(
        'restart adopts an already-linked verified result at the publication boundary',
        async () => {
          await writeFile(gate, '');
          const job = await submit('publish-crash');
          await waitForPids(4);
          const active = await status(job.id);
          stoppedWorker = active.workerPid!;
          process.kill(stoppedWorker, 'SIGSTOP');
          await rm(gate);
          await until(
            () => status(job.id),
            (job) => job.progress?.phase === 'publishing',
            'verified receipt not recorded',
          );
          const path = join(directory, job.id);
          await link(
            join(path, 'attempt-1', 'verified.mp4'),
            join(path, 'output.mp4'),
          );
          process.kill(stoppedWorker, 'SIGKILL');
          stoppedWorker = undefined;
          const completed = await terminal(job.id);
          assert.equal(
            completed.state,
            'completed',
            JSON.stringify(completed.error),
          );
          assert.equal(completed.attempt, 1);
          assert.equal(completed.result?.path, join(path, 'output.mp4'));
          await scratchClean(job.id);
        },
      );

      await t.test(
        'admission respects concurrency and enforces sampled native memory limits',
        async () => {
          await sdk.configure({
            concurrency: 2,
            cpuSecondsPerJob: 90,
            memoryMiB: 2048,
            scratchMiB: 256,
          });
          await writeFile(gate, '');
          const queued = await Promise.all(
            ['slot-a', 'slot-b', 'slot-c'].map((key) => submit(key)),
          );
          await waitForPids(6);
          assert.equal((await sdk.list('running')).length, 2);
          assert.equal((await sdk.list('queued')).length, 1);
          await assert.rejects(
            sdk.configure({
              concurrency: 1,
              cpuSecondsPerJob: 90,
              memoryMiB: 1,
              scratchMiB: 256,
            }),
            /Wait for running/,
          );
          await rm(gate);
          for (const job of queued)
            assert.equal((await terminal(job.id)).state, 'completed');
          await sdk.configure({
            concurrency: 1,
            cpuSecondsPerJob: 90,
            memoryMiB: 1,
            scratchMiB: 256,
          });
          const limited = await submit('memory');
          const failed = await terminal(limited.id);
          assert.equal(failed.state, 'failed', JSON.stringify(failed.error));
          assert.equal(failed.error?.code, 'MEMORY_BUDGET_EXCEEDED');
          assert.ok(failed.resources!.memoryBytes > 1024 * 1024);
          t.diagnostic(
            `Memory limit sample ${JSON.stringify(failed.resources)}`,
          );
          assert.equal(
            await exists(join(directory, limited.id, 'output.mp4')),
            false,
          );
          await scratchClean(limited.id);
          await sdk.configure({
            concurrency: 1,
            cpuSecondsPerJob: 90,
            memoryMiB: 2048,
            scratchMiB: 256,
          });
          await sdk.retry(limited.id, 1);
          assert.equal((await terminal(limited.id)).state, 'completed');
        },
      );

      await t.test(
        'source drift is permanent and unknown job types are rejected',
        async () => {
          await writeFile(gate, '');
          const job = await submit('source-drift');
          await waitForPids(7);
          await writeFile(source, await readFile(source));
          await rm(gate);
          const failed = await terminal(job.id);
          assert.equal(failed.state, 'failed', JSON.stringify(failed.error));
          assert.equal(failed.error?.code, 'SOURCE_CHANGED');
          await assert.rejects(
            sdk.retry(job.id, 1),
            /permanent or the retry limit/,
          );
          assert.equal(
            await exists(join(directory, job.id, 'output.mp4')),
            false,
          );
          await scratchClean(job.id);
          await assert.rejects(sdk.submit({ type: 'shell' } as never), {
            code: 'INVALID_JOB',
          });
        },
      );

      await t.test(
        'the worker rejects playlist demuxers for local jobs',
        async () => {
          const playlist = join(root, 'alias.ffconcat');
          await writeFile(
            playlist,
            "ffconcat version 1.0\nfile 'source.mp4'\n",
          );
          const playlistProject = join(root, 'playlist-project.json');
          await writeFile(playlistProject, serializeProject(example(playlist)));
          const job = await cli<JobStatus>('submit', playlistProject);
          const failed = await terminal(job.id);
          assert.equal(failed.state, 'failed');
          assert.match(failed.error?.message ?? '', /not on whitelist/i);
          assert.equal(failed.error?.retryable, false);
          assert.equal(
            await exists(join(directory, job.id, 'output.mp4')),
            false,
          );
          await scratchClean(job.id);
        },
      );

      await t.test(
        'an existing output is preserved and retry publishes the original verified render',
        async () => {
          const nextGate = (await readPids()).length + 1;
          await writeFile(gate, '');
          const job = await submit('publication-conflict');
          await waitForPids(nextGate);
          const output = join(directory, job.id, 'output.mp4');
          await writeFile(output, 'unrelated file', { flag: 'wx' });
          await rm(gate);
          const uncertain = await terminal(job.id);
          assert.equal(uncertain.state, 'interrupted');
          assert.equal(uncertain.error?.code, 'PUBLICATION_UNCERTAIN');
          assert.equal(uncertain.result, null);
          assert.equal(await readFile(output, 'utf8'), 'unrelated file');
          assert.equal(
            (await sdk.retry(job.id, 1)).error?.code,
            'PUBLICATION_UNCERTAIN',
          );

          await rm(output);
          const recovered = await sdk.retry(job.id, 1);
          assert.equal(
            recovered.state,
            'completed',
            JSON.stringify(recovered.error),
          );
          assert.equal(recovered.attempt, 1);
          assert.equal(recovered.result?.path, output);
          assert.equal(
            recovered.logs.filter(({ code }) => code === 'STARTED').length,
            1,
          );
          await scratchClean(job.id);
        },
      );

      await t.test(
        'CPU time and intermediate disk usage cause inspectable budget failures',
        async () => {
          for (const [mode, errorCode, cpuSecondsPerJob, scratchMiB] of [
            ['cpu', 'CPU_BUDGET_EXCEEDED', 1, 256],
            ['disk', 'SCRATCH_BUDGET_EXCEEDED', 90, 1],
          ] as const) {
            await writeFile(resourceMode, mode);
            await sdk.configure({
              concurrency: 1,
              cpuSecondsPerJob,
              memoryMiB: 2048,
              scratchMiB,
            });
            const job = await submit(mode);
            const failed = await terminal(job.id);
            assert.equal(failed.state, 'failed', JSON.stringify(failed.error));
            assert.equal(failed.error?.code, errorCode);
            assert.ok(failed.error.retryable);
            assert.equal(
              await exists(join(directory, job.id, 'output.mp4')),
              false,
            );
            await scratchClean(job.id);
            t.diagnostic(
              `${mode} limit sample ${JSON.stringify(failed.resources)}`,
            );
          }
        },
      );
      await t.test(
        'SIGTERM hands submitted work to a successor without another client wake',
        async () => {
          await rm(resourceMode);
          await sdk.configure({
            concurrency: 1,
            cpuSecondsPerJob: 90,
            memoryMiB: 2048,
            scratchMiB: 256,
          });
          const nextGate = (await readPids()).length;
          await writeFile(gate, '');
          const active = await submit('shutdown-active');
          const [encoder] = (await waitForPids(nextGate + 1))[nextGate]!;
          const running = await inspect(active.id);
          const worker = running.workerPid!;
          stoppedGuardian = await guardianGroup(encoder!);
          process.kill(stoppedGuardian, 'SIGSTOP');
          try {
            process.kill(worker, 'SIGTERM');
            const queued = await submit('shutdown-queued');
            assert.equal(queued.state, 'queued');
            process.kill(stoppedGuardian, 'SIGCONT');
            stoppedGuardian = undefined;
            await gone(worker);
            await rm(gate);
            const completed = await until(
              () => inspect(queued.id),
              (job) => job.state === 'completed',
              'successor did not process the acknowledged job',
            );
            assert.equal(completed.attempt, 1);
            assert.equal((await inspect(active.id)).state, 'interrupted');
          } finally {
            if (stoppedGuardian) process.kill(stoppedGuardian, 'SIGCONT');
            stoppedGuardian = undefined;
            await rm(gate, { force: true });
          }
        },
      );

      await t.test(
        'recovery rechecks scratch size before linking a verified receipt',
        async () => {
          await sdk.configure({
            concurrency: 1,
            cpuSecondsPerJob: 90,
            memoryMiB: 2048,
            scratchMiB: 1,
          });
          const nextGate = (await readPids()).length;
          await writeFile(gate, '');
          const job = await submit('crash-over-budget');
          const [encoder] = (await waitForPids(nextGate + 1))[nextGate]!;
          const running = await inspect(job.id);
          stoppedWorker = running.workerPid!;
          stoppedGuardian = await guardianGroup(encoder!);
          process.kill(stoppedWorker, 'SIGSTOP');
          process.kill(stoppedGuardian, 'SIGSTOP');
          const paths = jobPaths(directory, job.id, 1);
          await rm(gate);
          await until(
            () => inspect(job.id),
            (job) => job.progress?.phase === 'publishing',
            'runner did not record verification with the guardian stopped',
          );
          await leaseReleased(paths.runnerLease);
          // Leave extra scratch data before recovery, with the final sample still pending.
          const padding = join(paths.scratch, 'intermediate');
          await writeFile(padding, '');
          await truncate(padding, 2 * 1024 * 1024);
          process.kill(stoppedGuardian, 'SIGKILL');
          stoppedGuardian = undefined;
          process.kill(stoppedWorker, 'SIGKILL');
          stoppedWorker = undefined;
          await cli('start');
          const failed = await terminal(job.id);
          assert.equal(failed.state, 'failed');
          assert.equal(failed.error?.code, 'SCRATCH_BUDGET_EXCEEDED');
          assert.ok(failed.resources!.scratchBytes >= 2 * 1024 * 1024);
          assert.equal(await exists(paths.output), false);
          await scratchClean(job.id);
        },
      );

      await t.test(
        'a damaged attempt is isolated and recoverable after repairing its lease',
        async () => {
          const nextGate = (await readPids()).length;
          await writeFile(gate, '');
          const job = await submit('damaged-attempt');
          await waitForPids(nextGate + 1);
          const running = await inspect(job.id);
          const paths = jobPaths(directory, job.id, 1);
          process.kill(running.workerPid!, 'SIGKILL');
          await leaseReleased(paths.guardianLease);
          await leaseReleased(paths.runnerLease);
          await chmod(paths.runnerLease, 0o644);
          await rm(gate);
          try {
            const healthy = await submit('after-damaged-attempt');
            const failed = await terminal(job.id);
            assert.equal(failed.state, 'interrupted');
            assert.equal(failed.error?.code, 'RECOVERY_BLOCKED');
            assert.equal(await exists(paths.scratch), true);
            assert.equal(
              (await sdk.retry(job.id, 1)).error?.code,
              'RECOVERY_BLOCKED',
            );
            assert.equal((await terminal(healthy.id)).state, 'completed');
          } finally {
            await chmod(paths.runnerLease, 0o600);
          }
          assert.equal((await sdk.retry(job.id, 1)).attempt, 2);
          assert.equal((await terminal(job.id)).state, 'completed');
          await scratchClean(job.id);
        },
      );

      await t.test(
        'scratch sampling charges one inode across two render paths',
        async () => {
          const paths = join(root, 'linked-scratch');
          await mkdir(join(paths, 'render'), { recursive: true });
          const staged = join(paths, 'render', 'render.mp4');
          const bytes = 768 * 1024;
          await writeFile(staged, Buffer.alloc(bytes));
          await link(staged, join(paths, 'verified.mp4'));
          const limits = {
            concurrency: 1,
            cpuSecondsPerJob: 90,
            memoryMiB: 2048,
            scratchMiB: 1,
          };
          const sample = sampleScratch(paths, limits);
          assert.equal(sample.bytes, bytes);
          assert.equal(sample.error, undefined);
          await copyFile(staged, join(paths, 'copy.mp4'));
          assert.equal(
            sampleScratch(paths, limits).error?.code,
            'SCRATCH_BUDGET_EXCEEDED',
          );
        },
      );
    } finally {
      if (stoppedGuardian) process.kill(stoppedGuardian, 'SIGCONT');
      if (stoppedWorker) process.kill(stoppedWorker, 'SIGCONT');
      await rm(gate, { force: true });
      await rm(resourceMode, { force: true });
      const jobs = await sdk.list().catch(() => []);
      for (const job of jobs.filter(
        ({ state }) => state === 'running' || state === 'queued',
      ))
        await sdk.cancel(job.id).catch(() => {});
      // The worker releases its lease on idle. Let it exit before removing its store.
      await delay(6500);
      await rm(root, { recursive: true, force: true });
    }
  },
);
