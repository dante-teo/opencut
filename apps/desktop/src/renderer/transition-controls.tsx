import { Blend, Trash2 } from 'lucide-react';
import type { Ref } from 'react';
import { transitionOwner } from '@opencut/core';
import type { Transition, TransitionInput } from '@opencut/core';
import type { TimelineOperation } from '../bridge.js';
import { NumberProperty } from './clip-properties.js';

export const transitionNames = {
  'cross-dissolve': 'Cross-dissolve',
  'fade-in': 'Fade in',
  'fade-out': 'Fade out',
};

export function TransitionControls({
  menuRef,
  clipId,
  previousId,
  transitions,
  disabled,
  onEdit,
}: {
  menuRef: Ref<HTMLDetailsElement>;
  clipId: string;
  previousId: string | undefined;
  transitions: Transition[];
  disabled: boolean;
  onEdit:
    | ((operations: TimelineOperation[], label: string) => Promise<void>)
    | undefined;
}) {
  const editingDisabled = disabled || !onEdit;
  return (
    <details className="subtitle-menu" ref={menuRef}>
      <summary>
        <Blend aria-hidden="true" /> Transitions
      </summary>
      <div className="subtitle-actions transition-actions">
        <form
          key={clipId}
          onSubmit={(event) => {
            event.preventDefault();
            const frames = Number(
              new FormData(event.currentTarget).get('frames'),
            );
            const kind = (
              event.nativeEvent as SubmitEvent
            ).submitter?.getAttribute('value');
            let transition: TransitionInput;
            if (kind === 'cross-dissolve' && previousId)
              transition = {
                kind,
                from: previousId,
                to: clipId,
                frames,
              };
            else if (kind === 'fade-in' || kind === 'fade-out')
              transition = { kind, clipId, frames };
            else return;
            void onEdit?.(
              [{ type: 'transition.add', transition }],
              'Add video transition',
            );
          }}
        >
          <label>
            Transition frames{' '}
            <input
              type="number"
              name="frames"
              min={2}
              defaultValue={6}
              required
            />
          </label>
          {(['cross-dissolve', 'fade-in', 'fade-out'] as const).map((kind) => (
            <button
              key={kind}
              type="submit"
              value={kind}
              disabled={
                editingDisabled ||
                (kind === 'cross-dissolve' && !previousId) ||
                transitions.some(
                  (transition) =>
                    transition.kind === kind &&
                    transitionOwner(transition) === clipId,
                )
              }
            >
              {transitionNames[kind]}
            </button>
          ))}
        </form>
        {transitions.map((transition) => (
          <div className="transition-duration" key={transition.id}>
            <NumberProperty
              label={`${transitionNames[transition.kind]} duration (frames)`}
              value={transition.frames}
              min={2}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              disabled={editingDisabled}
              onCommit={(frames) =>
                onEdit?.(
                  [
                    {
                      type: 'transition.set',
                      id: transition.id,
                      frames,
                    },
                  ],
                  'Set video transition duration',
                ) ?? Promise.resolve()
              }
            />
            <button
              type="button"
              disabled={editingDisabled}
              aria-label={`Remove ${transitionNames[transition.kind]}`}
              onClick={() =>
                void onEdit?.(
                  [{ type: 'transition.remove', id: transition.id }],
                  'Remove video transition',
                )
              }
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
