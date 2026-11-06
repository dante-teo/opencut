import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveProjectRender } from '@opencut/core/node';
import { projectRevision } from '@opencut/core';
import {
  renderVideoTimeline,
  validateVideoTimeline,
  renderCodecs,
  renderQualities,
  renderResolutions,
} from '@opencut/media';
import type { DesktopProject, ExportInput, ExportState } from '../bridge.js';
import { exportRates } from '../export-settings.js';

function parseInput(input: unknown): ExportInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid export request.');
  const value = input as ExportInput;
  const settings = value.settings;
  if (
    Object.keys(value).sort().join(',') !==
      'expectedRevision,projectId,settings' ||
    typeof value.projectId !== 'string' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).sort().join(',') !==
      'codec,frameRate,quality,resolution' ||
    !renderCodecs.includes(settings.codec) ||
    !renderQualities.includes(settings.quality) ||
    !renderResolutions.includes(settings.resolution) ||
    !exportRates.includes(settings.frameRate)
  )
    throw new Error('Invalid export settings.');
  return structuredClone(value);
}

/** One foreground export, independent of selection, playback and later session edits. */
export class ExportSession {
  private state: ExportState | null = null;
  private output: string | null = null;
  private choosing = false;
  private controller: AbortController | null = null;
  private work: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(
    private readonly capture: (input: ExportInput) => DesktopProject,
    private readonly choose: () => Promise<string | null>,
    private readonly changed: (state: ExportState) => void,
  ) {}
  get active() {
    return (
      !!this.state &&
      ['validating', 'rendering', 'verifying', 'cancelling'].includes(
        this.state.status,
      )
    );
  }
  current() {
    return structuredClone(this.state);
  }
  private publish() {
    if (this.state) this.changed(structuredClone(this.state));
  }
  async chooseOutput() {
    if (this.active || this.choosing || this.closing)
      throw new Error('An export operation is already in progress.');
    this.choosing = true;
    try {
      const path = await this.choose();
      if (this.closing) return null;
      if (path !== null) {
        if (
          !isAbsolute(path) ||
          path.length > 32768 ||
          Array.from(path).some((character) => character.charCodeAt(0) < 32)
        )
          throw new Error('Choose a valid absolute output path.');
        this.output = path;
      }
      return path;
    } finally {
      this.choosing = false;
    }
  }
  start(input: unknown) {
    if (this.active || this.choosing || this.closing)
      throw new Error('An export operation is already in progress.');
    const request = parseInput(input);
    if (!this.output) throw new Error('Choose an output file first.');
    // Capture before the first await; even unsaved documents export this exact revision.
    const snapshot = structuredClone(this.capture(request));
    const controller = new AbortController();
    this.controller = controller;
    this.state = {
      id: randomUUID(),
      projectId: snapshot.project.metadata.id,
      projectName: snapshot.project.metadata.name,
      revision: projectRevision(snapshot.project),
      output: this.output,
      settings: request.settings,
      status: 'validating',
      progress: null,
      elapsedSeconds: 0,
      summary: null,
      error: '',
    };
    this.publish();
    this.work = this.execute(snapshot, this.state, controller);
    return this.current()!;
  }
  private async execute(
    snapshot: DesktopProject,
    job: ExportState,
    controller: AbortController,
  ) {
    const started = performance.now();
    let validated = false;
    let lastProgress = 0;
    try {
      const plan = await resolveProjectRender(
        snapshot.project,
        snapshot.path ?? resolve('Untitled.opencut.json'),
      );
      const [numerator, denominator = 1] = job.settings.frameRate
        .split('/')
        .map(Number);
      const options = {
        ...plan,
        output: job.output,
        quality: job.settings.quality,
        resolution: job.settings.resolution,
        codec: job.settings.codec,
        ...(job.settings.frameRate === 'project'
          ? {}
          : { outputFrameRate: { numerator: numerator!, denominator } }),
        overwrite: false,
        signal: controller.signal,
      };
      job.summary = await validateVideoTimeline(options);
      validated = true;
      if (controller.signal.aborted) throw new Error('Export cancelled.');
      job.status = 'rendering';
      this.publish();
      await renderVideoTimeline({
        ...options,
        onProgress: (progress) => {
          const now = performance.now();
          const phaseChanged = job.status !== progress.phase;
          if (controller.signal.aborted) return;
          job.status = progress.phase;
          job.progress = progress;
          job.elapsedSeconds = (now - started) / 1000;
          if (phaseChanged || now - lastProgress >= 200) {
            lastProgress = now;
            this.publish();
          }
        },
      });
      // A completed atomic publication wins a cancellation racing after finalization.
      job.status = 'succeeded';
    } catch (error) {
      job.status = controller.signal.aborted
        ? 'cancelled'
        : validated
          ? 'failed'
          : 'validation_failed';
      job.error =
        job.status === 'cancelled'
          ? ''
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      job.elapsedSeconds = (performance.now() - started) / 1000;
      this.controller = null;
      this.publish();
    }
  }
  cancel(id: unknown) {
    if (typeof id !== 'string' || id !== this.state?.id)
      throw new Error('Export job changed.');
    if (this.active) {
      this.state!.status = 'cancelling';
      this.controller?.abort();
      this.publish();
    }
    return this.current();
  }
  async cancelAndWait() {
    if (this.active) this.cancel(this.state!.id);
    await this.work;
  }
  async dispose() {
    this.closing = true;
    await this.cancelAndWait();
  }
}
