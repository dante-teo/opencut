import { useState } from 'react';
import {
  addTimes,
  clipDuration,
  compareTimes,
  parseSubtitleTime,
  subtractTimes,
  type RationalTime,
  type TimelineClip,
} from '@opencut/core';
import {
  animatedProperties,
  sampleKeyframes,
  keyframeEasings,
  visualDefaults,
  visualRanges,
  type AnimatedProperty,
  type KeyframeEasing,
} from '@opencut/shared';
import type { TimelineOperation } from '../bridge.js';

const labels = {
  x: 'Position X',
  y: 'Position Y',
  scale: 'Scale',
  rotation: 'Rotation',
  opacity: 'Opacity',
};
const exact = (time: RationalTime) => `${time.numerator}/${time.denominator}`;

export function KeyframeProperties({
  clip,
  position,
  onSeek,
  disabled,
  onEdit,
  property,
  onPropertyChange,
}: {
  clip: TimelineClip;
  property: AnimatedProperty;
  onPropertyChange: (property: AnimatedProperty) => void;
  position: RationalTime;
  onSeek: (time: RationalTime) => void;
  disabled: boolean;
  onEdit: (operations: TimelineOperation[], label: string) => Promise<void>;
}) {
  const [selection, setSelection] = useState<RationalTime>();
  const [error, setError] = useState('');
  const keys = clip.keyframes?.[property] ?? [];
  const duration = clipDuration(clip);
  const inside =
    compareTimes(position, clip.timelineStart) >= 0 &&
    compareTimes(position, addTimes(clip.timelineStart, duration)) <= 0;
  let local: RationalTime | undefined;
  if (inside) {
    try {
      local = subtractTimes(position, clip.timelineStart);
    } catch {
      // The absolute playhead can be representable when the exact difference is not.
    }
  }
  const keyAt = (time: RationalTime | undefined) =>
    time && keys.find((key) => compareTimes(key.time, time) === 0);
  const atPlayhead = keyAt(local);
  const key = atPlayhead ?? keyAt(selection) ?? keys[0];
  const [min, max] = visualRanges[property];
  const value = keys.length
    ? sampleKeyframes(keys, position, clip.timelineStart)
    : (clip.visual?.[property] ?? visualDefaults[property]);
  const edit = async (
    operation: TimelineOperation,
    label: string,
    afterSave?: () => void,
  ) => {
    setError('');
    try {
      await onEdit([operation], label);
    } catch {
      // The workspace reports transaction errors.
      return;
    }
    afterSave?.();
  };
  return (
    <fieldset className="keyframe-properties" disabled={disabled}>
      <legend>Keyframes</legend>
      <label>
        Property
        <select
          aria-label="Animated property"
          value={property}
          onChange={(event) => {
            onPropertyChange(event.target.value as AnimatedProperty);
            setSelection(undefined);
            setError('');
          }}
        >
          {animatedProperties.map((name) => (
            <option key={name} value={name}>
              {labels[name]}
            </option>
          ))}
        </select>
      </label>
      <div className="keyframe-actions">
        <button
          type="button"
          className="text-button"
          disabled={!local || !!atPlayhead}
          title="Add a keyframe at the playhead"
          onClick={() => {
            if (!local) return;
            void edit(
              {
                type: 'clip.keyframe.add',
                id: clip.id,
                property,
                time: local,
                value,
              },
              'Add keyframe',
              () => setSelection(local),
            );
          }}
        >
          Add keyframe
        </button>
        {inside && (
          <output aria-label="Value at playhead">
            {Number(value.toPrecision(7))}
          </output>
        )}
      </div>
      {key && (
        <>
          <label>
            Keyframe
            <select
              aria-label="Select keyframe"
              value={exact(key.time)}
              onChange={(event) => {
                const chosen = keys.find(
                  (entry) => exact(entry.time) === event.target.value,
                );
                if (!chosen) return;
                setError('');
                setSelection(chosen.time);
                onSeek(addTimes(clip.timelineStart, chosen.time));
              }}
            >
              {keys.map((entry) => (
                <option key={exact(entry.time)} value={exact(entry.time)}>
                  {exact(entry.time)} s
                </option>
              ))}
            </select>
          </label>
          <form
            key={JSON.stringify([property, key])}
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              let newTime: RationalTime;
              try {
                newTime = parseSubtitleTime(String(fields.get('time')));
                if (compareTimes(newTime, duration) > 0)
                  throw new RangeError(
                    'Keyframe time exceeds the clip duration.',
                  );
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
                return;
              }
              const easing = fields.get('easing') as KeyframeEasing;
              void edit(
                {
                  type: 'clip.keyframe.set',
                  id: clip.id,
                  property,
                  time: key.time,
                  newTime,
                  value: Number(fields.get('value')),
                  ...(easing !== key.easing && { easing }),
                },
                'Edit keyframe',
                () => {
                  setSelection(newTime);
                  onSeek(addTimes(clip.timelineStart, newTime));
                },
              );
            }}
          >
            <label>
              Clip time (s)
              <input
                aria-label="Keyframe time"
                name="time"
                defaultValue={exact(key.time)}
                maxLength={48}
                required
              />
            </label>
            <label>
              Value
              <input
                aria-label="Keyframe value"
                name="value"
                type="number"
                defaultValue={key.value}
                min={min}
                max={max}
                step="any"
                required
              />
            </label>
            <label>
              Easing to next
              <select
                name="easing"
                aria-label="Keyframe easing"
                defaultValue={key.easing}
              >
                {keyframeEasings.map((easing) => (
                  <option key={easing}>{easing}</option>
                ))}
              </select>
            </label>
            <div className="keyframe-actions">
              <button className="text-button" type="submit">
                Apply keyframe
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  void edit(
                    {
                      type: 'clip.keyframe.remove',
                      id: clip.id,
                      property,
                      time: key.time,
                    },
                    'Delete keyframe',
                  )
                }
              >
                Delete keyframe
              </button>
            </div>
          </form>
        </>
      )}
      {error && <span role="alert">{error}</span>}
    </fieldset>
  );
}
