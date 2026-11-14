export type ShortcutAction = 'play' | 'previousFrame' | 'nextFrame';

export function shortcutAction(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'metaKey'
    | 'ctrlKey'
    | 'altKey'
    | 'shiftKey'
    | 'repeat'
    | 'isComposing'
  >,
): ShortcutAction | null {
  if (
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing
  )
    return null;
  if (event.key === ' ') return 'play';
  if (event.key === 'ArrowLeft') return 'previousFrame';
  if (event.key === 'ArrowRight') return 'nextFrame';
  return null;
}

/** Native controls keep editing, activation and navigation keys. */
export function shortcutOwnsKeys(
  target: EventTarget | null,
  key = '',
): boolean {
  if (!(target instanceof Element)) return false;
  return (
    !!target.closest(
      'input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="spinbutton"], audio, video',
    ) ||
    (!!target.closest('button, summary, [role="tab"], [role="button"]') &&
      [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key))
  );
}
