import { describe, expect, it } from 'vitest';
import {
  detectDialogue,
  dialogueCurve,
  musicCurve,
} from './dialogue-analysis.js';
import type { DialogueProfile } from './dialogue-analysis.js';

const window = 4800;
const profile = (levels: number[]): DialogueProfile => ({
  floor: -74,
  windows: levels.map((level, i) => ({
    from: i * window,
    to: (i + 1) * window,
    level,
    tone: -3,
  })),
});

describe('dialogue automation', () => {
  it('limits gain changes to phrases and excludes muted windows', () => {
    const data = profile([
      -80, -34, -36, -34, -80, -80, -80, -80, -31, -31, -80,
    ]);
    const gainAt = (sample: number) => (sample >= 8 * window ? 0 : 1);
    const activity = detectDialogue(data, 0, 11 * window, gainAt);
    expect(activity.phrases).toEqual([{ from: window, to: 4 * window }]);
    const keys = dialogueCurve(
      data,
      activity,
      -24,
      0.5,
      0,
      11 * window,
      gainAt,
    );
    expect(keys).toEqual([
      { sample: 2400, db: 0 },
      { sample: 4800, db: 5 },
      { sample: 19200, db: 5 },
      { sample: 22800, db: 0 },
    ]);
  });
  it('detects sparse speech above stationary room tone and ducks music for it', () => {
    const levels = Array<number>(100).fill(-52);
    expect(
      detectDialogue(profile(levels), 0, 100 * window, () => 1).phrases,
    ).toEqual([]);
    levels.fill(-18, 65, 70);
    const activity = detectDialogue(profile(levels), 0, 100 * window, () => 1);
    expect(activity.phrases).toEqual([{ from: 65 * window, to: 70 * window }]);
    expect(activity.level).toBe(-18);
    expect(
      musicCurve(
        activity.phrases,
        { depthDb: 12, attackMs: 200, holdMs: 200, releaseMs: 300 },
        100 * window,
      ),
    ).toEqual([
      { sample: 63 * window, db: 0 },
      { sample: 65 * window, db: -12 },
      { sample: 72 * window, db: -12 },
      { sample: 75 * window, db: 0 },
    ]);
  });

  it('merges multiple tracks and holds through short pauses', () => {
    const timing = { depthDb: 12, attackMs: 200, holdMs: 200, releaseMs: 300 };
    const keys = musicCurve(
      [
        { from: 70000, to: 95000 },
        { from: 14000, to: 50000 },
        { from: 180000, to: 190000 },
      ],
      timing,
      220000,
    );
    expect(keys).toEqual([
      { sample: 4400, db: 0 },
      { sample: 14000, db: -12 },
      { sample: 104600, db: -12 },
      { sample: 119000, db: 0 },
      { sample: 170400, db: 0 },
      { sample: 180000, db: -12 },
      { sample: 199600, db: -12 },
      { sample: 214000, db: 0 },
    ]);
    expect(musicCurve([{ from: 0, to: 4000 }], timing, 4500)).toEqual([
      { sample: 0, db: -12 },
      { sample: 4500, db: -12 },
    ]);
  });
});
