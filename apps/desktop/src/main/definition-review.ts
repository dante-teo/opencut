import { randomUUID } from 'node:crypto';
import {
  describeMotionGraphics,
  describeMusicComparison,
  validateMotionSplit,
  watchVideo,
} from '@opencut/core/video';
import type {
  MotionEdit,
  MusicSelection,
  VideoMixEdit,
} from '@opencut/core/video';
import type { DefinitionReview } from '../bridge.js';

export class DefinitionReviewSession {
  private controller: AbortController | undefined;
  private work: Promise<void> = Promise.resolve();
  private watcher: Awaited<ReturnType<typeof watchVideo>> | undefined;
  private motionRevision:
    { generation: number; controller: AbortController } | undefined;
  private media: { url: string; path: string } | undefined;

  constructor(
    private readonly send: (state: DefinitionReview | null) => void,
  ) {}

  resolveMedia(url: string) {
    return url === this.media?.url ? this.media.path : undefined;
  }

  open(path: string) {
    this.controller?.abort();
    this.media = undefined;
    this.watcher = undefined;
    this.motionRevision = undefined;
    const controller = new AbortController();
    this.controller = controller;
    this.send({ path, generation: 0, status: 'compiling', current: null });
    this.work = this.work.then(async () => {
      if (controller.signal.aborted) return;
      try {
        let ready: DefinitionReview['current'] = null;
        const watcher = await watchVideo(path, {
          signal: controller.signal,
          onStatus: ({ current, ...status }) => {
            if (controller.signal.aborted) return;
            const generation =
              status.status === 'ready' ? current?.generation : undefined;
            if (this.motionRevision?.generation !== generation) {
              this.motionRevision?.controller.abort(
                new Error('The preview changed. Start the motion edit again.'),
              );
              this.motionRevision =
                generation === undefined
                  ? undefined
                  : { generation, controller: new AbortController() };
            }
            if (current && ready?.generation !== current.generation) {
              const url =
                this.media?.path === current.playback.path
                  ? this.media.url
                  : `opencut://media/${randomUUID()}.mp4`;
              this.media = { url, path: current.playback.path };
              const musicComparison = describeMusicComparison(
                current.video.project,
              );
              ready = {
                generation: current.generation,
                sourceRevision: current.sourceRevision,
                dialogueMixRevision: current.dialogueMixRevision,
                project: current.video.project,
                frameCount: current.video.frameCount,
                motionGraphics: describeMotionGraphics(current.video),
                ...(current.playback.audioMix && {
                  audioMix: current.playback.audioMix,
                }),
                ...(musicComparison && { musicComparison }),
                url,
              };
            }
            this.send({ path, ...status, current: ready });
          },
        });
        if (!controller.signal.aborted) this.watcher = watcher;
        if (!controller.signal.aborted)
          await new Promise<void>((done) =>
            controller.signal.addEventListener('abort', () => done(), {
              once: true,
            }),
          );
        await watcher.close();
      } catch (error) {
        if (!controller.signal.aborted)
          this.send({
            path,
            generation: 0,
            status: 'error',
            current: null,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    });
  }

  async applyMix(generation: number, edit: VideoMixEdit | null) {
    const watcher = this.watcher;
    if (!watcher) throw new Error('Open a definition with a valid preview.');
    await watcher.withCurrent(generation, async () => {
      watcher.setAudioMix(edit ?? undefined);
    });
  }

  async compareMix(generation: number, comparison: 'before' | 'after') {
    const watcher = this.watcher;
    if (!watcher) throw new Error('Open a definition with a valid preview.');
    await watcher.withCurrent(generation, async (video) => {
      watcher.setAudioMix(video.audioMixEdit, comparison);
    });
  }

  async selectMusic(generation: number, selection: MusicSelection) {
    const watcher = this.watcher;
    if (!watcher) throw new Error('Open a definition with a valid preview.');
    await watcher.withCurrent(generation, async (video) => {
      const comparison = video.project.musicComparison;
      if (
        !comparison ||
        (selection.candidate &&
          !comparison.candidates.some(
            ({ trackId }) => trackId === selection.candidate,
          ))
      )
        throw new Error(
          'Select a music candidate declared in the current definition.',
        );
      watcher.selectMusic(selection);
    });
  }

  exportRevision<T>(
    generation: number,
    run: (video: import('@opencut/core/video').CompiledVideo) => Promise<T>,
  ): Promise<T> {
    if (!this.watcher)
      throw new Error('Open a definition with a valid preview.');
    return this.watcher.withCurrent(generation, run);
  }

  prepareMotionEdit(generation: number, edit: MotionEdit) {
    const session = this.controller;
    const revision = this.motionRevision;
    if (!session || revision?.generation !== generation)
      throw new Error('The preview changed. Start the motion edit again.');
    const closed = session.signal;
    const signal = AbortSignal.any([closed, revision.controller.signal]);
    return this.exportRevision(generation, async (video) => {
      signal.throwIfAborted();
      if (edit.operation === 'split')
        validateMotionSplit(video, edit.clip, edit.at);
      return { path: video.path, closed, signal };
    });
  }

  refresh() {
    this.watcher?.refresh();
  }

  close() {
    this.controller?.abort();
    this.controller = undefined;
    this.media = undefined;
    this.watcher = undefined;
    this.motionRevision = undefined;
    this.send(null);
    return this.work;
  }
}
