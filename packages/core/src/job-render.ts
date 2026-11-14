import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  renderVideoTimeline,
  sourceFileStamp,
  withLocalRenderTools,
  type RenderProgress,
} from '@opencut/media';
import {
  checkProjectRevision,
  projectRevision,
  projectSnapshot,
} from './editing.js';
import { getApplicationInfo } from './index.js';
import { canonicalProjectFilePath, readProjectFile } from './project-files.js';
import { resolveProjectRender } from './render-files.js';
import { isErrno } from './job-store.js';
import {
  JobError,
  type JobInputs,
  type JobToolIdentity,
} from './job-contract.js';
import type { ProjectSnapshot } from './project.js';

const execute = promisify(execFile);
// Bump when changes make previously captured render inputs incompatible.
const renderer = `OpenCut ${getApplicationInfo().version} / render-job-v1`;

async function toolIdentity(
  tool: 'ffmpeg' | 'ffprobe',
): Promise<JobToolIdentity> {
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(
    delimiter,
  )) {
    const path = resolve(directory, tool);
    try {
      await access(path, constants.X_OK);
    } catch (error) {
      if (
        isErrno(error, 'ENOENT') ||
        isErrno(error, 'ENOTDIR') ||
        isErrno(error, 'EACCES')
      )
        continue;
      throw error;
    }
    const executable = await realpath(path);
    const stamp = await sourceFileStamp(executable);
    const { stdout } = await execute(executable, ['-version'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    if (stamp !== (await sourceFileStamp(executable)))
      throw new JobError(
        'BACKEND_CHANGED',
        `'${tool}' changed while capturing job inputs.`,
      );
    const version = stdout.split('\n', 1)[0]?.trim();
    if (!version?.startsWith(tool + ' version '))
      throw new JobError(
        'BACKEND_UNAVAILABLE',
        `'${tool}' did not report a supported version.`,
      );
    return { path: executable, stamp, version };
  }
  throw new JobError(
    'BACKEND_UNAVAILABLE',
    `Install '${tool}' and make it available on PATH.`,
  );
}

function snapshotHash(snapshot: ProjectSnapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function sourcePaths(plan: Awaited<ReturnType<typeof resolveProjectRender>>) {
  return [
    ...new Set([
      ...plan.visualClips.flatMap((clip) => (clip.path ? [clip.path] : [])),
      ...plan.audioClips.map(({ path }) => path),
      ...(plan.visualTransitions ?? []).flatMap(({ layers }) =>
        layers.map(({ path }) => path),
      ),
    ]),
  ].sort();
}

async function sourceIdentity(path: string) {
  try {
    // image2 must not interpret a file name as an image sequence.
    if (path.includes('%'))
      throw new Error('Image sequence paths are unsupported.');
    const realPath = await realpath(path);
    if (realPath.includes('%'))
      throw new Error('Image sequence paths are unsupported.');
    const stamp = await sourceFileStamp(realPath);
    await access(realPath, constants.R_OK);
    return { path, realPath, stamp };
  } catch (cause) {
    throw new JobError(
      'SOURCE_UNAVAILABLE',
      `Cannot use source '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function captureRender(
  projectPath: string,
  expectedRevision: number | undefined,
  parameters: JobInputs['parameters'],
) {
  const path = await canonicalProjectFilePath(projectPath);
  const project = await readProjectFile(path);
  checkProjectRevision(project, expectedRevision);
  const snapshot = projectSnapshot(project);
  const plan = await resolveProjectRender(snapshot, path, parameters);
  const [sources, ffmpeg, ffprobe] = await Promise.all([
    Promise.all(sourcePaths(plan).map(sourceIdentity)),
    toolIdentity('ffmpeg'),
    toolIdentity('ffprobe'),
  ]);
  const inputs: JobInputs = {
    type: 'render',
    projectPath: path,
    revision: projectRevision(project),
    snapshotHash: snapshotHash(snapshot),
    parameters,
    sources,
    backend: { renderer, ffmpeg, ffprobe },
  };
  return { snapshot, inputs };
}

export async function renderJob(
  inputs: JobInputs,
  snapshot: ProjectSnapshot,
  output: string,
  signal: AbortSignal,
  onProgress: (progress: RenderProgress) => void,
) {
  if (inputs.backend.renderer !== renderer)
    throw new JobError(
      'BACKEND_CHANGED',
      'The saved job requires a different OpenCut render backend.',
    );
  if (inputs.snapshotHash !== snapshotHash(snapshot))
    throw new JobError(
      'INVALID_SNAPSHOT',
      'The stored project snapshot failed its integrity check.',
    );
  const plan = await resolveProjectRender(
    snapshot,
    inputs.projectPath,
    inputs.parameters,
  );
  const paths = sourcePaths(plan);
  async function verifyInputs() {
    const identities = await Promise.all(
      paths.map(async (path) => {
        try {
          return await sourceIdentity(path);
        } catch {
          throw new JobError(
            'SOURCE_CHANGED',
            `Captured source '${path}' is no longer readable.`,
          );
        }
      }),
    );
    if (JSON.stringify(identities) !== JSON.stringify(inputs.sources))
      throw new JobError(
        'SOURCE_CHANGED',
        'Original media changed since submission. Submit a new job for the current sources.',
      );
    for (const tool of [inputs.backend.ffmpeg, inputs.backend.ffprobe]) {
      if ((await sourceFileStamp(tool.path).catch(() => null)) !== tool.stamp)
        throw new JobError(
          'BACKEND_CHANGED',
          `Captured executable '${tool.path}' changed or is unavailable.`,
        );
    }
    signal.throwIfAborted();
  }
  await verifyInputs();
  const capturedPaths = new Map(
    inputs.sources.map(({ path, realPath }) => [path, realPath]),
  );
  const bind = <T extends { path: string }>(clip: T): T => ({
    ...clip,
    path: capturedPaths.get(clip.path)!,
  });
  const options = {
    ...plan,
    ...inputs.parameters,
    visualClips: plan.visualClips.map((clip) =>
      clip.path ? bind(clip) : clip,
    ),
    audioClips: plan.audioClips.map(bind),
    ...(plan.visualTransitions && {
      visualTransitions: plan.visualTransitions.map((transition) => ({
        ...transition,
        layers: transition.layers.map(bind),
      })),
    }),
    output,
    signal,
    onProgress,
  };
  const result = await withLocalRenderTools(
    {
      ffmpeg: inputs.backend.ffmpeg.path,
      ffprobe: inputs.backend.ffprobe.path,
    },
    () => renderVideoTimeline(options),
  );
  await verifyInputs();
  const file = await open(output, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  return result;
}
