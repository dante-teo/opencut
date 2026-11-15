import { describe, expect, it } from 'vitest';
import {
  clipDuration,
  createProject,
  evaluateTimelineFrame,
  frameTime,
  parseClipSpeed,
  planProjectRender,
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
      const project = fixture();
      const clip = project.clips[0]!;
      clip.speed = speed;
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

  it('samples a high-precision rate even when the source instant exceeds JSON fraction precision', () => {
    const project = fixture();
    project.clips[0]!.timelineStart = time(0);
    project.clips[0]!.sourceOut = time(90);
    project.clips[0]!.speed = parseClipSpeed('1.000000000000001');
    const source = evaluateTimelineFrame(project, 1).activeClips[0]!.sourceTime;
    expect(source.numerator / source.denominator).toBeCloseTo(31 / 30, 8);
    expect(() => planProjectRender(project)).not.toThrow();
  });

  it('rejects invalid speeds, same-track collisions and fades that no longer fit', () => {
    const project = fixture();
    project.clips.push({
      ...project.clips[0]!,
      id: 'neighbor',
      timelineStart: time(70),
    });
    project.clips[0]!.speed = parseClipSpeed('0.5');
    expect(() => planProjectRender(project)).toThrow(/overlaps/);
    project.clips[0]!.speed = { numerator: 1, denominator: 5 };
    expect(() => planProjectRender(project)).toThrow(/0.25/);
    expect(() => parseClipSpeed('1/0')).toThrow();
    const faded = fixture();
    faded.clips[0]!.fadeIn = { duration: time(30) };
    faded.clips[0]!.speed = parseClipSpeed('4');
    expect(() => planProjectRender(faded)).toThrow(/Fade durations/);
    faded.clips[0]!.speed = parseClipSpeed('3/2');
    expect(clipDuration(faded.clips[0]!)).toEqual({
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
    project.clips[0]!.speed = parseClipSpeed('4');
    const evaluation = evaluateTimelineFrame(project, 21);
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
  });
});
