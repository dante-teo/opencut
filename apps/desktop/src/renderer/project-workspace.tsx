import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { ExportPanel } from './export-panel.js';
import { StudioArtwork } from './studio-graphics.js';
import type { DesktopProject, ProjectReply } from '../bridge.js';
import { Preview, type PreviewTransport } from './video-preview.js';
import { TimelinePreview, type TimelineTransport } from './timeline-preview.js';
import { projectRevision, type RationalTime } from '@opencut/core';
import {
  clampTime,
  indexTimeline,
  sourceToTimeline,
  timelineToSource,
  ZERO,
  frameIndex,
  framePosition,
} from './timeline-geometry.js';
import { ProjectTimeline } from './project-timeline.js';
import { MediaLibrary } from './media-library.js';
import { ProjectInspector } from './project-inspector.js';
import { shortcutAction, shortcutOwnsKeys } from './shortcuts.js';

export function ProjectWorkspace() {
  const [state, setState] = useState<DesktopProject | null>(null);
  const [busy, setBusy] = useState('Loading project…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const stateRef = useRef(state);
  const sequenceRef = useRef(-1);
  const transport = useRef<PreviewTransport | null>(null);
  const projectTransport = useRef<TimelineTransport | null>(null);
  const [viewer, setViewer] = useState<'project' | 'source'>('project');
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
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
  }, [previewRequest, state]);
  const [selection, setSelection] = useState<{
    kind: 'asset' | 'clip';
    id: string;
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
    window.opencut.onDesktopControl((control, view, revision) => {
      if (
        !state ||
        state.view !== view ||
        projectRevision(state.project) !== revision ||
        stateRef.current !== state
      )
        throw new Error('Viewer revision changed. Retry the review request.');
      const { project } = state;
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

  function accept(next: DesktopProject | null, sequence: number) {
    if (sequence <= sequenceRef.current) return;
    sequenceRef.current = sequence;
    const previous = stateRef.current;
    stateRef.current = next;
    setState(next);
    setLinkedClipId(null);
    setPreviewPosition(undefined);
    setPreviewAssetId(null);
    setViewer('project');
    if (!next || next.view !== previous?.view) {
      setSelection(null);
      setPlayhead(ZERO);
    } else {
      const { project } = next;
      setPlayhead((time) => clampTime(time, indexTimeline(project).end));
      setSelection((current) => {
        if (!current) return null;
        const exists =
          current.kind === 'asset'
            ? project.assets.some(({ id }) => id === current.id)
            : project.clips.some(({ id }) => id === current.id) ||
              project.subtitles?.cues.some(({ id }) => id === current.id);
        return exists ? current : null;
      });
    }
  }

  async function run(label: string, operation: () => Promise<ProjectReply>) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const reply = await operation();
      if (!reply.ok) setError(reply.error);
      else {
        accept(reply.state, reply.sequence);
        setNotice(reply.notice ?? '');
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy('');
    }
  }
  useEffect(() => {
    const unsubscribe = window.opencut.onProjectChanged(accept);
    void run('Loading project…', () => window.opencut.getProject());
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      unsubscribe();
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
  useEffect(() => {
    document.title = state
      ? state.project.metadata.name + ' — OpenCut'
      : 'OpenCut';
  }, [state]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || shortcutOwnsKeys(event.target, event.key))
        return;
      const action = shortcutAction(event);
      if (!action) return;
      const current =
        viewer === 'source' ? transport.current : projectTransport.current;
      if (!current) return;
      event.preventDefault();
      if (action === 'play') current.toggle();
      else current.step(action === 'previousFrame' ? -1 : 1);
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [viewer]);

  const project = state?.project;
  const revision = project ? projectRevision(project) : 0;
  const previewKey = state ? state.view + ':' + revision : 'empty';
  const scope = state && {
    view: state.view,
    projectId: state.project.metadata.id,
    expectedRevision: revision,
  };
  const openProject = () => {
    void run('Opening project…', () => window.opencut.openProject());
  };
  return (
    <div
      className="workspace"
      aria-label="Project workspace"
      aria-busy={!!busy}
    >
      <div className="project-toolbar">
        <div className="project-title">
          <h1>{project?.metadata.name ?? 'No project'}</h1>
          {project && (
            <span className="project-save-state" role="status">
              Revision {revision}
            </span>
          )}
        </div>
        <div className="project-actions">
          <ExportPanel state={state} disabled={!!busy} />
          <button disabled={!!busy} onClick={openProject}>
            <FolderOpen aria-hidden="true" /> Open project
          </button>
          <button
            disabled={!!busy || !project}
            onClick={() =>
              void run('Closing project…', () => window.opencut.closeProject())
            }
          >
            Close project
          </button>
          {scope && (
            <details className="subtitle-menu">
              <summary>More export options</summary>
              <div className="subtitle-actions">
                {([false, true] as const).map((bundle) => (
                  <button
                    key={String(bundle)}
                    disabled={!!busy}
                    onClick={() =>
                      void run(
                        bundle ? 'Packaging project…' : 'Saving snapshot…',
                        () => window.opencut.copyProject({ ...scope, bundle }),
                      )
                    }
                  >
                    {bundle ? 'Package project' : 'Save snapshot'}
                  </button>
                ))}
                {project?.subtitles?.cues.length
                  ? (['srt', 'vtt'] as const).map((format) => (
                      <button
                        key={format}
                        disabled={!!busy}
                        onClick={() =>
                          void run('Exporting subtitles…', () =>
                            window.opencut.exportSubtitles({
                              ...scope,
                              format,
                            }),
                          )
                        }
                      >
                        Export {format.toUpperCase()}
                      </button>
                    ))
                  : null}
              </div>
            </details>
          )}
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
          state={state}
          selection={selection}
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
            {state && scope ? (
              <TimelinePreview
                project={state.project}
                scope={scope}
                active={viewer === 'project'}
                key={previewKey}
                position={playhead}
                onPositionChange={(time) => {
                  if (viewer === 'project') setPlayhead(time);
                }}
                transportRef={projectTransport}
                onExportFrame={(at) => {
                  void run('Exporting frame…', () =>
                    window.opencut.exportFrame({
                      ...scope,
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
                    onClick={openProject}
                  >
                    Open a project
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
              key={previewKey}
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
          onClear={() => setSelection(null)}
          onSeek={seekTimeline}
        />
      </div>
      <ProjectTimeline
        key={state?.view ?? 'empty'}
        project={project}
        position={playhead}
        onSeek={seekTimeline}
        linkedClipId={linkedClipId}
        selected={selection?.kind === 'clip' ? selection.id : null}
        onSelect={(id) => setSelection({ kind: 'clip', id })}
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
      />
    </div>
  );
}
