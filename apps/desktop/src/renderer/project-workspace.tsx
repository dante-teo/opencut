import type { AnimatedProperty } from '@opencut/shared';
import { useEffect, useRef, useState } from 'react';
import { Undo2, Redo2, FolderOpen, Plus, Save } from 'lucide-react';
import { ExportPanel } from './export-panel.js';
import { StudioArtwork } from './studio-graphics.js';
import type {
  DesktopProject,
  ProjectReply,
  TimelineOperation,
} from '../bridge.js';
import { Preview } from './video-preview.js';
import { TimelinePreview, type TimelineTransport } from './timeline-preview.js';
import {
  clipTimelineEnd,
  copyClips,
  linkedSelection,
  type ClipClipboard,
  compareTimes,
  addTimes,
  type SubtitleFormat,
  projectRevision,
  type RationalTime,
} from '@opencut/core';
import {
  sourceToTimeline,
  timelineToSource,
  ZERO,
  frameIndex,
  framePosition,
} from './timeline-geometry.js';
import { ProjectTimeline } from './project-timeline.js';
import { MediaLibrary } from './media-library.js';
import { ProjectInspector } from './project-inspector.js';
import {
  shortcutAction,
  shortcutOwnsKeys,
  type TimelineAction,
} from './shortcuts.js';
import type { PreviewTransport } from './video-preview.js';

