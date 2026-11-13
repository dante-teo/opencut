import { useEffect, useRef, useState } from 'react';
import {
  audioFadeEdges,
  clipDuration,
  clipTimelineEnd,
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
  defaultColorGrade,
  visualDefaults,
  visualRanges,
} from '@opencut/shared';
import type { TimelineOperation } from '../bridge.js';
import { frameIndex, ZERO } from './timeline-geometry.js';
import { AudioEffectProperties } from './audio-effect-properties.js';

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
  onFreeze,
}: {
  project: Project;
  clip: TimelineClip;
  disabled: boolean;
  onEdit: (operations: TimelineOperation[], label: string) => Promise<void>;
  onFreeze: (frames: number) => void;
}) {
  const [muted, setMuted] = useState(clip.muted ?? false);
  const [replacementId, setReplacementId] = useState('');
  const [useFullSource, setUseFullSource] = useState(false);
  const [ripple, setRipple] = useState(false);
  const acceptedMute = useRef(clip.muted ?? false);
  acceptedMute.current = clip.muted ?? false;
  useEffect(() => setMuted(clip.muted ?? false), [clip]);
  const start = frames(clip.timelineStart, project);
  const sourceIn = frames(clip.sourceIn, project);
  const sourceOut = frames(clip.sourceOut, project);
  const durationTime = clipDuration(clip);
  const duration = frames(durationTime, project);
  const speed = clipSpeed(clip);
  const asset = project.assets.find((asset) => asset.id === clip.assetId);
  const speedAvailable = asset?.metadata?.kind !== 'image';
  const trackType = project.tracks.find(
    (track) => track.id === clip.trackId,
  )?.type;
  const video = trackType === 'video';
  const preceding =
    video &&
    project.clips.find(
      (candidate) =>
        candidate.trackId === clip.trackId &&
        candidate.id !== clip.id &&
        compareTimes(clipTimelineEnd(candidate), clip.timelineStart) === 0,
    );
  const replacements = project.assets.filter(
    (candidate) =>
      candidate.id !== clip.assetId &&
      trackType &&
      candidate.mediaTypes.includes(trackType),
  );
  const replacement = replacements.find(
    (candidate) => candidate.id === replacementId,
  );
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
      {asset?.mediaTypes.includes('audio') && (
        <AudioEffectProperties
          key={JSON.stringify(clip.effects)}
          effects={clip.effects ?? []}
          apply={(effects) =>
            onEdit(
              [{ type: 'clip.effects', id: clip.id, effects }],
              'Set audio effects',
            )
          }
        />
      )}
      {asset?.mediaTypes.includes('audio') && (
        <form
          key={JSON.stringify(clip.gainKeys)}
          onSubmit={(event) => {
            event.preventDefault();
            const raw = String(
              new FormData(event.currentTarget).get('gain-keys') ?? '',
            ).trim();
            const points = raw
              ? raw.split(',').map((point) => point.trim().split(':'))
              : [];
            if (
              points.some(
                ([frame, value]) =>
                  !/^\d+$/.test(frame ?? '') ||
                  !Number.isSafeInteger(Number(frame)) ||
                  !value?.trim(),
              )
            )
              return;
            const keys = points.map(([frame, value]) => ({
              time: frameTime(Number(frame), project.settings.frameRate),
              value: Number(value),
            }));
            void onEdit(
              [
                {
                  type: 'clip.gain-keys',
                  id: clip.id,
                  keys: keys.length ? keys : null,
                },
              ],
              'Set volume keyframes',
            ).catch(() => {});
          }}
        >
          <label>
            Volume keyframes{' '}
            <input
              name="gain-keys"
              placeholder="0:1, 30:0.4"
              defaultValue={clip.gainKeys
                ?.map(
                  (key) =>
                    `${frames(key.time, project) ?? `${key.time.numerator}/${key.time.denominator}s`}:${key.value}`,
                )
                .join(', ')}
            />
          </label>
          <button type="submit">Apply volume keys</button>
        </form>
      )}
      {video && asset?.mediaTypes.includes('audio') && !clip.muted && (
        <button
          type="button"
          onClick={() => {
            void onEdit(
              [{ type: 'clip.detach-audio', id: clip.id }],
              'Detach audio',
            ).catch(() => {});
          }}
        >
          Detach audio
        </button>
      )}
      {replacements.length > 0 && (
        <details>
          <summary>Replace media</summary>
          <select
            aria-label="Replacement media"
            value={replacement?.id ?? ''}
            onChange={(event) => setReplacementId(event.currentTarget.value)}
          >
            <option value="">Choose media</option>
            {replacements.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={useFullSource}
              onChange={(event) =>
                setUseFullSource(event.currentTarget.checked)
              }
            />
            Use full source
          </label>
          <label>
            <input
              type="checkbox"
              checked={ripple}
              onChange={(event) => setRipple(event.currentTarget.checked)}
            />
            Shift later clips on this track
          </label>
          <button
            type="button"
            disabled={!replacement || (useFullSource && !replacement.duration)}
            onClick={() => {
              if (!replacement) return;
              const range =
                useFullSource && replacement.duration
                  ? { sourceIn: ZERO, sourceOut: replacement.duration }
                  : {};
              void onEdit(
                [
                  {
                    type: 'clip.replace',
                    id: clip.id,
                    assetId: replacement.id,
                    ripple,
                    ...range,
                  },
                ],
                'Replace media',
              ).catch(() => {});
            }}
          >
            Replace
          </button>
        </details>
      )}
      {video && (
        <>
          <h3>Transform</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const count = Number(
                new FormData(event.currentTarget).get('frames'),
              );
              const action = (
                event.nativeEvent as SubmitEvent
              ).submitter?.getAttribute('value');
              if (action === 'freeze') onFreeze(count);
              else if (action === 'fade-in' || action === 'fade-out') {
                void onEdit(
                  [
                    {
                      type: 'clip.fade',
                      id: clip.id,
                      edge: action === 'fade-in' ? 'in' : 'out',
                      frames: count,
                    },
                  ],
                  'Set visual fade',
                ).catch(() => {});
              } else if (action === 'flash')
                void onEdit(
                  [{ type: 'clip.flash', id: clip.id, frames: count }],
                  'Flash from white',
                ).catch(() => {});
              else if (preceding)
                void onEdit(
                  [
                    {
                      type: 'clip.dissolve',
                      id: clip.id,
                      from: preceding.id,
                      frames: count,
                    },
                  ],
                  'Dissolve into clip',
                ).catch(() => {});
            }}
          >
            <label>
              Transition frames{' '}
              <input
                type="number"
                name="frames"
                min={1}
                defaultValue={6}
                required
              />
            </label>
            {preceding && (
              <button type="submit" value="dissolve">
                Dissolve in
              </button>
            )}
            <button type="submit" value="flash">
              Flash from white
            </button>
            <button type="submit" value="fade-in">
              Fade in picture
            </button>
            <button type="submit" value="fade-out">
              Fade out picture
            </button>
            {asset?.metadata?.kind !== 'image' && (
              <button type="submit" value="freeze">
                Freeze at playhead
              </button>
            )}
          </form>
          <label className="clip-property">
            <span>Fit</span>
            <select
              value={clip.visual?.fit ?? 'contain'}
              onChange={(event) => {
                const fit = event.currentTarget.value;
                if (fit !== 'contain' && fit !== 'cover' && fit !== 'stretch')
                  return;
                void onEdit(
                  [{ type: 'clip.visual', id: clip.id, fit }],
                  'Set clip fit',
                ).catch(() => {});
              }}
            >
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="stretch">Stretch</option>
            </select>
          </label>
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
          <details>
            <summary>Crop</summary>
            {(['left', 'top', 'right', 'bottom'] as const).map((edge) =>
              field(
                `Crop ${edge} (%)`,
                (clip.visual?.crop?.[edge] ?? 0) * 100,
                0,
                99,
                (value) => ({
                  type: 'clip.visual',
                  id: clip.id,
                  crop: {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    ...clip.visual?.crop,
                    [edge]: value / 100,
                  },
                }),
                0.1,
              ),
            )}
          </details>
          <details>
            <summary>Color</summary>
            {(
              [
                ['exposure', 'Exposure (EV)', -4, 4],
                ['temperature', 'Temperature', -1, 1],
                ['tint', 'Tint', -1, 1],
                ['contrast', 'Contrast', 0, 3],
                ['saturation', 'Saturation', 0, 3],
              ] as const
            ).map(([key, label, min, max]) =>
              field(
                label,
                clip.grade?.[key] ?? defaultColorGrade[key],
                min,
                max,
                (value) => ({
                  type: 'clip.grade',
                  ids: [clip.id],
                  grade: { ...(clip.grade ?? defaultColorGrade), [key]: value },
                }),
                0.01,
              ),
            )}
            <form
              key={JSON.stringify(clip.grade?.curve ?? [])}
              onSubmit={(event) => {
                event.preventDefault();
                const raw = String(
                  new FormData(event.currentTarget).get('curve') ?? '',
                ).trim();
                const curve = raw
                  ? raw.split(',').map((point) => {
                      const [input, output] = point.split(':');
                      return {
                        input: Number(input),
                        output: output?.trim() ? Number(output) : NaN,
                      };
                    })
                  : [];
                void onEdit(
                  [
                    {
                      type: 'clip.grade',
                      ids: [clip.id],
                      grade: { ...(clip.grade ?? defaultColorGrade), curve },
                    },
                  ],
                  'Set color curve',
                ).catch(() => {});
              }}
            >
              <label>
                Curve points{' '}
                <input
                  name="curve"
                  placeholder="0.25:0.20, 0.75:0.85"
                  defaultValue={clip.grade?.curve
                    .map(({ input, output }) => `${input}:${output}`)
                    .join(', ')}
                />
              </label>
              <button type="submit">Apply curve</button>
            </form>
            {clip.grade && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void onEdit(
                      [{ type: 'clip.grade', ids: [clip.id], grade: null }],
                      'Reset color',
                    ).catch(() => {})
                  }
                >
                  Reset color
                </button>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const ids = new FormData(event.currentTarget)
                      .getAll('clips')
                      .map(String);
                    if (ids.length && clip.grade)
                      void onEdit(
                        [{ type: 'clip.grade', ids, grade: clip.grade }],
                        'Copy color grade',
                      ).catch(() => {});
                  }}
                >
                  <label>
                    Copy color to
                    <select multiple name="clips" size={3}>
                      {project.clips
                        .filter(
                          (other) =>
                            other.id !== clip.id &&
                            !other.text &&
                            project.tracks.some(
                              (track) =>
                                track.id === other.trackId &&
                                track.type === 'video',
                            ),
                        )
                        .map((other) => (
                          <option key={other.id} value={other.id}>
                            {project.assets.find(
                              (item) => item.id === other.assetId,
                            )?.name ?? other.id}{' '}
                            ·{' '}
                            {frames(other.timelineStart, project) ?? 'off-grid'}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button type="submit">Copy color</button>
                </form>
              </>
            )}
          </details>
        </>
      )}
      <p className="property-preview-note">
        Source preview plays original media.
      </p>
    </fieldset>
  );
}
