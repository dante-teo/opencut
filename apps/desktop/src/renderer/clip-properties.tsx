import { useEffect, useRef, useState } from 'react';
import {
  audioFadeEdges,
  clipDuration,
  clipSpeed,
  parseClipSpeed,
  addTimes,
  timelineToSourceOffset,
  subtractTimes,
  compareTimes,
  frameTime,
  type Project,
  type RationalTime,
  type TimelineClip,
} from '@opencut/core';
import {
  animatedProperties,
  visualDefaults,
  visualRanges,
} from '@opencut/shared';
import type { TimelineOperation } from '../bridge.js';
import { frameIndex, ZERO } from './timeline-geometry.js';

const transformLabels = {
  x: 'Position X',
  y: 'Position Y',
  scale: 'Scale',
  rotation: 'Rotation (°)',
  opacity: 'Opacity',
};

/** Exact frame fields must never silently round an imported off-grid boundary. */
export function frames(time: RationalTime, project: Project): number | null {
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

export function gainDb(gain: number): string {
  return gain > 0 ? `${(20 * Math.log10(gain)).toFixed(1)} dB` : '−∞ dB';
}

export function NumberProperty({
  label,
  value,
  min,
  max,
  step = 1,
  slider = false,
  decibels = false,
  compact = false,
  disabled = false,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  slider?: boolean;
  decibels?: boolean;
  compact?: boolean;
  disabled?: boolean;
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
      className={compact ? 'track-volume' : 'clip-property'}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          change(String(value));
        }
      }}
    >
      {!compact && (
        <label>
          <span>
            {label}
            {decibels && (
              <small className="gain-decibels"> {gainDb(Number(draft))}</small>
            )}
          </span>
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
      )}
      {slider && (
        <input
          type="range"
          disabled={disabled}
          onPointerDown={(event) =>
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          aria-label={compact ? label : `${label} slider`}
          aria-valuetext={decibels ? gainDb(Number(draft)) : undefined}
          title={compact ? `${label} · ${gainDb(Number(draft))}` : undefined}
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
  const durationTime = clipDuration(clip);
  const duration = frames(durationTime, project);
  const speed = clipSpeed(clip);
  const speedAvailable =
    project.assets.find((asset) => asset.id === clip.assetId)?.metadata
      ?.kind !== 'image';
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
    decibels = false,
  ) => (
    <NumberProperty
      key={label}
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      slider={slider}
      decibels={decibels}
      onCommit={(value) =>
        onEdit([operation(value)], `Set ${label.toLowerCase()}`)
      }
    />
  );
  return (
    <fieldset className="clip-properties" disabled={disabled}>
      <legend>Clip properties</legend>
      <p>Enter to apply. Sliders apply on release.</p>
      <h3>Timing · project frames</h3>
      {start !== null &&
        field('Timeline position', start, 0, maximum, (at) => ({
          type: 'clip.move',
          id: clip.id,
          at,
        }))}
      {speedAvailable &&
        field(
          'Speed (×)',
          speed.numerator / speed.denominator,
          0.25,
          4,
          (value) => ({
            type: 'clip.speed',
            id: clip.id,
            speed: parseClipSpeed(String(value)),
          }),
          0.05,
        )}
      {duration === null && clip.speed && (
        <p>
          Duration ·{' '}
          {Number(
            (durationTime.numerator / durationTime.denominator).toPrecision(6),
          )}{' '}
          s
        </p>
      )}
      {duration !== null &&
        sourceIn !== null &&
        field('Duration', duration, 1, maximum - sourceIn, (duration) => ({
          type: 'clip.trim',
          id: clip.id,
          ...(clip.speed
            ? {
                outTime: addTimes(
                  clip.sourceIn,
                  timelineToSourceOffset(
                    clip,
                    frameTime(duration, project.settings.frameRate),
                  ),
                ),
              }
            : { out: sourceIn + duration }),
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
      {[start, sourceIn, sourceOut, ...(clip.speed ? [] : [duration])].includes(
        null,
      ) && (
        <p>
          Off-grid points can be trimmed on the timeline or set in seconds with
          the CLI.
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
      {audioFadeEdges.map((edge) => {
        const fade = frames(clip[edge]?.duration ?? ZERO, project);
        const other =
          clip[edge === 'fadeIn' ? 'fadeOut' : 'fadeIn']?.duration ?? ZERO;
        const limit = frameIndex(
          subtractTimes(durationTime, other),
          project.settings.frameRate,
        );
        const label =
          edge === 'fadeIn' ? 'Fade in (frames)' : 'Fade out (frames)';
        return fade === null || limit > BigInt(maximum) ? (
          <p key={edge}>{label} · off-grid</p>
        ) : (
          field(label, fade, 0, Number(limit), (value) => ({
            type: 'clip.audio',
            id: clip.id,
            [edge]: value,
          }))
        );
      })}
      {video && (
        <>
          <h3>Transform</h3>
          {animatedProperties.map((property) => {
            const [min, max] = visualRanges[property];
            return field(
              transformLabels[property],
              clip.visual?.[property] ?? visualDefaults[property],
              min,
              max,
              (value) => ({
                type: 'clip.visual',
                id: clip.id,
                [property]: value,
              }),
              0.01,
              property === 'opacity',
            );
          })}
        </>
      )}
      <p className="property-preview-note">
        Source preview plays original media.
      </p>
    </fieldset>
  );
}