export function ProjectWorkspace() {
  const [state, setState] = useState<DesktopProject | null>(null);
  const [busy, setBusy] = useState('Loading project…');
  const [propertyBusy, setPropertyBusy] = useState(false);
  const blocking = !!busy && !propertyBusy;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const operationTail = useRef(Promise.resolve());
  const stateRef = useRef(state);
  const transport = useRef<PreviewTransport | null>(null);
  const projectTransport = useRef<TimelineTransport | null>(null);
  const formDialog = useRef<HTMLDialogElement>(null);
  const [viewer, setViewer] = useState<'project' | 'source'>('project');
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [previewSession, setPreviewSession] = useState(0);
  const [timelineSession, setTimelineSession] = useState(0);
  const [keyframeProperty, setKeyframeProperty] =
    useState<AnimatedProperty>('x');
  const [playhead, setPlayhead] = useState<RationalTime>(ZERO);
  const [linkedClipId, setLinkedClipId] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<number | undefined>();
  const [previewSeekRequest, setPreviewSeekRequest] = useState(0);
  const linkedClip = state?.project.clips.find(
    (clip) => clip.id === linkedClipId,
  );
  function seekTimeline(time: RationalTime) {
    // Update the clock synchronously, before an animation callback can echo an old position.
    projectTransport.current?.seek(time);
    setPlayhead(time);
    if (!linkedClip) return;
    const sourceTime = timelineToSource(linkedClip, time);
    if (sourceTime === undefined) {
      setViewer('project');
      setLinkedClipId(null);
      setPreviewPosition(undefined);
    } else {
      setPreviewPosition(sourceTime);
      setPreviewSeekRequest((value) => value + 1);
    }
  }

  const sourceViewer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sourceViewer.current) sourceViewer.current.scrollTop = 0;
  }, [previewRequest, previewSession]);
  const [selection, setSelection] = useState<{
    kind: 'asset' | 'clip';
    id: string;
    ids?: string[];
  } | null>(null);
  const clipboard = useRef<{
    path: string | null;
    content: ClipClipboard;
  } | null>(null);
  function selectAsset(id: string) {
    setSelection({ kind: 'asset', id });
    setLinkedClipId(null);
    setPreviewPosition(undefined);
    setPreviewAssetId(id);
    setPreviewRequest((value) => value + 1);
    setViewer('source');
  }
  useEffect(() =>
    window.opencut.onDesktopControl((control) => {
      const project = stateRef.current?.project;
      if (!project) return;
      switch (control.action) {
        case 'select':
          if (!control.id) setSelection(null);
          else if (control.kind === 'asset') selectAsset(control.id);
          else setSelection({ kind: 'clip', id: control.id });
          break;
        case 'viewer':
          setViewer(control.viewer);
          break;
        case 'status':
          return {
            viewer,
            selection,
            frame: Number(frameIndex(playhead, project.settings.frameRate)),
            preview: projectTransport.current?.status(),
          };
        case 'source-seek':
          if (viewer !== 'source' || !transport.current?.seekSeconds)
            throw new Error('Open a timed source in the source viewer first.');
          transport.current.seekSeconds(control.seconds);
          break;
        case 'step':
          (viewer === 'source'
            ? transport.current
            : projectTransport.current
          )?.step(control.direction);
          break;
        case 'live-preview':
          projectTransport.current?.livePreview();
          break;
        case 'seek':
          seekTimeline(
            framePosition(BigInt(control.frame), project.settings.frameRate),
          );
          break;
        case 'render-preview':
          setViewer('project');
          projectTransport.current?.renderPreview();
          break;
        case 'play':
        case 'pause':
          if (viewer === 'source')
            transport.current?.setPlaying?.(control.action === 'play');
          else projectTransport.current?.setPlaying(control.action === 'play');
          break;
        case 'toggle':
          (viewer === 'source'
            ? transport.current
            : projectTransport.current
          )?.toggle();
          break;
      }
      return null;
    }),
  );

  function run(
    label: string,
    operation: () => Promise<ProjectReply>,
    editing: boolean | 'properties' = false,
  ) {
    const next = operationTail.current.then(() =>
      perform(label, operation, editing),
    );
    operationTail.current = next;
    return next;
  }
  async function perform(
    label: string,
    operation: () => Promise<ProjectReply>,
    editing: boolean | 'properties' = false,
  ) {
    setBusy(label);
    setPropertyBusy(editing === 'properties');
    setError('');
    setNotice('');
    try {
      const before = stateRef.current;
      const reply = await operation();
      if (!reply.ok) setError(reply.error);
      else {
        // Only a snapshot pushed during this request can supersede its reply.
        // Opening an older backup may legitimately reduce the revision.
        const latest = stateRef.current;
        if (!(
          latest &&
          latest !== before &&
          reply.state &&
          latest.path === reply.state.path &&
          latest.project.metadata.id === reply.state.project.metadata.id &&
          projectRevision(latest.project) > projectRevision(reply.state.project)
        )) {
          setState(reply.state);
          stateRef.current = reply.state;
        }
        if (!reply.canceled) {
          setCreating(false);
          if (
            label !== 'Saving project…' &&
            label !== 'Exporting subtitles…' &&
            label !== 'Exporting frame…' &&
            label !== 'Saving snapshot…' &&
            label !== 'Packaging project…' &&
            !editing
          ) {
            clipboard.current = null;
            setSelection(null);
            setPlayhead(ZERO);
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setPreviewAssetId(null);
            setPreviewSession((value) => value + 1);
            setTimelineSession((value) => value + 1);
          }
          if (
            label === 'Saving project…' &&
            before?.path === null &&
            reply.state?.path &&
            clipboard.current?.content.projectId ===
              reply.state.project.metadata.id
          )
            clipboard.current.path = reply.state.path;
          if (editing) {
            const next = reply.state?.project;
            // Retain the selection ID while absent so undo restores selection too.
            if (
              previewAssetId &&
              !next?.assets.some((asset) => asset.id === previewAssetId)
            ) {
              setPreviewAssetId(null);
              setPreviewSession((value) => value + 1);
            }
            // Pause/unlink the source on edits so its old clock cannot overwrite
            // the project playhead after moving, trimming, deleting or restoring.
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setViewer('project');
          }
          if (reply.clipboard)
            clipboard.current = {
              path: reply.state?.path ?? null,
              content: reply.clipboard,
            };
          setNotice(
            reply.notice ??
              (reply.clipboard
                ? 'Clips cut.'
                : label === 'Saving project…'
                  ? 'Project saved.'
                  : ''),
          );
        }
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
      setPropertyBusy(false);
    }
  }

  useEffect(
    () =>
      window.opencut.onImportProgress((progress) => {
        setBusy(
          `Importing ${progress.completed}/${progress.total} · ${progress.name}`,
        );
      }),
    [],
  );
  useEffect(() => {
    const prevent = (event: DragEvent) => {
      event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
  useEffect(() => {
    return window.opencut.onProjectChanged((next) => {
      const current = stateRef.current;
      if (
        current &&
        next &&
        current.path === next.path &&
        current.project.metadata.id === next.project.metadata.id &&
        projectRevision(current.project) > projectRevision(next.project)
      )
        return;
      stateRef.current = next;
      setState(next);
      setLinkedClipId(null);
      setPreviewPosition(undefined);
      setPreviewAssetId(null);
      setPreviewSession((value) => value + 1);
      setViewer('project');
    });
  }, []);
  useEffect(() => {
    void run('Loading project…', () => window.opencut.getProject());
  }, []);
  useEffect(() => {
    document.title = state
      ? `${state.dirty ? '● ' : ''}${state.project.metadata.name} — OpenCut`
      : 'OpenCut';
  }, [state]);
  useEffect(() => {
    const dialog = formDialog.current;
    if (creating && !dialog?.open) dialog?.showModal();
    else if (!creating && dialog?.open) dialog.close();
  }, [creating]);
  const project = state?.project;
  const selectedIds =
    selection?.kind === 'clip' && project
      ? linkedSelection(project, selection.ids ?? [selection.id]).map(
          (clip) => clip.id,
        )
      : [];
  const selectedClip = selection?.kind === 'clip' ? selection.id : null;
  function selectClip(id: string, mode?: 'toggle' | 'range') {
    const clicked = project?.clips.find((clip) => clip.id === id);
    if (!mode || !project || !clicked) {
      setSelection({ kind: 'clip', id });
      return;
    }
    const members = linkedSelection(project, [id]).map((clip) => clip.id);
    const ids = new Set(selectedIds);
    if (mode === 'range') {
      const first = project.clips.find((clip) => clip.id === selectedClip);
      if (first?.trackId === clicked.trackId) {
        const [low, high] = [first.timelineStart, clicked.timelineStart].sort(
          compareTimes,
        );
        for (const clip of project.clips)
          if (
            clip.trackId === clicked.trackId &&
            compareTimes(clip.timelineStart, low!) >= 0 &&
            compareTimes(clip.timelineStart, high!) <= 0
          )
            ids.add(clip.id);
      }
      for (const member of members) ids.add(member);
    } else if (ids.has(id)) {
      for (const member of members) ids.delete(member);
    } else {
      for (const member of members) ids.add(member);
    }
    const primary = ids.has(id) ? id : [...ids].at(-1);
    setSelection(primary ? { kind: 'clip', id: primary, ids: [...ids] } : null);
  }

  function timelineAction(action: TimelineAction) {
    if (!project || busy) return;
    const at = Number(frameIndex(playhead, project.settings.frameRate, true));
    const ids = selectedIds;
    const send = (operation: TimelineOperation, label: string) =>
      void edit([operation], label);
    switch (action) {
      case 'delete':
      case 'split': {
        if (!selectedClip) return;
        const cue = project.subtitles?.cues.find(
          (cue) => cue.id === selectedClip,
        );
        if (cue) {
          if (action === 'delete')
            send({ type: 'subtitle.remove', id: cue.id }, 'Delete subtitle');
          else if (
            compareTimes(playhead, cue.start) > 0 &&
            compareTimes(playhead, cue.end) < 0
          )
            send(
              { type: 'subtitle.split', id: cue.id, at: playhead },
              'Split subtitle',
            );
          return;
        }
        if (action === 'delete') {
          if (ids.length)
            send(
              { type: 'clips.remove', ids },
              ids.length === 1 ? 'Delete clip' : 'Delete clips',
            );
        } else {
          const clip = project.clips.find((clip) => clip.id === selectedClip);
          if (
            clip &&
            compareTimes(playhead, clip.timelineStart) > 0 &&
            compareTimes(playhead, clipTimelineEnd(clip)) < 0
          )
            send({ type: 'clip.split', id: clip.id, at }, 'Split clip');
        }
        break;
      }

      case 'copy':
      case 'cut': {
        if (!ids.length) return;
        if (action === 'copy') {
          clipboard.current = {
            path: state?.path ?? null,
            content: copyClips(project, ids),
          };
          setNotice('Clips copied.');
        } else {
          send({ type: 'clips.cut', ids }, 'Cut clips');
        }
        break;
      }
      case 'paste':
      case 'insert': {
        const entry = clipboard.current;
        if (
          !entry ||
          entry.path !== state?.path ||
          entry.content.projectId !== project.metadata.id
        ) {
          setError('Copy or cut clips from this project first.');
          return;
        }
        send(
          {
            type: 'clips.paste',
            clipboard: entry.content,
            at,
            ...(action === 'insert'
              ? { insert: 'selected-tracks' as const }
              : {}),
          },
          action === 'insert' ? 'Insert clips' : 'Paste clips',
        );
        break;
      }
      case 'duplicate':
        if (ids.length)
          send({ type: 'clips.duplicate', ids }, 'Duplicate clips');
        break;
      case 'rippleDelete':
      case 'rippleAll':
        if (ids.length)
          send(
            {
              type: 'clips.remove',
              ids,
              ripple:
                action === 'rippleAll' ? 'all-unlocked' : 'selected-tracks',
            },
            'Ripple delete',
          );
        break;
      case 'closeGap': {
        const trackIds = [
          ...new Set(
            project.clips
              .filter((clip) => ids.includes(clip.id))
              .map((clip) => clip.trackId),
          ),
        ];
        if (trackIds.length)
          send({ type: 'timeline.close-gap', trackIds, at }, 'Close gap');
        break;
      }
      case 'link':
      case 'unlink':
        if (ids.length)
          send(
            { type: 'clips.link', ids, linked: action === 'link' },
            action === 'link' ? 'Link clips' : 'Unlink clips',
          );
        break;
      case 'marker':
        send({ type: 'marker.add', name: 'Marker', at }, 'Add marker');
        break;
    }
  }
  function importMedia(files?: File[]) {
    if (!project) return;
    void run(
      'Importing media…',
      () => {
        const input = {
          projectId: project.metadata.id,
          expectedRevision: projectRevision(stateRef.current!.project),
        };
        return files
          ? window.opencut.importDroppedMedia(input, files)
          : window.opencut.importMedia(input);
      },
      true,
    );
  }
  function subtitleFile(format?: SubtitleFormat) {
    if (!project) return;
    void run(
      format ? 'Exporting subtitles…' : 'Importing subtitles…',
      () => {
        const input = {
          projectId: project.metadata.id,
          expectedRevision: projectRevision(stateRef.current!.project),
        };
        return format
          ? window.opencut.exportSubtitles({ ...input, format })
          : window.opencut.importSubtitles(input);
      },
      !format,
    );
  }
  function edit(
    operations: TimelineOperation[],
    label: string,
    properties = false,
  ) {
    if (!project) return Promise.resolve();
    let accepted = false;
    return run(
      label,
      async () => {
        const reply = await window.opencut.editTimeline({
          projectId: project.metadata.id,
          expectedRevision: projectRevision(stateRef.current!.project),
          operations,
          label,
        });
        accepted = reply.ok && !reply.canceled;
        return reply;
      },
      properties ? 'properties' : true,
    ).then(() => {
      if (properties && !accepted) throw new Error('Property edit rejected.');
    });
  }
  function history(direction: 'undo' | 'redo') {
    if (!project) return;
    void run(
      direction === 'undo' ? 'Undoing edit…' : 'Redoing edit…',
      () => {
        const input = {
          projectId: project.metadata.id,
          expectedRevision: projectRevision(stateRef.current!.project),
        };
        return direction === 'undo'
          ? window.opencut.undoProject(input)
          : window.opencut.redoProject(input);
      },
      true,
    );
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        creating ||
        shortcutOwnsKeys(event.target, event.key)
      )
        return;
      const action = shortcutAction(event);
      if (!action) return;
      if (
        (action === 'copy' || action === 'cut' || action === 'duplicate') &&
        !selectedIds.length
      )
        return;
      event.preventDefault();
      if (busy && action !== 'save' && action !== 'undo' && action !== 'redo')
        return;
      if (action === 'undo' || action === 'redo') {
        if (project?.editing?.[action].length) history(action);
      } else if (action === 'save' && project)
        void run('Saving project…', () => window.opencut.saveProject());
      else if (action === 'play') {
        if (viewer === 'source') transport.current?.toggle();
        else projectTransport.current?.toggle();
      } else if (action === 'previousFrame' || action === 'nextFrame') {
        const direction = action === 'previousFrame' ? -1 : 1;
        if (viewer === 'source') transport.current?.step(direction);
        else projectTransport.current?.step(direction);
      } else if (action !== 'save') {
        timelineAction(action);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [project, busy, creating, selection, viewer, playhead, linkedClip]);
  return (
    <div
      className="workspace"
      aria-label="Project workspace"
      aria-busy={!!busy}
    >
      <div className="project-toolbar">
        <div className="project-title">
          <span
            className={`save-indicator ${state?.dirty ? 'unsaved' : ''}`}
            aria-hidden="true"
          />
          <h1>{project?.metadata.name ?? 'No project'}</h1>
          <span className="project-save-state">
            {state?.dirty ? 'Unsaved changes' : project ? 'Saved project' : ''}
          </span>
        </div>
        <div className="project-actions">
          <ExportPanel state={state} disabled={blocking} />
          <button
            disabled={blocking || !project?.editing?.undo.length}
            onClick={() => history('undo')}
          >
            <Undo2 aria-hidden="true" focusable="false" /> Undo
          </button>
          <button
            disabled={blocking || !project?.editing?.redo.length}
            onClick={() => history('redo')}
          >
            <Redo2 aria-hidden="true" focusable="false" /> Redo
          </button>
          <button disabled={blocking} onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" focusable="false" /> New project
          </button>
          <button
            disabled={blocking}
            onClick={() =>
              void run('Opening project…', () => window.opencut.openProject())
            }
          >
            <FolderOpen aria-hidden="true" focusable="false" /> Open project
          </button>
          <button
            className="primary-button"
            disabled={blocking || !project}
            onClick={() =>
              void run('Saving project…', () => window.opencut.saveProject())
            }
          >
            <Save aria-hidden="true" focusable="false" /> Save project
          </button>
          {project &&
            ([false, true] as const).map((bundle) => (
              <button
                key={String(bundle)}
                disabled={blocking}
                onClick={() => {
                  void run(
                    bundle ? 'Packaging project…' : 'Saving snapshot…',
                    () =>
                      window.opencut.copyProject({
                        projectId: project.metadata.id,
                        expectedRevision: projectRevision(project),
                        bundle,
                      }),
                  );
                }}
              >
                {bundle ? 'Package project' : 'Save snapshot'}
              </button>
            ))}
          <button
            disabled={blocking || !project}
            onClick={() =>
              void run('Closing project…', () => window.opencut.closeProject())
            }
          >
            Close project
          </button>
        </div>
      </div>
      {(busy || error || notice) && (
        <div className="project-feedback">
          {busy && <span aria-live="polite">{busy}</span>}
          {error && <span role="alert">{error}</span>}
          {notice && <span aria-live="polite">{notice}</span>}
        </div>
      )}
      <div className="editor-panels">
        <MediaLibrary
          key={project?.metadata.id ?? 'empty'}
          state={state}
          busy={blocking}
          selection={selection}
          revision={project ? projectRevision(project) : 0}
          onImport={() => importMedia()}
          onOnlineImport={(resultId) => {
            if (!project) return;
            void run(
              'Importing online media…',
              () =>
                window.opencut.importOnlineMedia({
                  projectId: project.metadata.id,
                  expectedRevision: projectRevision(stateRef.current!.project),
                  resultId,
                }),
              true,
            );
          }}
          onDrop={importMedia}
          onRemove={(assetId) => {
            if (project)
              void run(
                'Removing media…',
                () =>
                  window.opencut.removeAsset({
                    projectId: project.metadata.id,
                    expectedRevision: projectRevision(project),
                    assetId,
                  }),
                true,
              );
          }}
          onSelect={selectAsset}
        />
        <section className="viewer-panel" aria-label="Viewer">
          <div className="panel-heading viewer-tabs">
            <div role="tablist" aria-label="Viewer mode">
              <button
                role="tab"
                aria-selected={viewer === 'project'}
                aria-controls="project-viewer"
                id="project-viewer-tab"
                onClick={() => setViewer('project')}
              >
                Project viewer
              </button>
              <button
                role="tab"
                aria-selected={viewer === 'source'}
                aria-controls="source-viewer"
                id="source-viewer-tab"
                onClick={() => setViewer('source')}
              >
                Source preview
              </button>
            </div>
          </div>
          <div
            id="project-viewer"
            role="tabpanel"
            aria-labelledby="project-viewer-tab"
            hidden={viewer !== 'project'}
            className="project-viewer"
          >
            {project ? (
              <TimelinePreview
                project={project}
                active={viewer === 'project'}
                interrupted={!!busy || creating}
                position={playhead}
                onPositionChange={(time) => {
                  if (viewer === 'project') setPlayhead(time);
                }}
                transportRef={projectTransport}
                onExportFrame={(at) => {
                  void run('Exporting frame…', () =>
                    window.opencut.exportFrame({
                      projectId: project.metadata.id,
                      expectedRevision: projectRevision(project),
                      at,
                    }),
                  );
                }}
              />
            ) : (
              <div className="viewer-stage">
                <div className="viewer-placeholder">
                  <StudioArtwork />
                  <button
                    className="primary-button"
                    disabled={!!busy}
                    onClick={() => setCreating(true)}
                  >
                    Start creating <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </div>
            )}
            {project && (
              <div className="viewer-caption">
                <span>
                  {`${project.settings.width} × ${project.settings.height}`}
                </span>
                <span>
                  {`${project.settings.frameRate.numerator}/${project.settings.frameRate.denominator} fps`}
                </span>
              </div>
            )}
          </div>
          <div
            id="source-viewer"
            role="tabpanel"
            aria-labelledby="source-viewer-tab"
            hidden={viewer !== 'source'}
            className="source-viewer"
            ref={sourceViewer}
          >
            <Preview
              transportRef={transport}
              key={previewSession}
              assetId={previewAssetId}
              requestKey={previewRequest}
              projectFrameRate={project?.settings.frameRate}
              active={viewer === 'source'}
              positionSeconds={previewPosition}
              positionRequestKey={previewSeekRequest}
              onPositionChange={(seconds) => {
                if (linkedClip && viewer === 'source')
                  setPlayhead(
                    sourceToTimeline(
                      linkedClip,
                      seconds,
                      project!.settings.frameRate,
                    ),
                  );
              }}
              onOpenLocal={() => {
                setLinkedClipId(null);
                setPreviewPosition(undefined);
              }}
            />
          </div>
        </section>
        <ProjectInspector
          state={state}
          selection={selection}
          position={playhead}
          onSeek={seekTimeline}
          keyframeProperty={keyframeProperty}
          onKeyframeSelect={setKeyframeProperty}
          disabled={blocking}
          onEdit={(operations, label) => edit(operations, label, true)}
          onRelink={(assetId) => {
            if (!project) return;
            void run(
              'Relinking media…',
              () =>
                window.opencut.relinkAsset({
                  projectId: project.metadata.id,
                  expectedRevision: projectRevision(project),
                  assetId,
                }),
              true,
            );
          }}
          onSeparateDialogue={(assetId) => {
            if (!project) return;
            void run(
              'Separating dialogue…',
              () =>
                window.opencut.separateDialogue({
                  projectId: project.metadata.id,
                  expectedRevision: projectRevision(project),
                  assetId,
                }),
              true,
            );
          }}
          onFreeze={(clipId, frames) => {
            if (!project) return;
            const at = Number(frameIndex(playhead, project.settings.frameRate));
            void run(
              'Inserting freeze frame…',
              () =>
                window.opencut.freezeFrame({
                  projectId: project.metadata.id,
                  expectedRevision: projectRevision(project),
                  clipId,
                  at,
                  frames,
                }),
              true,
            );
          }}
          onImportFont={(id) => {
            if (!project) return;
            void run(
              'Importing font…',
              () =>
                window.opencut.importFont({
                  projectId: project.metadata.id,
                  expectedRevision: projectRevision(project),
                  id,
                }),
              true,
            );
          }}
          onClear={() => setSelection(null)}
        />
      </div>
      <ProjectTimeline
        key={timelineSession}
        project={project}
        disabled={!!busy}
        onEdit={edit}
        onImportSubtitles={subtitleFile}
        onExportSubtitles={subtitleFile}
        onAddSubtitle={async () => {
          if (!project) return;
          const id = crypto.randomUUID();
          try {
            await edit(
              [
                {
                  type: 'subtitle.add',
                  id,
                  start: playhead,
                  end: addTimes(playhead, { numerator: 3, denominator: 1 }),
                  text: 'Subtitle',
                },
              ],
              'Add subtitle',
              true,
            );
            setSelection({ kind: 'clip', id });
          } catch {
            // The workspace displays the transaction rejection.
          }
        }}
        onAddText={async () => {
          if (!project) return;
          const id = crypto.randomUUID();
          const { width, height, frameRate } = project.settings;
          const at = Number(frameIndex(playhead, frameRate, true));
          try {
            await edit(
              [
                {
                  type: 'text.add',
                  id,
                  at,
                  duration: Math.max(
                    1,
                    Math.round(
                      (3 * frameRate.numerator) / frameRate.denominator,
                    ),
                  ),
                  text: {
                    content: 'Text',
                    fontSize: Math.max(
                      1,
                      Math.min(96, Math.round(Math.min(width, height) / 12)),
                    ),
                  },
                },
              ],
              'Add text',
              true,
            );
            setSelection({ kind: 'clip', id });
          } catch {
            // The workspace displays the transaction rejection.
          }
        }}
        onAddAsset={(input) =>
          run(
            'Adding media clip…',
            () => window.opencut.addAssetClip(input),
            true,
          )
        }
        position={playhead}
        onSeek={seekTimeline}
        onKeyframeSelect={(id, property, time) => {
          setSelection({ kind: 'clip', id });
          setKeyframeProperty(property);
          seekTimeline(time);
        }}
        linkedClipId={linkedClipId}
        onPreviewClip={(id) => {
          const clip = project?.clips.find((clip) => clip.id === id);
          if (!clip?.assetId) return;
          setLinkedClipId(id);
          setPlayhead(clip.timelineStart);
          setPreviewPosition(
            clip.sourceIn.numerator / clip.sourceIn.denominator,
          );
          setPreviewAssetId(clip.assetId);
          setPreviewRequest((value) => value + 1);
          setViewer('source');
        }}
        selected={selectedClip}
        selectedIds={selectedIds}
        onSelect={selectClip}
        onTimelineAction={timelineAction}
      />
      <dialog
        ref={formDialog}
        className="new-project-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setCreating(false);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const match = /^(\d+)(?:\/(\d+))?$/.exec(
              String(fields.get('frameRate')).trim(),
            );
            if (!match) {
              setError(
                'Frame rate must be an integer or ratio such as 30000/1001.',
              );
              return;
            }
            void run('Creating project…', () =>
              window.opencut.createProject({
                name: String(fields.get('name')),
                settings: {
                  width: Number(fields.get('width')),
                  height: Number(fields.get('height')),
                  frameRate: {
                    numerator: Number(match[1]),
                    denominator: Number(match[2] ?? 1),
                  },
                },
              }),
            );
          }}
        >
          <h2>New project settings</h2>
          <div className="project-fields">
            <label>
              Project name
              <input
                autoFocus
                required
                name="name"
                defaultValue="Untitled"
                disabled={!!busy}
              />
            </label>
            <label>
              Width
              <input
                type="number"
                min="1"
                step="1"
                required
                name="width"
                defaultValue="1920"
                disabled={!!busy}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                min="1"
                step="1"
                required
                name="height"
                defaultValue="1080"
                disabled={!!busy}
              />
            </label>
            <label>
              Frame rate
              <input
                required
                name="frameRate"
                defaultValue="30"
                disabled={!!busy}
                placeholder="30000/1001"
              />
            </label>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button
              disabled={!!busy}
              type="button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button className="primary-button" disabled={!!busy} type="submit">
              Create project
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
