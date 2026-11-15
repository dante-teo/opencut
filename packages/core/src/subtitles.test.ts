import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createProject,
  createTimelineEvaluator,
  evaluateTimeline,
  evaluateTimelineFrame,
  inspectTimeline,
  parseSubtitleTime,
  parseSubtitles,
  planProjectRender,
  serializeSubtitles,
  subtitleLanes,
} from './index.js';

const ms = (numerator: number) => ({ numerator, denominator: 1000 });
const fixtures = (format: 'srt' | 'vtt') =>
  readFileSync(
    new URL(
      `../../../tests/fixtures/subtitles/multilingual.${format}`,
      import.meta.url,
    ),
    'utf8',
  );

describe('subtitle sidecars', () => {
  it('round-trips multilingual, multiline and overlapping fixtures through both formats', () => {
    const expected = parseSubtitles(fixtures('srt'), 'srt');
    expect(expected.map((cue) => cue.text)).toEqual([
      'Hello, OpenCut!\n你好，世界！',
      'Overlapping cue\n繁體中文 😀',
    ]);
    expect(parseSubtitles(fixtures('vtt'), 'vtt')).toEqual(expected);
    for (const format of ['srt', 'vtt'] as const)
      expect(
        parseSubtitles(serializeSubtitles(expected, format), format),
      ).toEqual(expected);
  });

  it('handles empty files, empty cues, BOM, CRLF and WebVTT escapes', () => {
    expect(parseSubtitles('', 'srt')).toEqual([]);
    expect(parseSubtitles('\uFEFFWEBVTT\r\n\r\n', 'vtt')).toEqual([]);
    const cues = parseSubtitles(
      '\uFEFFWEBVTT\r\n\r\n00:00.001 --> 00:01.002\r\n<v Narrator><b>A &amp; B</b> &lt;c&gt; --&gt; 😀\r\n\r\n00:02.000 --> 00:03.000\r\n',
      'vtt',
    );
    expect(cues.map((cue) => cue.text)).toEqual(['A & B <c> --> 😀', '']);
    expect(parseSubtitles(serializeSubtitles(cues, 'vtt'), 'vtt')).toEqual(
      cues,
    );
  });

  it('reads spaced SubRip separators and numeric WebVTT character references', () => {
    const srt = fixtures('srt').replace('\n\n2', '\n \t\n2');
    expect(parseSubtitles(srt, 'srt')).toHaveLength(2);
    expect(
      parseSubtitles(
        'WEBVTT\n\n00:00.000 --> 00:01.000\n&#x4E2D;&#25991; &#x1F600;',
        'vtt',
      )[0]?.text,
    ).toBe('中文 😀');
  });

  it('parses a large interior blank separator without rescanning its suffixes', () => {
    const file =
      'WEBVTT' + '\n'.repeat(80_000) + '00:00.000 --> 00:01.000\n字幕';
    const started = performance.now();
    expect(parseSubtitles(file, 'vtt')[0]?.text).toBe('字幕');
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('bounds markup matching when WebVTT cue text contains many unclosed tags', () => {
    const cue = 'WEBVTT\n\n00:00.000 --> 00:01.000\n';
    const malformed = cue + '<b '.repeat(40_000);
    const started = performance.now();
    expect(() => parseSubtitles(malformed, 'vtt')).toThrow('fit within 4096');
    expect(performance.now() - started).toBeLessThan(1500);
    expect(
      parseSubtitles(cue + '<b literal <i>visible</i>', 'vtt')[0]?.text,
    ).toBe('<b literal visible');
  });

  it('validates malformed or reversed times and rejects unrepresentable blank payload lines', () => {
    for (const timing of [
      '00:00:61,500 --> 00:01:02,000',
      '01:00,000 --> 00:30,000',
      'bad --> 00:01.000',
    ])
      expect(() => parseSubtitles('1\n' + timing + '\n你好', 'srt')).toThrow(
        /block 1/i,
      );
    expect(() =>
      parseSubtitles('wrong header\n\n00:00.001 --> 00:01.002', 'vtt'),
    ).toThrow('WEBVTT header');
    expect(() =>
      serializeSubtitles(
        [{ start: ms(0), end: ms(50), text: 'A\n\nB' }],
        'srt',
      ),
    ).toThrow('blank line');
  });

  it('preserves exact editor input and rounds sidecars to milliseconds without collapsing a cue', () => {
    const start = parseSubtitleTime('1/30000');
    const end = parseSubtitleTime('0.0004');
    expect(parseSubtitleTime('00:00:00,105')).toEqual({
      numerator: 21,
      denominator: 200,
    });
    expect(parseSubtitleTime('00:00.1')).toEqual({
      numerator: 1,
      denominator: 10,
    });
    expect(serializeSubtitles([{ start, end, text: 'A' }], 'srt')).toBe(
      '1\n00:00:00,000 --> 00:00:00,001\nA\n',
    );
    expect(
      serializeSubtitles(
        [
          {
            start: parseSubtitleTime('.0006'),
            end: parseSubtitleTime('0.0012'),
            text: 'B',
          },
        ],
        'vtt',
      ),
    ).toContain('00:00:00.000 --> 00:00:00.001');
  });
  it('orders encoded WebVTT starts after keeping sub-millisecond cues nonempty', () => {
    const cues = [
      { start: parseSubtitleTime('.0005'), end: ms(50), text: 'long' },
      {
        start: parseSubtitleTime('.0006'),
        end: parseSubtitleTime('.0012'),
        text: 'short',
      },
    ];
    const encoded = serializeSubtitles(cues, 'vtt');
    expect(
      parseSubtitles(encoded, 'vtt').map((cue) => [cue.start, cue.text]),
    ).toEqual([
      [{ numerator: 0, denominator: 1 }, 'short'],
      [ms(1), 'long'],
    ]);
  });
});

describe('subtitle evaluation', () => {
  it('keeps resolved subtitle timing and style detached from subsequent project mutations', () => {
    const project = createProject({ name: 'Detached preview' });
    project.subtitles = {
      cues: [{ id: 'cue', start: ms(0), end: ms(500), text: '你好' }],
      style: { stroke: { color: '#fff123', width: 3 } },
    };
    const evaluate = createTimelineEvaluator(project, true);
    project.subtitles!.cues[0]!.end.numerator = 1;
    project.subtitles!.style.stroke!.width = 1;
    project.settings.frameRate.numerator = 1;
    expect(evaluate(ms(200)).visualClips[0]).toMatchObject({
      text: { stroke: { width: 3 } },
    });
  });

  it('keeps a later overlap above the lower cue regardless of a tall earlier cue', () => {
    const project = createProject({
      name: 'Independent overlap stacks',
      settings: {
        width: 640,
        height: 360,
        frameRate: { numerator: 30, denominator: 1 },
      },
    });
    const base = {
      id: 'base',
      start: ms(1000),
      end: ms(4000),
      text: 'Lower cue',
    };
    const upper = {
      id: 'upper',
      start: ms(3000),
      end: ms(4000),
      text: 'Upper cue',
    };
    project.subtitles = { style: {}, cues: [upper, base] };
    const expected = evaluateTimelineFrame(project, 105).visualClips;
    project.subtitles.cues.push({
      id: 'earlier',
      start: ms(0),
      end: base.start,
      text: Array(12).fill('Earlier').join('\n'),
    });

    expect(expected.map((clip) => clip.id)).toEqual(['base', 'upper']);
    expect(expected[1]!.visual.y).toBeLessThan(expected[0]!.visual.y);
    expect(evaluateTimelineFrame(project, 105).visualClips).toEqual(expected);
    expect(
      planProjectRender(project).visualClips.find(
        (clip) => clip.clipId === 'upper',
      )?.y,
    ).toBe(expected[1]!.visual.y);
  });

  it('evaluates an exact subtitle interval whose elapsed offset would overflow', () => {
    const start = { numerator: 1, denominator: Number.MAX_SAFE_INTEGER };
    const end = { numerator: 1, denominator: 1 };
    const project = createProject({ name: 'Precise subtitle' });
    project.subtitles = {
      style: {},
      cues: [{ id: 'cue', start, end, text: '你好' }],
    };

    expect(evaluateTimelineFrame(project, 0).visualClips).toEqual([]);
    expect(
      inspectTimeline(project, 'project.json', 1).visualClips,
    ).toMatchObject([
      {
        id: 'cue',
        timelineStart: start,
        timelineEnd: end,
        sourceTime: { numerator: 0, denominator: 1 },
      },
    ]);
    const preview = createTimelineEvaluator(project, true);
    expect(preview(ms(40)).visualClips.map((clip) => clip.id)).toEqual(['cue']);
    expect(preview(end).visualClips).toEqual([]);
    expect(planProjectRender(project).visualClips[0]).toMatchObject({
      clipId: 'cue',
      timelineStartFrame: 1,
      frameCount: 29,
    });
  });

  it('resolves overlapping cue layers on half-open boundaries and samples only at render time', () => {
    const project = createProject({ name: 'Overlap' });
    project.subtitles = {
      style: {},
      cues: parseSubtitles(fixtures('vtt'), 'vtt').map((cue, index) => ({
        ...cue,
        id: `cue-${index}`,
      })),
    };
    const [first, second] = project.subtitles!.cues;
    expect(subtitleLanes(project.subtitles!.cues)).toHaveLength(2);
    expect(
      evaluateTimeline(project, ms(105)).visualClips.map((clip) => clip.id),
    ).toEqual([first!.id]);
    expect(evaluateTimelineFrame(project, 3).visualClips).toEqual([]);
    const overlap = evaluateTimelineFrame(project, 13).visualClips;
    expect(overlap.map((clip) => clip.id)).toEqual([first!.id, second!.id]);
    expect(overlap[1]!.visual.y).toBeLessThan(overlap[0]!.visual.y);
    expect(
      evaluateTimelineFrame(project, 19).visualClips.map((clip) => clip.id),
    ).toEqual([second!.id]);
    const plan = planProjectRender(project);
    expect(plan.frameCount).toBe(28);
    expect(
      plan.visualClips.map((clip) => [
        clip.timelineStartFrame,
        clip.frameCount,
      ]),
    ).toEqual([
      [4, 15],
      [13, 15],
    ]);
    expect(planProjectRender(project, { burnSubtitles: false })).toMatchObject({
      frameCount: 28,
      visualClips: [],
    });
  });
});
