import { useEffect, useRef, useState } from 'react';
import {
  clipDuration,
  compareTimes,
  frameTime,
  type Project,
  type RationalTime,
  type TimelineClip,
} from '@opencut/core';
import type { TimelineOperation } from '../bridge.js';
import { frameIndex } from './timeline-geometry.js';

/** Exact frame fields must never silently round an imported off-grid boundary. */
function frames(time: RationalTime, project: Project): number | null {
  const index = Number(frameIndex(time, project.settings.frameRate));
  if (!Number.isSafeInteger(index)) return null;
  try {
    return compareTimes(frameTime(index, project.settings.frameRate), time) ===
      0
      ? index
      : null;
  } catch {
    return null;
  }
}

function NumberProperty({
  label,
  value,
  min,
  max,
  step = 1,
  slider = false,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  slider?: boolean;
  onCommit: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const committing = useRef(false);
  const accepted = useRef(value);
  accepted.current = value;
  useEffect(() => {
    setDraft(String(value));
    setError('');
  }, [value]);
  async function commit() {
    if (committing.current || draft === String(value)) return;
    const number = Number(draft);
    if (
      !draft.trim() ||
      !Number.isFinite(number) ||
      number < min ||
      number > max ||
      (step === 1 && !Number.isSafeInteger(number))
    ) {
      setError(
        `Enter ${step === 1 ? 'a whole number' : 'a number'} from ${min} to ${max}.`,
      );
      return;
    }
    committing.current = true;
    setSubmitted(true);
    try {
      await onCommit(number);
    } catch {
      // The workspace displays the core's rejection; restore the accepted value.
    }
    setDraft(String(accepted.current));
    setSubmitted(false);
    committing.current = false;
  }
  function change(value: string) {
    setDraft(value);
    setError('');
  }
  return (
    <div
      className="clip-property"
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          change(String(value));
        }
      }}
    >
      <label>
        <span>{label}</span>
        <input
          type="number"
          aria-label={label}
          value={draft}
          min={min}
          max={max}
          step={step}
          readOnly={submitted}
          aria-busy={submitted}
          aria-invalid={!!error}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            }
          }}
        />
      </label>
      {slider && (
        <input
          type="range"
          onPointerDown={(event) =>
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          aria-label={`${label} slider`}
          min={min}
          max={max}
          step={step}
          value={Number(draft) || 0}
          aria-busy={submitted}
          onChange={(event) => {
            if (!committing.current) change(event.target.value);
          }}
          onPointerUp={() => void commit()}
          onPointerCancel={() => change(String(value))}
          onKeyUp={(event) => {
            if (
              [
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(event.key)
            )
              void commit();
          }}
        />
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function ClipProperties({
  project,
  clip,
  disabled,
  onEdit,
}: {
  project: Project;
  clip: TimelineClip;
  disabled: boolean;
  onEdit: (operations: TimelineOperation[], label: string) => Promise<void>;
}) {
  const [muted, setMuted] = useState(clip.muted ?? false);
  const acceptedMute = useRef(clip.muted ?? false);
  acceptedMute.current = clip.muted ?? false;
  useEffect(() => setMuted(clip.muted ?? false), [clip]);
  const start = frames(clip.timelineStart, project);
  const sourceIn = frames(clip.sourceIn, project);
  const sourceOut = frames(clip.sourceOut, project);
  const duration = frames(clipDuration(clip), project);
  const video =
    project.tracks.find((track) => track.id === clip.trackId)?.type === 'video';
  const maximum = Number.MAX_SAFE_INTEGER;
  const field = (
    label: string,
    value: number,
    min: number,
    max: number,
    operation: (value: number) => TimelineOperation,
    step = 1,
    slider = false,
  ) => (
    <NumberProperty
      key={label}
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      slider={slider}
      onCommit={(value) =>
        onEdit([operation(value)], `Set ${label.toLowerCase()}`)
      }
    />
  );
  return (
    <fieldset className="clip-properties" disabled={disabled}>
      <legend>Clip properties</legend>
      <p>Enter or leave a field to apply. Sliders apply on release.</p>
      <h3>Timing · project frames</h3>
      {start !== null &&
        field('Timeline position', start, 0, maximum, (at) => ({
          type: 'clip.move',
          id: clip.id,
          at,
        }))}
      {duration !== null &&
        sourceIn !== null &&
        field('Duration', duration, 1, maximum - sourceIn, (duration) => ({
          type: 'clip.trim',
          id: clip.id,
          out: sourceIn + duration,
        }))}
      {sourceIn !== null &&
        field('Source in', sourceIn, 0, maximum, (value) => ({
          type: 'clip.trim',
          id: clip.id,
          in: value,
        }))}
      {sourceOut !== null &&
        field('Source out', sourceOut, 1, maximum, (out) => ({
          type: 'clip.trim',
          id: clip.id,
          out,
        }))}
      {[start, duration, sourceIn, sourceOut].includes(null) && (
        <p>
          Off-grid or out-of-range timing is read-only. Align it with the CLI to
          edit in project frames.
        </p>
      )}
      <h3>Audio</h3>
      {field(
        'Volume',
        clip.volume ?? 1,
        0,
        1,
        (volume) => ({ type: 'clip.audio', id: clip.id, volume }),
        0.01,
        true,
      )}
      <label className="clip-mute">
        <input
          type="checkbox"
          checked={muted}
          onChange={(event) => {
            setMuted(event.target.checked);
            void onEdit(
              [
                {
                  type: 'clip.audio',
                  id: clip.id,
                  muted: event.target.checked,
                },
              ],
              'Set clip mute',
            ).catch(() => setMuted(acceptedMute.current));
          }}
        />{' '}
        Mute
      </label>
      {video && (
        <>
          <h3>Transform</h3>
          {field(
            'Position X',
            clip.visual?.x ?? 0,
            -32768,
            32768,
            (x) => ({ type: 'clip.visual', id: clip.id, x }),
            0.01,
          )}
          {field(
            'Position Y',
            clip.visual?.y ?? 0,
            -32768,
            32768,
            (y) => ({ type: 'clip.visual', id: clip.id, y }),
            0.01,
          )}
          {field(
            'Scale',
            clip.visual?.scale ?? 1,
            0.01,
            4,
            (scale) => ({ type: 'clip.visual', id: clip.id, scale }),
            0.01,
          )}
          {field(
            'Opacity',
            clip.visual?.opacity ?? 1,
            0,
            1,
            (opacity) => ({ type: 'clip.visual', id: clip.id, opacity }),
            0.01,
            true,
          )}
        </>
      )}
      <p className="property-preview-note">
        Project viewer applies clip transforms, volume and mute. Source preview
        plays original media.
      </p>
    </fieldset>
  );
}
