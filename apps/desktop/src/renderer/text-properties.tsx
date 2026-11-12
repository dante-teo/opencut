import { clipDuration, type Project, type TimelineClip } from '@opencut/core';
import { useState } from 'react';
import { DEFAULT_TEXT_FONT, DEFAULT_TEXT_SIZE } from '@opencut/shared';
import type { TimelineOperation } from '../bridge.js';
import { frames } from './clip-properties.js';

export function TextProperties({
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
  const text = clip.text!;
  const visual = clip.visual ?? {};
  const [effects, setEffects] = useState({
    Stroke: !!text.stroke,
    Shadow: !!text.shadow,
    Background: !!text.background,
  });
  const start = frames(clip.timelineStart, project);
  const duration = frames(clipDuration(clip), project);
  const number = (
    label: string,
    value: number | '',
    min: number,
    max: number,
    step: number | 'any' = 'any',
  ) => (
    <label>
      {label}
      <input
        name={label}
        type="number"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        required={label !== 'Wrap width'}
      />
    </label>
  );
  const color = (label: string, value: string) => (
    <label>
      {label}
      <input
        name={label}
        defaultValue={value}
        pattern="(?:#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|transparent)"
        required
      />
    </label>
  );
  const effect = (name: keyof typeof effects) => (
    <label className="text-effect">
      <input
        type="checkbox"
        name={name}
        checked={effects[name]}
        onChange={(event) =>
          setEffects({ ...effects, [name]: event.currentTarget.checked })
        }
      />
      {name}
    </label>
  );
  return (
    <form
      className="text-properties"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const value = (name: string) => String(fields.get(name) ?? '');
        const amount = (name: string) => Number(value(name));
        const patch: NonNullable<
          Extract<TimelineOperation, { type: 'text.set' }>['text']
        > = {
          content: value('Text'),
          fontFamily: value('Font family'),
          fontSize: amount('Font size'),
          fontWeight: amount('Weight'),
          color: value('Color'),
          alignment: value('Alignment') as 'left' | 'center' | 'right',
          wrapWidth: value('Wrap width') ? amount('Wrap width') : null,
          rotation: amount('Rotation'),
          stroke: fields.has('Stroke')
            ? { color: value('Stroke color'), width: amount('Stroke width') }
            : null,
          shadow: fields.has('Shadow')
            ? {
                color: value('Shadow color'),
                x: amount('Shadow X'),
                y: amount('Shadow Y'),
                blur: amount('Shadow blur'),
              }
            : null,
          background: fields.has('Background')
            ? { color: value('Background color'), padding: amount('Padding') }
            : null,
        };
        const textEdit: TimelineOperation = {
          type: 'text.set',
          id: clip.id,
          text: patch,
        };
        if (start !== null) textEdit.at = amount('Start frame');
        if (duration !== null) textEdit.duration = amount('Duration frames');
        const rotation = amount('Clip rotation');
        void onEdit(
          [
            textEdit,
            {
              type: 'clip.visual',
              id: clip.id,
              x: amount('X'),
              y: amount('Y'),
              scale: amount('Scale'),
              opacity: amount('Opacity'),
              ...(visual.rotation !== undefined || rotation !== 0
                ? { rotation }
                : {}),
            },
          ],
          'Edit text',
        ).catch(() => {
          // The workspace displays the transaction rejection and the draft remains editable.
        });
      }}
    >
      <fieldset disabled={disabled}>
        <div className="text-properties-controls">
          <label>
            Text
            <textarea
              name="Text"
              defaultValue={text.content}
              rows={3}
              maxLength={4096}
            />
          </label>
          <label>
            Font family
            <input
              name="Font family"
              defaultValue={text.fontFamily ?? DEFAULT_TEXT_FONT}
              maxLength={120}
              required
            />
          </label>
          <div className="text-fields">
            {number('Font size', text.fontSize ?? DEFAULT_TEXT_SIZE, 1, 512)}
            <label>
              Weight
              <select
                name="Weight"
                aria-label="Weight"
                defaultValue={text.fontWeight ?? 400}
              >
                {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
                  <option key={weight} value={weight}>
                    {weight}
                  </option>
                ))}
              </select>
            </label>
            {color('Color', text.color ?? '#ffffff')}
            <label>
              Alignment
              <select
                name="Alignment"
                aria-label="Alignment"
                defaultValue={text.alignment ?? 'center'}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            {number('Wrap width', text.wrapWidth ?? '', 1, 3840)}
          </div>
          <h3>Transform</h3>
          <div className="text-fields">
            {number('X', visual.x ?? 0, -32768, 32768)}
            {number('Y', visual.y ?? 0, -32768, 32768)}
            {number('Scale', visual.scale ?? 1, 0.01, 4)}
            {number('Opacity', visual.opacity ?? 1, 0, 1)}
            {number('Rotation', text.rotation ?? 0, -360, 360)}
            {number('Clip rotation', visual.rotation ?? 0, -36000, 36000)}
          </div>
          <h3>Timing</h3>
          <div className="text-fields">
            {start !== null &&
              number('Start frame', start, 0, Number.MAX_SAFE_INTEGER, 1)}
            {duration !== null &&
              number(
                'Duration frames',
                duration,
                1,
                Number.MAX_SAFE_INTEGER,
                1,
              )}
          </div>
          {(start === null || duration === null) && (
            <p>Align timing to the project frame grid to edit it here.</p>
          )}
          <details>
            <summary>Effects</summary>
            {effect('Stroke')}
            <fieldset
              className="text-fields"
              disabled={!effects.Stroke}
              hidden={!effects.Stroke}
            >
              {color('Stroke color', text.stroke?.color ?? '#000000')}
              {number('Stroke width', text.stroke?.width ?? 2, 0, 64)}
            </fieldset>
            {effect('Shadow')}
            <fieldset
              className="text-fields"
              disabled={!effects.Shadow}
              hidden={!effects.Shadow}
            >
              {color('Shadow color', text.shadow?.color ?? '#000000b0')}
              {number('Shadow blur', text.shadow?.blur ?? 4, 0, 64)}
              {number('Shadow X', text.shadow?.x ?? 2, -128, 128)}
              {number('Shadow Y', text.shadow?.y ?? 2, -128, 128)}
            </fieldset>
            {effect('Background')}
            <fieldset
              className="text-fields"
              disabled={!effects.Background}
              hidden={!effects.Background}
            >
              {color('Background color', text.background?.color ?? '#000000b0')}
              {number('Padding', text.background?.padding ?? 8, 0, 128)}
            </fieldset>
          </details>
        </div>
        <button type="submit">Apply text</button>
      </fieldset>
    </form>
  );
}
