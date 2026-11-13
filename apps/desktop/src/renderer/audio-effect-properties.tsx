import { useState } from 'react';
import { audioPresets, type AudioEffect } from '@opencut/core';

const defaults = {
  eq: { type: 'eq', frequency: 1000, db: 0 },
  compressor: { type: 'compressor', threshold: -18, ratio: 3 },
  limiter: { type: 'limiter', ceiling: -2 },
  'de-esser': { type: 'de-esser', amount: 0.4 },
  reverb: { type: 'reverb', mix: 0.16 },
} satisfies Record<AudioEffect['type'], AudioEffect>;

const labels = {
  eq: 'EQ',
  compressor: 'Compressor',
  limiter: 'Limiter',
  'de-esser': 'De-esser',
  reverb: 'Room reverb',
};

export function AudioEffectProperties({
  effects,
  apply,
}: {
  effects: AudioEffect[];
  apply: (effects: AudioEffect[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState(effects);
  const [type, setType] = useState<AudioEffect['type']>('eq');
  function move(index: number, direction: number) {
    const result = [...draft];
    [result[index], result[index + direction]] = [
      result[index + direction]!,
      result[index]!,
    ];
    setDraft(result);
  }
  return (
    <details>
      <summary>Audio effects</summary>
      <div className="text-fields">
        <label>
          Effect{' '}
          <select
            value={type}
            onChange={(event) =>
              setType(event.currentTarget.value as AudioEffect['type'])
            }
          >
            {Object.entries(labels).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={draft.length >= 12}
          onClick={() => setDraft([...draft, defaults[type]])}
        >
          Add effect
        </button>
        <label>
          Preset{' '}
          <select
            value=""
            onChange={(event) => {
              const preset = event.currentTarget
                .value as keyof typeof audioPresets;
              if (audioPresets[preset]) setDraft([...audioPresets[preset]]);
            }}
          >
            <option value="">Choose preset</option>
            {Object.keys(audioPresets).map((preset) => (
              <option key={preset}>{preset}</option>
            ))}
          </select>
        </label>
      </div>
      {draft.map((effect, index) => {
        const number = (
          field: string,
          name: string,
          min: number,
          max: number,
          step = 0.1,
        ) => (
          <label>
            {name}
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={Number(
                Object.entries(effect).find(([key]) => key === field)?.[1],
              )}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                setDraft((items) =>
                  items.map((item, i) =>
                    i === index ? { ...item, [field]: value } : item,
                  ),
                );
              }}
            />
          </label>
        );
        return (
          <fieldset key={`${index}:${effect.type}`}>
            <legend>{labels[effect.type]}</legend>
            {effect.type === 'eq' && (
              <>
                {number('frequency', 'Frequency (Hz)', 40, 16000, 1)}
                {number('db', 'Gain (dB)', -18, 18)}
              </>
            )}
            {effect.type === 'compressor' && (
              <>
                {number('threshold', 'Threshold (dB)', -50, -1)}
                {number('ratio', 'Ratio', 1, 20)}
              </>
            )}
            {effect.type === 'limiter' &&
              number('ceiling', 'Ceiling (dB)', -20, -1)}
            {effect.type === 'de-esser' &&
              number('amount', 'Amount', 0, 1, 0.01)}
            {effect.type === 'reverb' && number('mix', 'Mix', 0, 0.5, 0.01)}
            <button
              type="button"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={index === draft.length - 1}
              onClick={() => move(index, 1)}
            >
              Move down
            </button>
            <button
              type="button"
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </fieldset>
        );
      })}
      <button type="button" onClick={() => void apply(draft).catch(() => {})}>
        Apply audio effects
      </button>
    </details>
  );
}
