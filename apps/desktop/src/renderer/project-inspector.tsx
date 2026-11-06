import { SlidersHorizontal } from 'lucide-react';
import { ClipProperties } from './clip-properties.js';
import { CanvasArtwork } from './studio-graphics.js';
import type { DesktopProject, TimelineOperation } from '../bridge.js';
import { compareTimes, type RationalTime, type Project } from '@opencut/core';
import {
  frameIndex,
  framePosition,
  timelineTimecode,
} from './timeline-geometry.js';

const exactTime = (value: RationalTime) =>
  `${value.numerator}/${value.denominator} s`;
function displayTime(value: RationalTime, project: Project) {
  const rate = project.settings.frameRate;
  try {
    return compareTimes(framePosition(frameIndex(value, rate), rate), value) ===
      0
      ? timelineTimecode(value, rate)
      : exactTime(value);
  } catch {
    // Valid rational boundaries can exceed the representable project-frame range.
    return exactTime(value);
  }
}

function displayRange(
  start: RationalTime,
  end: RationalTime,
  project: Project,
) {
  const from = displayTime(start, project);
  const to = displayTime(end, project);
  return from.includes('/') || to.includes('/')
    ? `${exactTime(start)} → ${exactTime(end)}`
    : `${from} → ${to}`;
}

export function ProjectInspector({
  state,
  selection,
  onClear,
  disabled,
  onEdit,
}: {
  state: DesktopProject | null;
  selection: { kind: 'asset' | 'clip'; id: string } | null;
  onClear: () => void;
  disabled: boolean;
  onEdit: (operations: TimelineOperation[], label: string) => Promise<void>;
}) {
  const project = state?.project;
  const clip =
    selection?.kind === 'clip'
      ? project?.clips.find((clip) => clip.id === selection.id)
      : undefined;
  const asset = project?.assets.find(
    (asset) =>
      asset.id === (selection?.kind === 'asset' ? selection.id : clip?.assetId),
  );
  const availability = state?.media.find((item) => item.assetId === asset?.id);
  return (
    <aside className="inspector-panel" aria-label="Inspector">
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
                <ClipProperties
                  key={`${project!.metadata.id}:${clip.id}`}
                  project={project!}
                  clip={clip}
                  disabled={disabled}
                  onEdit={onEdit}
                />
                <dl>
                  <dt>Track</dt>
                  <dd>
                    {
                      project?.tracks.find((track) => track.id === clip.trackId)
                        ?.name
                    }
                  </dd>
                  <dt>Timeline start</dt>
                  <dd>{displayTime(clip.timelineStart, project!)}</dd>
                  <dt>Source in → out</dt>
                  <dd>
                    {displayRange(clip.sourceIn, clip.sourceOut, project!)}
                  </dd>
                </dl>
              </>
            )}
            {asset && (
              <>
                <h3>{asset.name}</h3>
                <details className="asset-information" open={!clip}>
                  <summary>Media information</summary>
                  <dl>
                    <dt>File</dt>
                    <dd>{asset.file.path}</dd>
                    <dt>Availability</dt>
                    <dd>
                      {availability?.status ?? 'Unchecked'} ·{' '}
                      {availability?.message}
                    </dd>
                    <dt>Media type</dt>
                    <dd>
                      {asset.metadata?.kind ?? asset.mediaTypes.join(', ')}
                    </dd>
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
                </details>
              </>
            )}
          </>
        )}
        {!selection && (
          <div className="inspector-overview" aria-hidden="true">
            <CanvasArtwork />
          </div>
        )}
        {project && !selection && (
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
            <details className="project-information">
              <summary>Project information</summary>
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
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
