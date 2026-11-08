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
  compareTimes,
  projectRevision,
  type RationalTime,
} from '@opencut/core';
import {
  sourceToTimeline,
  timelineToSource,
  ZERO,
  frameIndex,
} from './timeline-geometry.js';
import { ProjectTimeline } from './project-timeline.js';
import { MediaLibrary } from './media-library.js';
import { ProjectInspector } from './project-inspector.js';
import { shortcutAction, shortcutOwnsKeys } from './shortcuts.js';
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
  } | null>(null);

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
          if (label !== 'Saving project…' && !editing) {
            setSelection(null);
            setPlayhead(ZERO);
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setPreviewAssetId(null);
            setPreviewSession((value) => value + 1);
            setTimelineSession((value) => value + 1);
          }
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
          setNotice(
            reply.notice ??
              (label === 'Saving project…' ? 'Project saved.' : ''),
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
  function edit(
    operations: TimelineOperation[],
    label: string,
    properties = false,
  ) {
    if (!project) return Promise.resolve();
    let rejected = true;
    return run(
      label,
      async () => {
        const reply = await window.opencut.editTimeline({
          projectId: project.metadata.id,
          expectedRevision: projectRevision(stateRef.current!.project),
          operations,
          label,
        });
        rejected = !reply.ok;
        return reply;
      },
      properties ? 'properties' : true,
    ).then(() => {
      if (properties && rejected) throw new Error('Property edit rejected.');
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
      } else if (selection?.kind === 'clip' && project) {
        const clip = project.clips.find((clip) => clip.id === selection.id);
        if (!clip) return;
        if (action === 'delete')
          void edit([{ type: 'clip.remove', id: clip.id }], 'Delete clip');
        else if (
          action === 'split' &&
          compareTimes(playhead, clip.timelineStart) > 0 &&
          compareTimes(playhead, clipTimelineEnd(clip)) < 0
        )
          void edit(
            [
              {
                type: 'clip.split',
                id: clip.id,
                at: Number(
                  frameIndex(playhead, project.settings.frameRate, true),
                ),
              },
            ],
            'Split clip',
          );
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
          onSelect={(id) => {
            setSelection({ kind: 'asset', id });
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setPreviewAssetId(id);
            setPreviewRequest((value) => value + 1);
            setViewer('source');
          }}
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
          disabled={blocking}
          onEdit={(operations, label) => edit(operations, label, true)}
          onClear={() => setSelection(null)}
        />
      </div>
      <ProjectTimeline
        key={timelineSession}
        project={project}
        disabled={!!busy}
        onEdit={edit}
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
        selected={selection?.kind === 'clip' ? selection.id : null}
        onSelect={(id) => setSelection({ kind: 'clip', id })}
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
