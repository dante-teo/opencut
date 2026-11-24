import type { VideoMixEdit } from '@opencut/shared';
import { openAudioMixCache } from './video-audio-mix.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { renderVideoTimeline } from '@opencut/media';
import { withRenderSources } from './render-sources.js';
import type { RenderQuality, VideoTimelineResult } from '@opencut/media';
import { compileVideoInput } from './video-files.js';
import {
  isVideoDefinitionPath,
  VideoDefinitionError,
} from './video-definition.js';
import type { CompiledVideo } from './video-compiler.js';
import type { VideoSourceProbes } from './video-assets.js';
import {
  copyVideoInput,
  identifyVideoInput,
  videoInputIdentity,
} from './video-input.js';
import type { VideoInput } from './video-input.js';
import type { VideoProcessingOptions } from './video-processing.js';
import { openPictureCache } from './video-picture-cache.js';
import type { MusicSelection } from './music-comparison.js';

export interface VideoWatchRevision {
  readonly generation: number;
  readonly sourceRevision: string;
  readonly dialogueMixRevision: string;
  readonly video: CompiledVideo;
  readonly playback: Readonly<VideoTimelineResult>;
}

export type VideoWatchStatus = {
  generation: number;
  current: VideoWatchRevision | null;
} & (
  | { status: 'compiling' | 'rendering' | 'ready' }
  | { status: 'error'; error: string }
);

export interface VideoWatchOptions {
  onStatus: (status: VideoWatchStatus) => void;
  maxDimension?: number;
  quality?: RenderQuality | undefined;
  processing?: VideoProcessingOptions;
  signal?: AbortSignal;
  params?: unknown;
  audioMixEdit?: VideoMixEdit | undefined;
  audioComparison?: 'before' | 'after' | undefined;
  audioMixCacheDirectory?: string | undefined;
  musicSelection?: MusicSelection | undefined;
}

type Published = {
  revision: VideoWatchRevision;
  inputs: Map<string, VideoInput>;
  media: Set<string>;
  renderKey: string;
  pictureKey?: string;
};

