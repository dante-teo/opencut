import { expect, it } from 'vitest';
import { shortcutAction } from '../../apps/desktop/src/renderer/shortcuts.js';

const key = (key: string, flags = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  ...flags,
});
it('maps macOS and other-platform command keys and excludes modified typing, repeats and composition', () => {
  for (const mac of [true, false]) {
    const modifier = mac ? { metaKey: true } : { ctrlKey: true };
    expect(shortcutAction(key('z', modifier), mac)).toBe('undo');
    expect(shortcutAction(key('Z', { ...modifier, shiftKey: true }), mac)).toBe(
      'redo',
    );
    expect(shortcutAction(key('s', modifier), mac)).toBe('save');
    expect(
      shortcutAction(key('s', { ...modifier, shiftKey: true }), mac),
    ).toBeNull();
    expect(
      shortcutAction(
        key('z', mac ? { ctrlKey: true } : { metaKey: true }),
        mac,
      ),
    ).toBeNull();
  }
  for (const [value, action] of [
    [' ', 'play'],
    ['s', 'split'],
    ['Delete', 'delete'],
    ['Backspace', 'delete'],
    ['ArrowLeft', 'previousFrame'],
    ['ArrowRight', 'nextFrame'],
  ]) {
    expect(shortcutAction(key(value!), true)).toBe(action);
    for (const flags of [
      { altKey: true },
      { repeat: true },
      { isComposing: true },
      { shiftKey: true },
    ])
      expect(shortcutAction(key(value!, flags), true)).toBeNull();
  }
});
