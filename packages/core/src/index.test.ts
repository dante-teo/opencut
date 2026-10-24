import { describe, expect, it } from 'vitest';
import { getApplicationInfo } from './index.js';

describe('headless application identity', () => {
  it('returns application identity without a desktop runtime', () => {
    expect(getApplicationInfo()).toEqual({ name: 'OpenCut', version: '0.1.0' });
    expect(process.versions).not.toHaveProperty('electron');
  });
});
