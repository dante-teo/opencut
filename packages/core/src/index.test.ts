import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import { getApplicationInfo } from './index.js';

describe('headless application identity', () => {
  it('returns application identity without a desktop runtime', () => {
    expect(getApplicationInfo()).toEqual({
      name: 'OpenCut',
      version: manifest.version,
    });
    expect(process.versions).not.toHaveProperty('electron');
  });
});
