import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MediaError, renderVideoTimeline } from '@opencut/media';
import type { RenderControls } from '@opencut/media';
import { withRenderSources } from './render-sources.js';
import type { CompiledVideo } from './video-compiler.js';
import { compileVideo } from './video-files.js';

export type VideoRenderOptions = Omit<
  RenderControls,
  'range' | 'maxDimension'
> & {
  burnSubtitles?: boolean;
};

async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

/** Protect the definition and every declared source, including unused assets. */
async function protectInputs(
  video: CompiledVideo,
  output: string,
  signal?: AbortSignal,
) {
  const destination = await statIfPresent(resolve(output));
  if (!destination) return;
  for (const path of new Set([
    video.path,
    ...video.project.assets.map(({ file }) =>
      resolve(dirname(video.path), file.path),
    ),
  ])) {
    signal?.throwIfAborted();
    const source = await statIfPresent(path);
    if (source?.dev === destination.dev && source.ino === destination.ino)
      throw new MediaError(`Render output must not replace input '${path}'.`);
  }
}

/** Render one compiled revision using the shared media engine. */
export async function renderCompiledVideo(
  video: CompiledVideo,
  output: string,
  { burnSubtitles = true, ...options }: VideoRenderOptions = {},
) {
  options.signal?.throwIfAborted();
  if (options.overwrite) await protectInputs(video, output, options.signal);
  return withRenderSources(video, options.signal, (plan) => {
    if (!burnSubtitles)
      plan.visualClips = plan.visualClips.filter((clip) => !clip.subtitle);
    return renderVideoTimeline({ ...plan, ...options, output });
  });
}

/** Compile and render in the calling process. Subprocesses are scoped to this call. */
export async function renderVideo(
  file: string,
  output: string,
  options: VideoRenderOptions = {},
) {
  const video = await compileVideo(file, {
    signal: options.signal,
    preview: options.burnSubtitles === false,
  });
  return renderCompiledVideo(video, output, options);
}
