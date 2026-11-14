import { watchFile, unwatchFile } from 'node:fs';
import { usesLayerTransform } from '@opencut/shared';
import { renderTimelineFrame } from '@opencut/media';
import {
  checkProjectRevision,
  projectRevision,
  subtitleTextLayers,
  subtitleFormat,
  type Project,
  type SubtitleFormat,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  checkProjectMedia,
  copyProjectFile,
  readProjectFile,
  writeSubtitleFile,
  inspectMediaFile,
  resolveMediaReference,
  resolveProjectRender,
  serveDesktopControls,
  type DesktopControlRequest,
  SessionError,
} from '@opencut/core/node';
import {
  PROJECT_CHANNELS,
  type DesktopProject,
  type ProjectReply,
  type HistoryInput,
  type ProjectViewInput,
} from '../bridge.js';

export interface ProjectDialogs {
  open(): Promise<string | null>;
  saveProjectCopy?(bundle: boolean): Promise<string | null>;
  savePreviewFrame?(): Promise<string | null>;
  exportSubtitles?(format: SubtitleFormat): Promise<string | null>;
}
interface ProjectWatch {
  path: string;
  closeControls: (() => Promise<void>) | undefined;
  changed: () => void;
  pending: boolean;
  refreshing: boolean;
}

export type ProjectAction = keyof typeof PROJECT_CHANNELS;

/** Main owns only a view of a complete committed snapshot. */
export class ProjectSession {
  private state: DesktopProject | null = null;
  private watch: ProjectWatch | undefined;
  private lifecycle = 0;
  private sequence = 0;
  private switching = false;
  private subtitleText = new WeakMap<
    Project,
    Map<string, ReturnType<typeof subtitleTextLayers>[number][number]>
  >();

  constructor(
    private readonly dialogs: ProjectDialogs,
    private readonly onChange: (
      state: DesktopProject | null,
      sequence: number,
    ) => void = () => {},
    private readonly desktopControl?: (
      control: DesktopControlRequest,
      state: DesktopProject,
    ) => Promise<unknown>,
  ) {}

  private async stopWatching(watch: ProjectWatch | undefined) {
    if (!watch) return;
    unwatchFile(watch.path, watch.changed);
    await watch.closeControls?.();
  }

  async dispose() {
    this.lifecycle++;
    const watch = this.watch;
    this.watch = undefined;
    this.state = null;
    this.onChange(null, ++this.sequence);
    await this.stopWatching(watch);
  }

  private publish(
    project: Project,
    path: string,
    media: DesktopProject['media'],
    view: number,
  ) {
    this.state = { project, path, media, view };
    this.onChange(structuredClone(this.state), ++this.sequence);
  }

  private async open(path: string) {
    const before = this.lifecycle;
    const prior = this.state;
    const project = await readProjectFile(path);
    const media = await checkProjectMedia(project, path);
    // An open at the same path reuses the control endpoint and watcher.
    if (before !== this.lifecycle) return;
    if (this.state?.path === path) {
      const current = this.state;
      if (
        current !== prior &&
        current.project.metadata.id === project.metadata.id &&
        projectRevision(current.project) > projectRevision(project)
      ) {
        this.publish(current.project, path, current.media, this.sequence + 1);
      } else {
        this.publish(project, path, media, this.sequence + 1);
      }
      const watch = this.watch;
      watch?.changed();
      if (watch) await this.connectControls(watch);
      return;
    }
    const previous = this.watch;
    const watch: ProjectWatch = {
      path,
      closeControls: undefined,
      changed: () => {
        void this.reload(watch);
      },
      pending: false,
      refreshing: false,
    };
    this.watch = watch;
    // Watch the path because commits atomically replace the underlying file.
    watchFile(path, { interval: 125, persistent: false }, watch.changed);
    this.publish(project, path, media, this.sequence + 1);
    watch.changed(); // Catch writes between the initial read and registration.
    await Promise.all([
      this.stopWatching(previous),
      this.connectControls(watch),
    ]);
  }

