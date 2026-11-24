import { useState } from 'react';
import type { FormEventHandler } from 'react';
import type {
  MotionEdit,
  MotionGraphics as Graphics,
} from '@opencut/core/video';

type SubmitEdit = (
  read: (data: FormData, action: string | null | undefined) => MotionEdit,
) => FormEventHandler<HTMLFormElement>;
type ImportSettings = Pick<
  Extract<MotionEdit, { operation: 'import' }>,
  'options' | 'props' | 'resources'
>;
type Clip = Graphics['clips'][number];
type Asset = Graphics['assets'][number];

function frame(data: FormData, name: string) {
  const value = String(data.get(name) ?? '');
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Enter a whole, nonnegative frame number.');
  return Number(value);
}

function FrameInput({
  label,
  name,
  initial,
}: {
  label: string;
  name: string;
  initial: number;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type="number"
        min={0}
        step={1}
        defaultValue={initial}
        required
      />
    </label>
  );
}

function MotionClip({
  clip,
  asset,
  playhead,
  submit,
}: {
  clip: Clip;
  asset: Asset;
  playhead: number;
  submit: SubmitEdit;
}) {
  const crossesTransition =
    playhead < (clip.splitLimits?.earliest ?? 0) ||
    playhead > (clip.splitLimits?.latest ?? Infinity);
  const handleSubmit = submit((data, action) => {
    if (action === 'split')
      return { operation: 'split', clip: clip.id, at: playhead };
    if (action === 'duplicate')
      return { operation: 'duplicate', clip: clip.id, at: frame(data, 'at') };
    const overrides: Clip['props'] = {};
    for (const [key, type] of Object.entries(asset.parameters)) {
      const value = data.get('prop-' + key);
      const resolved: Clip['props'][string] =
        type === 'boolean'
          ? value === 'on'
          : type === 'number'
            ? Number(value)
            : type === 'json'
              ? JSON.parse(String(value))
              : String(value);
      if (JSON.stringify(resolved) !== JSON.stringify(asset.defaults[key]))
        overrides[key] = resolved;
    }
    return {
      operation: 'change',
      clip: clip.id,
      at: frame(data, 'at'),
      sourceIn: frame(data, 'sourceIn'),
      sourceOut: frame(data, 'sourceOut'),
      props: overrides,
    };
  });
  return (
    <form onSubmit={handleSubmit} aria-label="Selected motion clip">
      <div className="motion-fields">
        <FrameInput label="Timeline start" name="at" initial={clip.at} />
        <FrameInput label="Source in" name="sourceIn" initial={clip.sourceIn} />
        <FrameInput
          label="Source out (exclusive)"
          name="sourceOut"
          initial={clip.sourceOut}
        />
        {Object.entries(asset.parameters).map(([key, type]) => {
          const value = Object.hasOwn(clip.props, key)
            ? clip.props[key]
            : asset.defaults[key];
          const name = 'prop-' + key;
          return (
            <label key={key}>
              {key}
              {type === 'boolean' ? (
                <input
                  name={name}
                  type="checkbox"
                  defaultChecked={value === true}
                />
              ) : type === 'json' ? (
                <textarea
                  name={name}
                  defaultValue={JSON.stringify(value)}
                  required
                />
              ) : (
                <input
                  name={name}
                  type={type === 'number' ? 'number' : 'text'}
                  step={type === 'number' ? 'any' : undefined}
                  defaultValue={String(value)}
                  required={type === 'number'}
                />
              )}
            </label>
          );
        })}
      </div>
      <div className="motion-actions">
        <button type="submit">Save edit as…</button>
        <button
          type="submit"
          value="duplicate"
          title="Duplicate at the entered timeline start"
        >
          Duplicate at start…
        </button>
        <button
          type="submit"
          value="split"
          formNoValidate
          title={
            crossesTransition
              ? 'Move the playhead to or outside the edge of the transition.'
              : undefined
          }
          disabled={
            crossesTransition ||
            playhead <= clip.at ||
            playhead >= clip.at + clip.sourceOut - clip.sourceIn
          }
        >
          Split at frame {playhead}…
        </button>
      </div>
    </form>
  );
}

export function MotionGraphics({
  graphics,
  generation,
  onEdit,
  selected,
  playhead,
  disabled,
}: {
  graphics: Graphics;
  generation: number;
  onEdit: (edit: MotionEdit) => Promise<boolean>;
  selected: string | null;
  playhead: number;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clip = graphics.clips.find(({ id }) => id === selected);
  const asset = graphics.assets.find(({ id }) => id === clip?.asset);

  const submit: SubmitEdit = (read) => async (event) => {
    event.preventDefault();
    try {
      const edit = read(
        new FormData(event.currentTarget),
        (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value'),
      );
      setError(undefined);
      setBusy(true);
      await onEdit(edit);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="motion-panel">
      <summary>Motion graphics</summary>
      <fieldset disabled={disabled || busy}>
        {clip && asset && (
          <MotionClip
            key={generation + ':' + clip.id}
            clip={clip}
            asset={asset}
            playhead={playhead}
            submit={submit}
          />
        )}
        {graphics.assets.length > 0 && (
          <form
            key={generation}
            onSubmit={submit((data) => ({
              operation: 'add',
              asset: String(data.get('asset')),
              at: frame(data, 'at'),
            }))}
            aria-label="Add motion clip"
          >
            <div className="motion-fields">
              <label>
                Composition
                <select name="asset">
                  {graphics.assets.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <FrameInput label="Timeline start" name="at" initial={playhead} />
              <button type="submit">Add clip as…</button>
            </div>
          </form>
        )}
        <details>
          <summary>Import React composition</summary>
          <form
            onSubmit={submit((data) => ({
              ...(JSON.parse(
                String(data.get('config') ?? '{}'),
              ) as ImportSettings),
              operation: 'import',
              at: frame(data, 'at'),
              duration: frame(data, 'duration'),
            }))}
          >
            <div className="motion-fields">
              <FrameInput label="Timeline start" name="at" initial={playhead} />
              <FrameInput
                label="Source duration (frames)"
                name="duration"
                initial={90}
              />
              <label>
                Composition settings (JSON)
                <textarea
                  name="config"
                  defaultValue={'{"options":{},"props":{}}'}
                />
              </label>
              <button type="submit">Choose TSX and save as…</button>
            </div>
          </form>
        </details>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
