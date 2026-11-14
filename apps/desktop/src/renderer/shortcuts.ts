export type TimelineAction =
  | 'delete'
  | 'split'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'insert'
  | 'duplicate'
  | 'rippleDelete'
  | 'rippleAll'
  | 'closeGap'
  | 'link'
  | 'unlink'
  | 'marker';

export type ShortcutAction =
  | TimelineAction
  | 'play'
  | 'undo'
  | 'redo'
  | 'save'
  | 'previousFrame'
  | 'nextFrame';

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
  mac = /Mac/i.test(navigator.platform),
): ShortcutAction | null {
  if (event.altKey || event.repeat || event.isComposing) return null;
  const key = event.key.toLowerCase();
  const primary = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (primary) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 's' && !event.shiftKey) return 'save';
    if (key === 'v') return event.shiftKey ? 'insert' : 'paste';
    if (!event.shiftKey) {
      if (key === 'c') return 'copy';
      if (key === 'x') return 'cut';
      if (key === 'd') return 'duplicate';
    }
    return null;
  }
  if (event.metaKey || event.ctrlKey) return null;
  if (event.shiftKey)
    return key === 'delete' || key === 'backspace' ? 'rippleDelete' : null;
  const plain: Record<string, ShortcutAction> = {
    ' ': 'play',
    delete: 'delete',
    backspace: 'delete',
    s: 'split',
    m: 'marker',
    arrowleft: 'previousFrame',
    arrowright: 'nextFrame',
  };
  return plain[key] ?? null;
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
    (!!target.closest('button, summary, [role="tab"]') &&
      [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key))
  );
}