  private async connectControls(watch: ProjectWatch) {
    const control = this.desktopControl;
    if (!control || watch.closeControls || process.platform === 'win32') return;
    try {
      const close = await serveDesktopControls(watch.path, async (request) => {
        const snapshot = this.state;
        if (this.watch !== watch || !snapshot)
          throw new Error('Project changed. Retry in the current project.');
        return control(request, snapshot);
      });
      if (this.watch === watch) watch.closeControls = close;
      else await close();
    } catch (error) {
      // The viewer remains usable if the optional control socket cannot start.
      if (!(error instanceof SessionError) || error.code !== 'PROJECT_LOCKED')
        console.warn('Desktop review controls unavailable:', error);
    }
  }

  private async reload(watch: ProjectWatch) {
    watch.pending = true;
    if (watch.refreshing) return;
    watch.refreshing = true;
    try {
      while (watch.pending && this.watch === watch) {
        watch.pending = false;
        const prior = this.state;
        if (!prior) return;
        let project: Project;
        let media: DesktopProject['media'];
        try {
          project = await readProjectFile(watch.path);
          if (
            project.metadata.id !== prior.project.metadata.id ||
            projectRevision(project) <= projectRevision(prior.project)
          )
            continue;
          media =
            JSON.stringify(project.assets) ===
            JSON.stringify(prior.project.assets)
              ? prior.media
              : await checkProjectMedia(project, watch.path);
        } catch {
          // Keep the accepted snapshot until the file can be read again.
          continue;
        }
        if (this.watch === watch && this.state === prior && !watch.pending)
          this.publish(project, watch.path, media, prior.view);
      }
    } finally {
      watch.refreshing = false;
    }
  }

  matchesRevision(scope: { projectId: unknown; expectedRevision: unknown }) {
    const project = this.state?.project;
    return (
      !!project &&
      project.metadata.id === scope.projectId &&
      projectRevision(project) === scope.expectedRevision
    );
  }

  captureExport(input: ProjectViewInput) {
    const state = this.state;
    if (
      !state ||
      input.projectId !== state.project.metadata.id ||
      input.view !== state.view ||
      !Number.isSafeInteger(input.expectedRevision)
    )
      throw new Error('Project changed. Open the export settings again.');
    checkProjectRevision(state.project, input.expectedRevision);
    return structuredClone(state);
  }

