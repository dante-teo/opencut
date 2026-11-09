import { describe, expect, it } from 'vitest';
import {
  clipDuration,
  createProject,
  deserializeProject,
  evaluateTimelineFrame,
  executeTransaction,
  frameTime,
  parseClipSpeed,
  planProjectRender,
  redoEdit,
  serializeProject,
  setClipSpeed,
  undoEdit,
  type Project,
} from './index.js';

const rate = { numerator: 30, denominator: 1 };
const time = (frame: number) => frameTime(frame, rate);

function fixture(): Project {
  const project = createProject({
    name: 'Speed',
    settings: { width: 320, height: 180, frameRate: rate },
  });
  project.assets.push({
    id: 'asset',
    name: 'Source',
    mediaTypes: ['video', 'audio'],
    duration: time(180),
    file: { type: 'relative', path: 'source.mp4' },
  });
  project.tracks.push(
    { id: 'v', name: 'Video', type: 'video' },
    { id: 'a', name: 'Audio', type: 'audio' },
  );
  project.clips.push({
    id: 'clip',
    assetId: 'asset',
    trackId: 'v',
    timelineStart: time(6),
    sourceIn: time(30),
    sourceOut: time(91),
  });
  return project;
}

describe('constant clip speed', () => {
  it.each([
    ['0.25', 244],
    ['0.5', 122],
    ['1.5', 41],
    ['2', 31],
    ['4', 16],
  ] as const)(
    'compiles %s with exact source points and a ceiling on the output frame count',
    (input, count) => {
      const speed = parseClipSpeed(input);
      const { project, clip } = setClipSpeed(fixture(), 'clip', speed);
      expect(clip.sourceIn).toEqual(time(30));
      expect(clip.sourceOut).toEqual(time(91));
      expect(
        evaluateTimelineFrame(project, 6).activeClips[0]?.sourceTime,
      ).toEqual(time(30));
      expect(evaluateTimelineFrame(project, 6 + count).activeClips).toEqual([]);
      const plan = planProjectRender(project);
      expect(plan.frameCount).toBe(6 + count);
      expect(plan.visualClips[0]).toMatchObject({
        frameCount: count,
        retiming: {
          speed,
          sourceOriginNs: 1_000_000_000 - 200_000_000 * Number(input),
        },
      });
      expect(plan.audioClips[0]).toMatchObject({
        frameCount: count,
        retiming: { speed, sourceIn: time(30), sourceOut: time(91) },
      });
    },
  );

  it('splits at the exact mapped source instant and retains it through trim, undo, redo and reload', () => {
    const baseline = fixture();
    const speed = parseClipSpeed('3/2');
    const changed = executeTransaction(baseline, {
      expectedRevision: 0,
      operations: [
        { type: 'clip.speed', id: 'clip', speed },
        { type: 'clip.split', id: 'clip', at: 7, rightId: 'right' },
        {
          type: 'clip.trim',
          id: 'right',
          outTime: { numerator: 181, denominator: 60 },
        },
      ],
    }).project;
    const saved = deserializeProject(serializeProject(changed));
    const [left, right] = saved.clips;
    expect(left?.sourceOut).toEqual({ numerator: 21, denominator: 20 });
    expect(right?.sourceIn).toEqual(left?.sourceOut);
    expect(right?.speed).toEqual(speed);
    expect(evaluateTimelineFrame(saved, 8).activeClips[0]?.sourceTime).toEqual(
      time(33),
    );
    const undone = undoEdit(saved);
    expect(undone.clips).toEqual(baseline.clips);
    expect(redoEdit(undone).clips).toEqual(saved.clips);
    const normal = setClipSpeed(saved, 'right', parseClipSpeed('1')).project;
    expect(
      planProjectRender(normal).visualClips[1]?.retiming?.sourceOriginNs,
    ).toEqual(816_666_666);
  });

  it('samples a high-precision rate even when the source instant exceeds JSON fraction precision', () => {
    const project = fixture();
    project.clips[0]!.timelineStart = time(0);
    project.clips[0]!.sourceOut = time(90);
    const sped = setClipSpeed(
      project,
      'clip',
      parseClipSpeed('1.000000000000001'),
    ).project;
    const source = evaluateTimelineFrame(sped, 1).activeClips[0]!.sourceTime;
    expect(source.numerator / source.denominator).toBeCloseTo(31 / 30, 8);
    expect(() => planProjectRender(sped)).not.toThrow();
  });

  it('rejects invalid speeds, same-track collisions and fades that no longer fit', () => {
    const project = fixture();
    project.clips.push({
      ...project.clips[0]!,
      id: 'neighbor',
      timelineStart: time(70),
    });
    const original = serializeProject(project);
    expect(() => setClipSpeed(project, 'clip', parseClipSpeed('0.5'))).toThrow(
      /overlaps/,
    );
    expect(() =>
      setClipSpeed(project, 'clip', { numerator: 1, denominator: 5 }),
    ).toThrow(/0.25/);
    expect(() => parseClipSpeed('1/0')).toThrow();
    expect(serializeProject(project)).toEqual(original);
    const faded = fixture();
    faded.clips[0]!.fadeIn = { duration: time(30) };
    expect(() => setClipSpeed(faded, 'clip', parseClipSpeed('4'))).toThrow(
      /Fade durations/,
    );
    const changed = setClipSpeed(faded, 'clip', parseClipSpeed('3/2')).project;
    expect(changed.clips[0]?.fadeIn).toEqual(faded.clips[0]?.fadeIn);
    expect(clipDuration(changed.clips[0]!)).toEqual({
      numerator: 61,
      denominator: 45,
    });
  });

  it('retimes cross-track audio without moving subtitle cues', () => {
    const project = fixture();
    project.clips.push({
      ...project.clips[0]!,
      id: 'voice',
      trackId: 'a',
      speed: parseClipSpeed('1/2'),
    });
    project.subtitles = {
      style: {},
      cues: [
        { id: 'subtitle', text: 'Subtitle', start: time(20), end: time(40) },
      ],
    };
    const changed = setClipSpeed(project, 'clip', parseClipSpeed('4')).project;
    const evaluation = evaluateTimelineFrame(changed, 21);
    expect(evaluation.visualClips.map(({ id }) => id)).toEqual([
      'clip',
      'subtitle',
    ]);
    expect(
      evaluation.audioClips.map(({ id, sourceTime }) => [id, sourceTime]),
    ).toEqual([
      ['clip', time(90)],
      ['voice', { numerator: 5, denominator: 4 }],
    ]);
    expect(changed.subtitles).toEqual(project.subtitles);
  });
});
