import { randomUUID } from 'node:crypto';
import { watchVideo } from '@opencut/core/node';
import type { DefinitionReview } from '../bridge.js';

export class DefinitionReviewSession {
  private controller: AbortController | undefined;
  private work: Promise<void> = Promise.resolve();
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
            if (current && ready?.generation !== current.generation) {
              const url =
                this.media?.path === current.playback.path
                  ? this.media.url
                  : `opencut://media/${randomUUID()}.mp4`;
              this.media = { url, path: current.playback.path };
              ready = {
                generation: current.generation,
                sourceRevision: current.sourceRevision,
                project: current.video.project,
                frameCount: current.video.frameCount,
                url,
              };
            }
            this.send({ path, ...status, current: ready });
          },
        });
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

  close() {
    this.controller?.abort();
    this.controller = undefined;
    this.media = undefined;
    this.send(null);
    return this.work;
  }
}