  private scopedRequest(
    input: unknown,
    fields: string[],
    message: string,
    validFields: (request: Record<string, unknown>) => boolean,
  ) {
    const state = this.state;
    if (!state || !input || typeof input !== 'object') throw new Error(message);
    const request = input as Record<string, unknown>;
    const { projectId, expectedRevision, view } = request;
    if (
      Object.keys(request).sort().join(',') !==
        ['projectId', 'expectedRevision', 'view', ...fields].sort().join(',') ||
      projectId !== state.project.metadata.id ||
      view !== state.view ||
      !validFields(request) ||
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision)
    )
      throw new Error(message);
    checkProjectRevision(state.project, expectedRevision);
    return state;
  }

  captureText(input: HistoryInput & { clipId: string }) {
    const project = this.state?.project;
    if (
      !project ||
      project.metadata.id !== input.projectId ||
      projectRevision(project) !== input.expectedRevision
    )
      return null;
    const clip = project.clips.find((entry) => entry.id === input.clipId);
    const { width, height } = project.settings;
    if (clip?.text)
      return {
        width,
        height,
        text: clip.text,
        visual: clip.visual ?? {},
        neutral: usesLayerTransform(clip.visual?.rotation, !!clip.keyframes),
      };
    let layers = this.subtitleText.get(project);
    if (!layers) {
      layers = new Map(
        subtitleTextLayers(project)
          .flat()
          .map((layer) => [layer.id, layer]),
      );
      this.subtitleText.set(project, layers);
    }
    const layer = layers.get(input.clipId);
    return layer
      ? {
          width,
          height,
          text: layer.text,
          visual: layer.visual,
          neutral: !!layer.keyframes,
        }
      : null;
  }

  /** Resolve only an ID in the active snapshot. */
  async previewAsset(
    id: unknown,
    scope?: { projectId: unknown; expectedRevision: unknown },
  ) {
    const state = this.state;
    if (!state) throw new Error('Open a project with imported video first.');
    if (scope && !this.matchesRevision(scope))
      throw new Error('Timeline project changed.');
    if (typeof id !== 'string') throw new Error('Expected a media asset ID.');
    const asset = state.project.assets.find((asset) => asset.id === id);
    if (!asset) throw new Error('Video asset is not in the current project.');
    const path = resolveMediaReference(asset.file, state.path);
    const availability = await inspectMediaFile(path);
    if (availability.status !== 'available')
      throw new Error(availability.message);
    if (this.state !== state)
      throw new Error(
        'Project changed while opening the preview. Select the asset again.',
      );
    return { asset, path };
  }

  async run(action: ProjectAction, input?: unknown): Promise<ProjectReply> {
    let notice: string | undefined;
    let canceled = false;
    try {
      switch (action) {
        case 'current':
          break;
        case 'open': {
          if (this.switching) throw new Error('A project is already opening.');
          this.switching = true;
          const generation = this.lifecycle;
          try {
            const selected = await this.dialogs.open();
            const path = selected && (await canonicalProjectFilePath(selected));
            if (path && generation === this.lifecycle) await this.open(path);
            else canceled = true;
          } finally {
            this.switching = false;
          }
          break;
        }
        case 'close':
          if (this.switching) throw new Error('Wait for the project to open.');
          await this.dispose();
          break;
        case 'exportSubtitles': {
          const state = this.scopedRequest(
            input,
            ['format'],
            'Invalid subtitle export request.',
            ({ format }) => format === 'srt' || format === 'vtt',
          );
          const { format } = input as { format: SubtitleFormat };
          const file = await this.dialogs.exportSubtitles?.(format);
          if (!file) {
            canceled = true;
            break;
          }
          if (subtitleFormat(file) !== format)
            throw new Error('Use the selected subtitle extension.');
          const output = await writeSubtitleFile(
            file,
            state.project.subtitles?.cues ?? [],
          );
          notice =
            'Exported ' + output.cueCount + ' subtitle cues to ' + output.path;
          break;
        }
        case 'exportFrame': {
          const state = this.scopedRequest(
            input,
            ['at'],
            'Invalid frame export request.',
            ({ at }) =>
              typeof at === 'number' && Number.isSafeInteger(at) && at >= 0,
          );
          const { at } = input as { at: number };
          const path = await this.dialogs.savePreviewFrame?.();
          if (!path) {
            canceled = true;
            break;
          }
          const plan = await resolveProjectRender(state.project, state.path);
          const frame = await renderTimelineFrame({
            ...plan,
            output: path,
            range: { startFrame: at, endFrame: at + 1 },
          });
          notice = `Saved frame to ${frame.path}`;
          break;
        }
        case 'copyProject': {
          const state = this.scopedRequest(
            input,
            ['bundle'],
            'Invalid project copy request.',
            ({ bundle }) => typeof bundle === 'boolean',
          );
          const { bundle } = input as { bundle: boolean };
          const path = await this.dialogs.saveProjectCopy?.(bundle);
          if (!path) {
            canceled = true;
            break;
          }
          const result = await copyProjectFile(
            state.project,
            state.path,
            path,
            bundle,
          );
          notice = `Saved revision ${result.revision} to ${result.path}`;
          break;
        }
      }
      return {
        ok: true,
        state: structuredClone(this.state),
        sequence: this.sequence,
        canceled,
        ...(notice && { notice }),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
