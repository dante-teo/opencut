import { SlidersHorizontal } from 'lucide-react';
import type { DesktopProject } from '../bridge.js';
import {
  clipTimelineEnd,
  compareTimes,
  type RationalTime,
  type Project,
} from '@opencut/core';
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
  onSeek,
}: {
  state: DesktopProject | null;
  selection: { kind: 'asset' | 'clip'; id: string } | null;
  onClear: () => void;
  onSeek: (time: RationalTime) => void;
}) {
  const project = state?.project;
  const clip =
    selection?.kind === 'clip'
      ? project?.clips.find(({ id }) => id === selection.id)
      : undefined;
  const cue =
    selection?.kind === 'clip'
      ? project?.subtitles?.cues.find(({ id }) => id === selection.id)
      : undefined;
  const asset = project?.assets.find(
    ({ id }) =>
      id === (selection?.kind === 'asset' ? selection.id : clip?.assetId),
  );
  const availability = state?.media.find(
    ({ assetId }) => assetId === asset?.id,
  );
  const settings = project?.settings;
  const start = clip?.timelineStart ?? cue?.start;
  const end = clip ? clipTimelineEnd(clip) : cue?.end;
  const track = project?.tracks.find(({ id }) => id === clip?.trackId);
  return (
    <aside className="inspector-panel" aria-label="Inspector">
      <div className="panel-heading">
        <h2>
          <SlidersHorizontal aria-hidden="true" /> Inspector
        </h2>
      </div>
      <div className="inspector-content">
        {selection && (
          <button className="text-button" onClick={onClear}>
            ← Project settings
          </button>
        )}
        {clip || cue || asset ? (
          <>
            <h3>
              {cue
                ? 'Subtitle'
                : clip?.text
                  ? 'Text clip'
                  : (asset?.name ?? 'Clip')}
            </h3>
            {(cue || clip?.text) && <p>{cue?.text ?? clip?.text?.content}</p>}
            <dl>
              <dt>ID</dt>
              <dd>{(clip ?? cue ?? asset)?.id}</dd>
              {track && (
                <>
                  <dt>Track</dt>
                  <dd>{track.name}</dd>
                </>
              )}
              {project && start && end && (
                <>
                  <dt>Timeline</dt>
                  <dd>{displayRange(start, end, project)}</dd>
                </>
              )}
              {project && clip && (
                <>
                  <dt>Source</dt>
                  <dd>
                    {displayRange(clip.sourceIn, clip.sourceOut, project)}
                  </dd>
                </>
              )}
              {asset && (
                <>
                  <dt>File</dt>
                  <dd>{asset.file.path}</dd>
                </>
              )}
              {asset?.metadata?.width && asset.metadata.height && (
                <>
                  <dt>Dimensions</dt>
                  <dd>
                    {asset.metadata.width} × {asset.metadata.height}
                  </dd>
                </>
              )}
              {availability && (
                <>
                  <dt>Media status</dt>
                  <dd>
                    {availability.status} {availability.message}
                  </dd>
                </>
              )}
            </dl>
            {start && (
              <button onClick={() => onSeek(start)}>Go to start</button>
            )}
          </>
        ) : settings ? (
          <dl>
            <dt>Dimensions</dt>
            <dd>
              {settings.width} × {settings.height}
            </dd>
            <dt>Frame rate</dt>
            <dd>
              {settings.frameRate.numerator}/{settings.frameRate.denominator}
            </dd>
            <dt>Project file</dt>
            <dd>{state?.path}</dd>
          </dl>
        ) : null}
      </div>
    </aside>
  );
}
