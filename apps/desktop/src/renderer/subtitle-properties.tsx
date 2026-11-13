import { useState, type FormEvent } from 'react';
import {
  compareTimes,
  effectiveSubtitleStyle,
  parseSubtitleTime,
  addTimes,
  subtractTimes,
  type Project,
  type RationalTime,
  type SubtitleCue,
} from '@opencut/core';
import type { TimelineOperation } from '../bridge.js';

function displayTime(time: RationalTime) {
  const scaled = BigInt(time.numerator) * 1000n;
  if (scaled % BigInt(time.denominator) !== 0n)
    return `${time.numerator}/${time.denominator}`;
  const ms = scaled / BigInt(time.denominator);
  const fraction = String(ms % 1000n)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction ? `${ms / 1000n}.${fraction}` : String(ms / 1000n);
}

function displayDuration(start: string, end: string) {
  try {
    return displayTime(
      subtractTimes(parseSubtitleTime(end), parseSubtitleTime(start)),
    );
  } catch {
    return '';
  }
}

export function SubtitleProperties({
  project,
  cue,
  disabled,
  onEdit,
}: {
  project: Project;
  cue: SubtitleCue;
  disabled: boolean;
  onEdit: (operations: TimelineOperation[], label: string) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  function submit(operation: TimelineOperation, label: string) {
    setSubmitting(true);
    void onEdit([operation], label)
      .catch(() => {})
      .finally(() => setSubmitting(false));
  }

  const form = { disabled: disabled || submitting, submit };
  return (
    <div className="text-properties-controls subtitle-properties">
      <SubtitleCueForm key={JSON.stringify(cue)} cue={cue} {...form} />
      <WordTiming
        key={JSON.stringify([cue.id, cue.text, cue.words])}
        cue={cue}
        {...form}
      />
      <form
        key={`${cue.id}:${cue.pop}:${cue.emphasis?.join(',')}`}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          submit(
            {
              type: 'subtitle.effects',
              id: cue.id,
              pop: data.has('pop'),
              emphasis: String(data.get('emphasis') ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            },
            'Set subtitle effects',
          );
        }}
      >
        <fieldset disabled={form.disabled}>
          <label>
            Highlighted words{' '}
            <input name="emphasis" defaultValue={cue.emphasis?.join(', ')} />
          </label>
          <label>
            <input type="checkbox" name="pop" defaultChecked={cue.pop} /> Pop in
          </label>
          <button type="submit">Apply effects</button>
        </fieldset>
      </form>
      <SubtitleStyleForm
        key={JSON.stringify([
          project.settings.width,
          project.settings.height,
          project.subtitles?.style,
        ])}
        style={effectiveSubtitleStyle(project)}
        cues={project.subtitles?.cues ?? []}
        {...form}
      />
    </div>
  );
}

interface SubtitleFormProps {
  disabled: boolean;
  submit: (operation: TimelineOperation, label: string) => void;
}

