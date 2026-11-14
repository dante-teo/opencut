import { expect, it } from 'vitest';
import { shortcutAction } from '../../apps/desktop/src/renderer/shortcuts.js';

it('maps playback shortcuts and leaves editing and modified keys alone', () => {
  const event = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
  };
  expect(shortcutAction({ ...event, key: ' ' })).toBe('play');
  expect(shortcutAction({ ...event, key: 'ArrowLeft' })).toBe('previousFrame');
  expect(shortcutAction({ ...event, key: 'ArrowRight' })).toBe('nextFrame');
  for (const key of ['Delete', 's', 'm'])
    expect(shortcutAction({ ...event, key })).toBeNull();
  expect(shortcutAction({ ...event, key: 'z', metaKey: true })).toBeNull();
  expect(
    shortcutAction({ ...event, key: 'ArrowRight', repeat: true }),
  ).toBeNull();
});