/** Watch only inputs of the selected definition, retaining one playable revision. */
export async function watchVideo(file: string, options: VideoWatchOptions) {
  const path = resolve(file);
  if (!isVideoDefinitionPath(path))
    throw new VideoDefinitionError('Expected a .video.ts file.');
  options.signal?.throwIfAborted();

  const directory = await mkdtemp(join(tmpdir(), 'opencut-video-'));
  const watched = new Map([[path, videoInputIdentity(path)]]);
  const snapshots = new Map<string, string>();
  const probes: VideoSourceProbes = new Map();
  const settings = {
    maxDimension: options.maxDimension ?? 640,
    quality: options.quality ?? 'fast',
  };
  const params = structuredClone(options.params);
  let audioMixEdit = options.audioMixEdit;
  let audioComparison = options.audioComparison;
  let interactiveMusicSelection: MusicSelection | undefined;
  const renders = new Map<Promise<unknown>, Set<string>>();
  let published: Published | undefined;
  let active: AbortController | undefined;
  let generation = 0;
  let work = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;

  function emit(
    status: VideoWatchStatus['status'],
    generation: number,
    error?: unknown,
  ) {
    const current = published?.revision ?? null;
    const event: VideoWatchStatus =
      status === 'error'
        ? {
            status,
            generation,
            current,
            error: error instanceof Error ? error.message : String(error),
          }
        : { status, generation, current };
    try {
      options.onStatus(event);
    } catch (error) {
      process.emitWarning(
        `OpenCut preview status listener failed: ${String(error)}`,
      );
    }
  }

  function schedule() {
    if (closing) return;
    active?.abort();
    clearTimeout(debounce);
    const next = ++generation;
    // Let truncate/rewrite and rename-based saves settle before executing code.
    debounce = setTimeout(() => {
      work = work.then(async () => {
        if (closing || next !== generation) return;
        active = new AbortController();
        try {
          await rebuild(next, active.signal);
        } catch (error) {
          if (!closing && next === generation) emit('error', next, error);
        } finally {
          active = undefined;
          await pruneSnapshots();
        }
      });
    }, 180);
    emit('compiling', next);
  }

  function refreshInputs() {
    let changed = false;
    for (const [file, previous] of watched) {
      const identity = videoInputIdentity(file);
      if (identity === previous) continue;
      watched.set(file, identity);
      changed = true;
    }
    return changed;
  }

  function isCurrent(next: number, inputs: Map<string, VideoInput>) {
    if (closing || next !== generation) return false;
    // A write can land between polls, including after the encoder finishes.
    const changed = refreshInputs();
    if (
      changed ||
      [...inputs.values()].some(
        ({ path, identity }) => watched.get(path) !== identity,
      )
    ) {
      schedule();
      return false;
    }
    return true;
  }

  async function rebuild(next: number, signal: AbortSignal) {
    const inputs = new Map<string, VideoInput>();
    const media = new Set<string>();
    const output = join(directory, `revision-${next}.mp4`);
    const comparison = audioComparison;
    const override = interactiveMusicSelection;
    let resolvedOverride = override;
    const record = (input: VideoInput) => {
      if (!inputs.has(input.path)) inputs.set(input.path, input);
      if (!watched.has(input.path)) watched.set(input.path, input.identity);
    };
    try {
      const video = await compileVideoInput(path, {
        preview: true,
        quality: settings.quality,
        signal,
        probes,
        params,
        processing: options.processing,
        audioMixEdit,
        musicSelection: options.musicSelection,
        ...(override && {
          resolveMusicSelection(music) {
            if (!music) {
              // Clear the interactive choice without restoring the startup override.
              resolvedOverride = {};
              return;
            }
            resolvedOverride = {
              matchLoudness: override.matchLoudness,
              candidate: music.candidates.some(
                ({ trackId }) => trackId === override.candidate,
              )
                ? override.candidate
                : undefined,
            };
            return resolvedOverride;
          },
        }),
        scriptWorker: {},
        inputs: {
          record,
          async snapshotMedia(file, kind = 'media') {
            const canonical = await realpath(file).catch(() => file);
            const input = identifyVideoInput(canonical, kind);
            record(input);
            if (input.identity === null)
              throw new VideoDefinitionError(
                `Cannot snapshot media '${file}': expected a readable regular file.`,
              );
            const key = JSON.stringify([canonical, input.identity]);
            let snapshot = snapshots.get(key);
            if (!snapshot) {
              snapshot = join(directory, randomUUID() + extname(canonical));
              try {
                await copyVideoInput(
                  canonical,
                  input.identity,
                  snapshot,
                  signal,
                );
              } catch (cause) {
                await rm(snapshot, { force: true });
                throw new VideoDefinitionError(
                  `Cannot snapshot media '${file}': ${cause instanceof Error ? cause.message : String(cause)}`,
                  { cause },
                );
              }
              snapshots.set(key, snapshot);
            }
            media.add(key);
            return snapshot;
          },
        },
      });
      if (!isCurrent(next, inputs)) return;

      const hash = createHash('sha256').update(JSON.stringify(video.project));
      const { musicComparison, ...mixProject } = video.project;
      // Music audition controls leave the editable dialogue mix draft in place.
      const mixHash = musicComparison
        ? createHash('sha256').update(JSON.stringify(mixProject))
        : undefined;
      const ordered = [...inputs.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      for (const input of ordered) {
        const identity = JSON.stringify(input);
        hash.update(identity);
        mixHash?.update(identity);
        if (input.kind === 'source') {
          const contents = await readFile(input.path, { signal });
          hash.update(contents);
          mixHash?.update(contents);
        }
      }
      const sourceRevision = hash.digest('hex');
      const dialogueMixRevision = mixHash?.digest('hex') ?? sourceRevision;
      const plan = await video.resolveRender();
      if (!isCurrent(next, inputs)) return;

      // The bound paths identify immutable media copies. Edits that leave
      // the composition unchanged can publish a new revision with the same MP4.
      const renderKey = createHash('sha256')
        .update(JSON.stringify([plan, settings, comparison]))
        .digest('hex');
      const pictureKey =
        plan.musicComparison &&
        !plan.visualClips.some(({ graphic }) => graphic?.audioAnalysis) &&
        createHash('sha256')
          .update(
            JSON.stringify([
              plan.width,
              plan.height,
              plan.backgroundColor,
              plan.frameRate,
              plan.frameCount,
              plan.visualClips,
              plan.visualTransitions,
              plan.visualGroups,
              settings,
            ]),
          )
          .digest('hex');
      let playback =
        published?.renderKey === renderKey
          ? published.revision.playback
          : undefined;
      if (!playback) {
        emit('rendering', next);
        const audioMixCache =
          video.project.professionalMix?.ai &&
          video.project.professionalMix.enabled !== false
            ? await openAudioMixCache(
                options.audioMixCacheDirectory ?? directory,
                signal,
              )
            : undefined;
        const pictureCache = pictureKey
          ? await openPictureCache(directory, video, signal)
          : undefined;
        const previousPicture =
          pictureKey && pictureKey === published?.pictureKey
            ? published.revision.playback.pictureVersion?.id
            : undefined;
        playback = await withRenderSources(
          video,
          signal,
          (bound) =>
            renderVideoTimeline({
              ...bound,
              ...settings,
              audioComparison: comparison,
              ...(audioMixCache && { audioMixCache }),
              ...(pictureCache && {
                pictureCache,
                pictureVersion: previousPicture ?? 'save',
              }),
              output,
              signal,
            }),
          { audioComparison: comparison, pinnedPlan: plan },
        );
      }

      if (!isCurrent(next, inputs)) return;
      interactiveMusicSelection = resolvedOverride;
      const previous = published?.revision.playback.path;
      const revision = Object.freeze({
        generation: next,
        sourceRevision,
        dialogueMixRevision,
        video,
        playback: Object.freeze(playback),
      });
      published = {
        revision,
        inputs,
        media,
        renderKey,
        ...(pictureKey && { pictureKey }),
      };
      emit('ready', next);
      if (previous && previous !== playback.path)
        await rm(previous, { force: true });
    } catch (error) {
      if (isCurrent(next, inputs)) emit('error', next, error);
    } finally {
      if (next === generation) {
        for (const file of watched.keys()) {
          if (
            file !== path &&
            !published?.inputs.has(file) &&
            !inputs.has(file)
          )
            watched.delete(file);
        }
      }
      if (published?.revision.playback.path !== output)
        await rm(output, { force: true });
    }
  }

  async function pruneSnapshots() {
    if (closing || active) return;
    const retained = [...renders.values()];
    const unused: string[] = [];
    for (const [key, snapshot] of snapshots) {
      if (published?.media.has(key) || retained.some((media) => media.has(key)))
        continue;
      snapshots.delete(key);
      probes.delete(snapshot);
      unused.push(snapshot);
    }
    // Remove entries before yielding so a subsequent build cannot reuse them.
    await Promise.all(unused.map((path) => rm(path, { force: true }))).catch(
      (error: unknown) =>
        process.emitWarning(
          `OpenCut could not remove preview media: ${String(error)}`,
        ),
    );
  }

  // Poll exact paths, including missing imports. No directory enumeration is needed.
  const poll = setInterval(() => {
    if (refreshInputs()) schedule();
  }, 100);

  function close(): Promise<void> {
    if (closing) return closing;
    options.signal?.removeEventListener('abort', abort);
    clearTimeout(debounce);
    clearInterval(poll);
    active?.abort();
    closing = work.finally(async () => {
      await Promise.allSettled(renders.keys());
      await rm(directory, { recursive: true, force: true });
    });
    return closing;
  }

  function abort() {
    void close().catch(console.error);
  }

  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) await close();
  else schedule();
  // Keep media snapshots alive if a newer revision arrives during export.
  async function withCurrent<T>(
    generation: number,
    run: (video: CompiledVideo) => Promise<T>,
  ): Promise<T> {
    if (closing || !published || published.revision.generation !== generation)
      throw new VideoDefinitionError(
        'The preview changed. Start export again.',
      );
    const { revision, media } = published;
    const render = Promise.resolve().then(() => run(revision.video));
    renders.set(render, media);
    try {
      return await render;
    } finally {
      renders.delete(render);
      await pruneSnapshots();
    }
  }

  function setAudioMix(
    edit: VideoMixEdit | undefined,
    comparison: 'after' | 'before' = 'after',
  ) {
    audioMixEdit = edit;
    audioComparison = comparison;
    schedule();
  }

  function selectMusic(selection: MusicSelection) {
    interactiveMusicSelection = {
      ...(interactiveMusicSelection ?? options.musicSelection),
      ...selection,
    };
    schedule();
  }

  return {
    path,
    close,
    withCurrent,
    setAudioMix,
    selectMusic,
    refresh: schedule,
  };
}