function WordTiming({
  cue,
  disabled,
  submit,
}: SubtitleFormProps & { cue: SubtitleCue }) {
  const [error, setError] = useState('');
  const spans = [
    ...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(cue.text),
  ]
    .filter((item) => item.isWordLike)
    .slice(0, 128);
  const duration = subtractTimes(cue.end, cue.start);
  const split = (index: number) =>
    displayTime({
      numerator: duration.numerator * index,
      denominator: duration.denominator * Math.max(1, spans.length),
    });
  const [rows, setRows] = useState(() =>
    cue.words?.length
      ? cue.words.map((word) => ({
          ...word,
          start: displayTime(word.start),
          end: displayTime(word.end),
        }))
      : spans.map(({ index, segment }, i) => ({
          from: index,
          to: index + segment.length,
          start: split(i),
          end: split(i + 1),
        })),
  );
  return (
    <details>
      <summary>Word timing</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const words = rows.map((row) => ({
              from: row.from,
              to: row.to,
              start: parseSubtitleTime(row.start),
              end: parseSubtitleTime(row.end),
            }));
            if (
              words.some(
                (word, i) =>
                  compareTimes(word.start, word.end) >= 0 ||
                  compareTimes(addTimes(cue.start, word.end), cue.end) > 0 ||
                  (i > 0 && compareTimes(words[i - 1]!.end, word.start) > 0),
              )
            )
              throw new Error(
                'Enter ordered, non-overlapping times within the cue.',
              );
            setError('');
            submit(
              { type: 'subtitle.words', id: cue.id, words },
              'Set subtitle word timing',
            );
          } catch (cause) {
            setError(String(cause));
          }
        }}
      >
        <fieldset disabled={disabled}>
          {rows.map((row, i) => (
            <div className="text-fields" key={row.from}>
              <span>{cue.text.slice(row.from, row.to)}</span>
              {(['start', 'end'] as const).map((edge) => (
                <label key={edge}>
                  {edge === 'start' ? 'Start' : 'End'} (s)
                  <input
                    value={row[edge]}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setRows((old) =>
                        old.map((item, j) =>
                          i === j ? { ...item, [edge]: value } : item,
                        ),
                      );
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
          <button disabled={!rows.length}>Apply word timing</button>
          {cue.words?.length ? (
            <button
              type="button"
              onClick={() =>
                submit(
                  { type: 'subtitle.words', id: cue.id, words: [] },
                  'Clear subtitle word timing',
                )
              }
            >
              Clear word timing
            </button>
          ) : null}
        </fieldset>
      </form>
    </details>
  );
}

function SubtitleCueForm({
  cue,
  disabled,
  submit,
}: SubtitleFormProps & { cue: SubtitleCue }) {
  const [start, setStart] = useState(displayTime(cue.start));
  const [end, setEnd] = useState(displayTime(cue.end));
  const [duration, setDuration] = useState<string | null>(null);
  const [error, setError] = useState('');
  return (
    <form
      className="text-properties"
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        try {
          const data = new FormData(event.currentTarget);
          const from = parseSubtitleTime(start);
          const timing =
            duration !== null
              ? { duration: parseSubtitleTime(duration) }
              : { end: parseSubtitleTime(end) };
          if (
            'end' in timing
              ? compareTimes(timing.end!, from) <= 0
              : timing.duration.numerator === 0
          )
            throw new Error('Subtitle end must be later than start.');
          submit(
            {
              type: 'subtitle.set',
              id: cue.id,
              text: String(data.get('text')),
              start: from,
              ...timing,
            },
            'Edit subtitle',
          );
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }}
    >
      <fieldset disabled={disabled}>
        <h3>Subtitle cue</h3>
        <label>
          Subtitle text
          <textarea
            name="text"
            maxLength={4096}
            rows={3}
            defaultValue={cue.text}
          />
        </label>
        <div className="text-fields">
          <label>
            Start seconds
            <input
              required
              value={start}
              onChange={(event) => setStart(event.currentTarget.value)}
            />
          </label>
          <label>
            End seconds
            <input
              required={duration === null}
              value={duration === null ? end : ''}
              placeholder={duration === null ? undefined : 'Set by duration'}
              onChange={(event) => {
                setEnd(event.currentTarget.value);
                setDuration(null);
              }}
            />
          </label>
          <label>
            Duration seconds
            <input
              required={duration !== null}
              value={duration ?? displayDuration(start, end)}
              onChange={(event) => setDuration(event.currentTarget.value)}
            />
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Apply subtitle</button>
      </fieldset>
    </form>
  );
}

function SubtitleStyleForm({
  style,
  cues,
  disabled,
  submit,
}: SubtitleFormProps & {
  style: ReturnType<typeof effectiveSubtitleStyle>;
  cues: SubtitleCue[];
}) {
  const [outline, setOutline] = useState(!!style.stroke);
  const [shadow, setShadow] = useState(!!style.shadow);
  const [background, setBackground] = useState(!!style.background);
  const [styleDraft, setStyleDraft] = useState<Record<string, string>>({});
  const styleField = (name: string, initial: string | number) => ({
    name,
    value: styleDraft[name] ?? String(initial),
    onInput: (event: FormEvent<HTMLInputElement>) => {
      const value = event.currentTarget.value;
      setStyleDraft((previous) => ({ ...previous, [name]: value }));
    },
  });

  const color = (name: string, initial: string) => (
    <label>
      {name}
      <input
        {...styleField(name, initial)}
        required
        pattern="(?:#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|transparent)"
      />
    </label>
  );
  const number = (name: string, initial: number, min: number, max: number) => (
    <label>
      {name}
      <input
        {...styleField(name, initial)}
        type="number"
        step="any"
        required
        min={min}
        max={max}
      />
    </label>
  );
  return (
    <form
      className="text-properties"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const value = (name: string) => String(data.get(name));
        const amount = (name: string) => Number(data.get(name));
        submit(
          {
            type: 'subtitle.style',
            ...(data.getAll('cue-ids').length && {
              ids: data.getAll('cue-ids').map(String),
            }),
            style: {
              fontFamily: value('Subtitle font'),
              fontSize: amount('Subtitle size'),
              color: value('Subtitle color'),
              x: amount('Horizontal offset'),
              y: amount('Vertical offset'),
              stroke: outline
                ? {
                    color: value('Outline color'),
                    width: amount('Outline width'),
                  }
                : null,
              shadow: shadow
                ? {
                    color: value('Subtitle shadow color'),
                    x: amount('Subtitle shadow X'),
                    y: amount('Subtitle shadow Y'),
                    blur: amount('Subtitle shadow blur'),
                  }
                : null,
              background: background
                ? {
                    color: value('Subtitle background color'),
                    padding: amount('Subtitle padding'),
                  }
                : null,
            },
          },
          'Edit subtitle style',
        );
      }}
    >
      <fieldset disabled={disabled}>
        <h3>Shared subtitle style</h3>
        <label>
          Subtitle font
          <input
            {...styleField('Subtitle font', style.fontFamily)}
            required
            maxLength={120}
          />
        </label>
        <div className="text-fields">
          {number('Subtitle size', style.fontSize, 1, 512)}
          {color('Subtitle color', style.color)}
          {number('Horizontal offset', style.x, -32768, 32768)}
          {number('Vertical offset', style.y, -32768, 32768)}
        </div>
        <label className="text-effect">
          <input
            type="checkbox"
            checked={outline}
            onChange={(event) => setOutline(event.currentTarget.checked)}
          />
          Outline
        </label>
        {outline && (
          <div className="text-fields">
            {color('Outline color', style.stroke?.color ?? '#000000')}
            {number('Outline width', style.stroke?.width ?? 2, 0, 64)}
          </div>
        )}
        <label className="text-effect">
          <input
            type="checkbox"
            checked={shadow}
            onChange={(event) => setShadow(event.currentTarget.checked)}
          />{' '}
          Shadow
        </label>
        {shadow && (
          <div className="text-fields">
            {color('Subtitle shadow color', style.shadow?.color ?? '#000000b0')}
            {number('Subtitle shadow X', style.shadow?.x ?? 2, -128, 128)}
            {number('Subtitle shadow Y', style.shadow?.y ?? 2, -128, 128)}
            {number('Subtitle shadow blur', style.shadow?.blur ?? 4, 0, 64)}
          </div>
        )}
        <label className="text-effect">
          <input
            type="checkbox"
            checked={background}
            onChange={(event) => setBackground(event.currentTarget.checked)}
          />
          Background
        </label>
        {background && (
          <div className="text-fields">
            {color(
              'Subtitle background color',
              style.background?.color ?? '#000000b0',
            )}
            {number('Subtitle padding', style.background?.padding ?? 6, 0, 128)}
          </div>
        )}
        <details>
          <summary>Apply to selected cues</summary>
          <select multiple name="cue-ids" aria-label="Subtitle cues" size={4}>
            {cues.map((cue) => (
              <option key={cue.id} value={cue.id}>
                {displayTime(cue.start)} · {cue.text.slice(0, 60)}
              </option>
            ))}
          </select>
        </details>
        <button type="submit">Apply subtitle style</button>
      </fieldset>
    </form>
  );
}
