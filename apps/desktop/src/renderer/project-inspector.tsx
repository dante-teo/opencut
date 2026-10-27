import { SlidersHorizontal } from 'lucide-react';
import { CanvasArtwork } from './studio-graphics.js';
import type { DesktopProject } from '../bridge.js';
import { exactTime } from './project-timeline.js';

export function ProjectInspector({
  state,
  selection,
  onClear,
}: {
  state: DesktopProject | null;
  selection: { kind: 'asset' | 'clip'; id: string } | null;
  onClear: () => void;
}) {
  const project = state?.project;
  const clip =
    selection?.kind === 'clip'
      ? project?.clips.find((clip) => clip.id === selection.id)
      : undefined;
  const asset = project?.assets.find(
    (asset) => asset.id === (clip?.assetId ?? selection?.id),
  );
  const availability = state?.media.find((item) => item.assetId === asset?.id);
  return (
    <aside
      className="inspector-panel"
      aria-label="Inspector"
      title="Read-only properties"
    >
      <div className="panel-heading">
        <h2>
          <SlidersHorizontal aria-hidden="true" focusable="false" /> Inspector
        </h2>
      </div>
      <div className="inspector-content">
        {selection && (
          <>
            <button className="text-button" onClick={onClear}>
              ← Project settings
            </button>
            {clip && (
              <>
                <h3>Clip details</h3>
                <dl>
                  <dt>Clip ID</dt>
                  <dd>{clip.id}</dd>
                  <dt>Track</dt>
                  <dd>
                    {
                      project?.tracks.find((track) => track.id === clip.trackId)
                        ?.name
                    }
                  </dd>
                  <dt>Timeline start</dt>
                  <dd>{exactTime(clip.timelineStart)}</dd>
                  <dt>Source in → out</dt>
                  <dd>
                    {exactTime(clip.sourceIn)} → {exactTime(clip.sourceOut)}
                  </dd>
                  <dt>Volume</dt>
                  <dd>{clip.volume ?? 1}</dd>
                  <dt>Muted</dt>
                  <dd>{clip.muted ? 'Yes' : 'No'}</dd>
                  {clip.visual && (
                    <>
                      <dt>Visual settings</dt>
                      <dd>
                        <pre>{JSON.stringify(clip.visual, null, 2)}</pre>
                      </dd>
                    </>
                  )}
                </dl>
              </>
            )}
            {asset && (
              <>
                <h3>{asset.name}</h3>
                <dl>
                  <dt>Asset ID</dt>
                  <dd>{asset.id}</dd>
                  <dt>File</dt>
                  <dd>{asset.file.path}</dd>
                  <dt>Availability</dt>
                  <dd>
                    {availability?.status ?? 'Unchecked'} ·{' '}
                    {availability?.message}
                  </dd>
                  <dt>Media type</dt>
                  <dd>{asset.metadata?.kind ?? asset.mediaTypes.join(', ')}</dd>
                  {asset.metadata && (
                    <>
                      <dt>Dimensions</dt>
                      <dd>
                        {asset.metadata.width ?? '—'} ×{' '}
                        {asset.metadata.height ?? '—'}
                      </dd>
                      <dt>Duration</dt>
                      <dd>{asset.metadata.durationSeconds ?? '—'} s</dd>
                      <dt>Video codec</dt>
                      <dd>{asset.metadata.videoCodec ?? '—'}</dd>
                      <dt>Audio codec</dt>
                      <dd>{asset.metadata.audioCodec ?? '—'}</dd>
                      <dt>Source FPS</dt>
                      <dd>
                        {asset.metadata.frameRateRatio ??
                          asset.metadata.frameRate ??
                          '—'}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            )}
          </>
        )}
        <div className="inspector-overview" aria-hidden="true">
          <CanvasArtwork />
        </div>
        {project && (
          <>
            <h3>Project settings</h3>
            <dl className="project-metadata">
              <dt>Resolution</dt>
              <dd>
                {project.settings.width} × {project.settings.height}
              </dd>
              <dt>Frame rate</dt>
              <dd>
                {project.settings.frameRate.numerator}/
                {project.settings.frameRate.denominator} fps
              </dd>
              <dt>Background</dt>
              <dd>{project.settings.backgroundColor ?? '#000000'}</dd>
            </dl>
            <h3>Project information</h3>
            <dl>
              <dt>Project ID</dt>
              <dd>{project.metadata.id}</dd>
              <dt>Created</dt>
              <dd>{project.metadata.createdAt}</dd>
              <dt>Updated</dt>
              <dd>{project.metadata.updatedAt}</dd>
              <dt>Format / revision</dt>
              <dd>
                {project.schemaVersion} / {project.editing?.revision ?? 0}
              </dd>
              <dt>File</dt>
              <dd>{state?.path ?? 'Not saved yet'}</dd>
            </dl>
          </>
        )}
      </div>
    </aside>
  );
}
