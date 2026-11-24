import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import {
  compileVideo,
  packageVideo,
  previewVideo,
  renderCompiledVideo,
} from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import { evaluateTimeline, frameTime } from '@opencut/core';
import {
  describeMotionGraphics,
  editMotionDefinition,
  inspectGraphicFrames,
} from '@opencut/core/video';
import { openReactGraphics } from '../../packages/graphics/dist/renderer.js';
import { fixtureDirectory } from '../fixture-paths.js';
import {
  compareRgb,
  decodeFrames,
  ffmpeg,
  verifyVideoTimestamps,
} from './media-comparison.js';

const width = 160;
const height = 90;
const frameRate = { numerator: 30000, denominator: 1001 };
const durationFrames = 24;
const component = `
import { useRef } from 'react';
import { createSpring, svg } from 'animejs';
import { useGraphicTimeline } from '@opencut/graphics/anime';
import { useGraphicResource, useGraphicSvgId, useGraphicRandom } from '@opencut/graphics/react';
export default function Sample({ ink }) {
  const root = useRef(null);
  const mask = useGraphicSvgId();
  const badge = useGraphicResource('badge');
  const random = useGraphicRandom();
  useGraphicTimeline(root, (timeline, element) => {
    timeline
      .add('.moving', { translateX: [0, 47], duration: 330, ease: createSpring({ stiffness: 140, damping: 20 }) }, 0)
      .add('.moving', { opacity: [1, .45], duration: 300, ease: 'linear' }, 340)
      .add('.shape', { d: svg.morphTo(element.querySelector('.target'), 0), duration: 340, ease: 'linear' }, 140);
  });
  return <svg ref={root} width="160" height="90">
    <defs><clipPath id={mask}><rect x="0" y="0" width="115" height="90" /></clipPath></defs>
    <g clipPath={'url(#' + mask + ')'}>
      <g className="moving">
        <rect x="12" y="25" width="32" height="24" fill={ink} />
        <path className="shape" fill={ink} d="M12 52 L52 52 L32 74 Z" />
      </g>
    </g>
    <path className="target" visibility="hidden" d="M12 52 L52 63 L12 74 Z" />
    <image href={badge} x={125 + random('badge') * 4} y="28" width="16" height="16" />
  </svg>;
}
`;
const graphic = {
  kind: 'graphic',
  renderer: 'react',
  path: 'Sample.tsx',
  durationFrames,
  animation: { version: 1, seed: 456, parameters: { ink: 'string' } },
  resources: { badge: 'badge.svg' },
  props: { ink: '#f08060' },
} as const;
const definition: VideoDefinition = {
  canvas: { width, height, frameRate, durationFrames },
  assets: {
    motion: graphic,
    backdrop: { kind: 'graphic', renderer: 'svg', path: 'backdrop.svg' },
  },
  tracks: [
    { type: 'video', clips: [{ asset: 'backdrop', at: 0, duration: 24 }] },
    {
      id: 'graphics-track',
      type: 'video',
      clips: [
        {
          id: 'first',
          asset: 'motion',
          at: 0,
          sourceOut: 14,
          keyframes: {
            opacity: [
              {
                time: { numerator: 0, denominator: 1 },
                value: 0.6,
                easing: 'ease-in-out',
              },
              {
                time: { numerator: 7 * 1001, denominator: 30000 },
                value: 1,
                easing: 'linear',
              },
            ],
          },
        },
        {
          id: 'second',
          asset: 'motion',
          at: 15,
          sourceIn: 13,
          sourceOut: 22,
          props: { ink: '#50d7a3' },
        },
      ],
    },
    {
      type: 'video',
      clips: [
        {
          id: 'simultaneous',
          asset: 'motion',
          at: 4,
          sourceIn: 12,
          sourceOut: 19,
          props: { ink: '#ebdb90' },
          visual: { x: 40, y: -14, scale: 0.55, opacity: 0.8 },
        },
      ],
    },
  ],
};

function svgRect(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${color}"/></svg>`;
}

test(
  'Anime.js samples match under shuffled and clean seeks, including alpha and split continuity',
  { timeout: 65_000 },
  async () => {
    await mkdir(fixtureDirectory, { recursive: true });
    const dir = await mkdtemp(join(fixtureDirectory, 'anime-seek-'));
    const source = join(dir, 'edit.video.ts');
    const write = (path: string, value: VideoDefinition) =>
      writeFile(path, 'export default ' + JSON.stringify(value));
    const makeRenderer = () =>
      openReactGraphics(
        async () => {
          throw new Error('Unexpected font request');
        },
        () => () => {},
      );
    const renderer = makeRenderer();
    const clean = makeRenderer();
    try {
      await Promise.all([
        write(source, definition),
        writeFile(join(dir, 'Sample.tsx'), component),
        writeFile(join(dir, 'badge.svg'), svgRect('#ffffff')),
        writeFile(join(dir, 'backdrop.svg'), svgRect('#183048')),
      ]);
      const video = await compileVideo(source);
      const plan = await video.resolveRender();
      const layer = plan.visualClips.find(
        ({ clipId }) => clipId === 'first',
      )?.graphic;
      const bundle = layer && video.graphicSource(layer.bundleKey);
      assert(bundle?.renderer === 'react');
      assert.equal(bundle.notices?.['animejs@4.5.0'], 'MIT');
      assert.match(
        bundle.notices?.['animejs@4.5.0/LICENSE.md'] ?? '',
        /Julian Garnier/,
      );
      const sample = (
        worker: typeof renderer,
        frame: number,
        ink = '#f08060',
        signal?: AbortSignal,
      ) =>
        worker.frame(
          bundle,
          {
            timing: {
              width,
              height,
              frame,
              frameRate,
              durationFrames,
              seconds: (frame * frameRate.denominator) / frameRate.numerator,
            },
            props: { ink },
          },
          signal,
        );
      const frames = [0, 1, 4, 5, 9, 10, 11, 14, 15, 19, 20, 23];
      const expected = new Map<number, Buffer>();
      for (const frame of frames)
        expected.set(frame, await sample(renderer, frame));
      assert.notDeepEqual(expected.get(0), expected.get(10));
      for (const frame of [23, 0, 10, 1, 19, 4, 14, 9, 20, 11, 15, 5])
        assert.deepEqual(await sample(renderer, frame), expected.get(frame));
      await setTimeout(250);
      assert.deepEqual(await sample(clean, 19), expected.get(19));
      assert.notDeepEqual(
        await sample(renderer, 9, '#50d7a3'),
        expected.get(9),
      );
      assert.deepEqual(await sample(renderer, 9), expected.get(9));
      const png = expected.get(10)!;
      const rgba = ffmpeg(
        [
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-pix_fmt',
          'rgba',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        png,
      );
      assert.equal(rgba[3], 0);
      assert(rgba.some((alpha, i) => i % 4 === 3 && alpha === 255));
      await assert.rejects(sample(renderer, 24), /outside the composition/);

      const split = editMotionDefinition(
        video,
        { operation: 'split', clip: 'first', at: 5 },
        'split',
      );
      const splitPath = join(dir, 'split.video.ts');
      await write(splitPath, split);
      const edited = await compileVideo(splitPath);
      const moved = editMotionDefinition(
        edited,
        {
          operation: 'change',
          clip: 'split',
          at: 3,
          sourceIn: 7,
          sourceOut: 11,
          props: { ink: '#50d7a3' },
        },
        'moved',
      );
      const track = moved.tracks.find(({ id }) => id === 'graphics-track');
      assert(
        track?.clips.some(
          (clip) =>
            clip.id === 'split' &&
            clip.at === 3 &&
            clip.sourceIn === 7 &&
            clip.sourceOut === 11,
        ),
      );
      for (const frame of [0, 4, 5, 6, 10, 13, 14, 15, 23]) {
        const before = await inspectGraphicFrames(video, frame);
        const after = await inspectGraphicFrames(edited, frame);
        assert.deepEqual(
          after.map(({ samples }) => samples),
          before.map(({ samples }) => samples),
        );
        const preview = async (file: typeof video, suffix: string) => {
          const output = join(dir, suffix + '-' + frame + '.png');
          await previewVideo(file).frame(frame, output, { quality: 'quality' });
          return readFile(output);
        };
        assert.deepEqual(
          await preview(edited, 'split'),
          await preview(video, 'original'),
        );
      }

      const concurrent = await inspectGraphicFrames(video, 5);
      assert.equal(
        concurrent.filter(
          ({ clipId }) => clipId === 'first' || clipId === 'simultaneous',
        ).length,
        2,
      );
      const output = join(dir, 'test.mp4');
      await renderCompiledVideo(edited, output, { quality: 'quality' });
      verifyVideoTimestamps(output, frameRate, durationFrames);
      const frame = 19;
      const expectedRgb = decodeFrames(
        join(dir, 'original-15.png'),
        [0],
        width,
        height,
      ).get(0)!;
      const exported = decodeFrames(output, [15, frame], width, height);
      assert(
        compareRgb(expectedRgb, exported.get(15)!, {
          mean: 4,
          p95: 12,
          largePixelFraction: 0.02,
        }).passed,
      );
      assert.notDeepEqual(exported.get(15), exported.get(frame));

      const portable = join(dir, 'portable');
      await packageVideo(splitPath, portable);
      const reopened = await compileVideo(
        join(portable, 'opencut.bundle.video.ts'),
      );
      const relocatedFrame = join(dir, 'relocated.png');
      await previewVideo(reopened).frame(15, relocatedFrame, {
        quality: 'quality',
      });
      assert.deepEqual(
        await readFile(relocatedFrame),
        await readFile(join(dir, 'original-15.png')),
      );
      assert.match(
        await readFile(join(portable, 'graphics/notices.txt'), 'utf8'),
        /animejs@4\.5\.0\/LICENSE.md/,
      );

      const invalid = structuredClone(definition);
      const motion = invalid.tracks[1]!.clips[0]!;
      Object.assign(motion, { props: { ink: 30 } });
      await write(source, invalid);
      await assert.rejects(
        compileVideo(source),
        /tracks\.1\.clips\.0\.props.*ink/,
      );
      Object.assign(motion, {
        props: {},
        speed: { numerator: 2, denominator: 1 },
      });
      await write(source, invalid);
      await assert.rejects(compileVideo(source), /normal speed only/);

      await write(source, {
        ...definition,
        assets: {
          ...definition.assets,
          motion: {
            ...graphic,
            resources: { ...graphic.resources, bad: 'bad.woff2' },
          },
        },
      });
      await writeFile(join(dir, 'bad.woff2'), 'not a font');
      const invalidFont = await compileVideo(source);
      await assert.rejects(
        previewVideo(invalidFont).frame(0, join(dir, 'bad.png')),
        /source frame 0.*declared font 'bad'/,
      );
      await write(source, definition);
      await writeFile(
        join(dir, 'Sample.tsx'),
        'import forbidden from "left-pad"; export default forbidden;',
      );
      await assert.rejects(
        compileVideo(source),
        /left-pad.*not a supported Anime.js composition dependency/,
      );
      await writeFile(
        join(dir, 'Sample.tsx'),
        'export default function Sample( {',
      );
      await assert.rejects(compileVideo(source), /Sample\.tsx.*end of file/i);

      await writeFile(
        join(dir, 'Sample.tsx'),
        'export default function Sample() { setTimeout(() => {}, 5); return null; }',
      );
      const timed = await compileVideo(source);
      await assert.rejects(
        previewVideo(timed).frame(0, join(dir, 'timer.png')),
        /source frame 0.*Composition timers are unavailable/,
      );

      const controller = new AbortController();
      const stuck = {
        ...bundle,
        key: 'stuck',
        js: 'window.setOpenCutGraphicResources=()=>{};window.renderOpenCutGraphic=()=>{while(true){}};',
      };
      const running = renderer.frame(
        stuck,
        {
          timing: {
            width,
            height,
            frame: 0,
            seconds: 0,
            durationFrames,
            frameRate,
          },
          props: {},
        },
        controller.signal,
      );
      const timer = setTimeout(600).then(() =>
        controller.abort(new Error('Cancelled stuck composition')),
      );
      await assert.rejects(running, /Cancelled stuck composition/);
      await timer;
    } finally {
      await Promise.all([renderer.close(), clean.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('motion trim and split preserve clamped spring samples and whole transitions', async () => {
  const dir = await mkdtemp(join(fixtureDirectory, 'anime-edit-boundaries-'));
  const rate = { numerator: 30, denominator: 1 };
  const time = (frame: number) => frameTime(frame, rate);
  const compile = async (name: string, definition: VideoDefinition) => {
    const path = join(dir, name + '.video.ts');
    await writeFile(path, 'export default ' + JSON.stringify(definition));
    return compileVideo(path);
  };
  const spring = {
    type: 'spring',
    mass: 1,
    stiffness: 100,
    damping: 2,
    duration: 1,
  } as const;
  const original: VideoDefinition = {
    canvas: { width, height, frameRate: rate, durationFrames: 60 },
    assets: { motion: { ...graphic, durationFrames: 48 } },
    tracks: [
      {
        type: 'video',
        clips: [
          {
            id: 'first',
            asset: 'motion',
            at: 0,
            sourceOut: 30,
            keyframes: {
              opacity: [
                { time: time(0), value: 0, easing: spring },
                { time: time(30), value: 1, easing: 'linear' },
              ],
              scale: [
                { time: time(0), value: 1, easing: spring },
                { time: time(30), value: 4, easing: 'linear' },
              ],
            },
          },
          { id: 'second', asset: 'motion', at: 30, sourceIn: 6, sourceOut: 36 },
        ],
      },
    ],
  };
  try {
    await Promise.all([
      writeFile(join(dir, 'Sample.tsx'), component),
      writeFile(join(dir, 'badge.svg'), svgRect('#ffffff')),
    ]);
    const video = await compile('original', original);
    const split = await compile(
      'split',
      editMotionDefinition(
        video,
        { operation: 'split', clip: 'first', at: 9 },
        'right',
      ),
    );
    const trim = async (name: string, sourceIn: number, sourceOut: number) =>
      compile(
        name,
        editMotionDefinition(
          video,
          {
            operation: 'change',
            clip: 'first',
            at: sourceIn,
            sourceIn,
            sourceOut,
            props: {},
          },
          'unused',
        ),
      );
    const trimStart = await trim('trim-start', 9, 30);
    const trimEnd = await trim('trim-end', 0, 9);
    const sample = (
      video: Awaited<ReturnType<typeof compileVideo>>,
      frame: number,
    ) => evaluateTimeline(video.project, time(frame)).visualClips[0]!.visual;
    assert.equal(sample(video, 9).opacity, 1);
    assert.equal(sample(video, 9).scale, 4);
    // The spring falls back into range later. Clamping the cut key alone would change that fall.
    assert(sample(video, 19).opacity! < 0.9);
    for (let frame = 0; frame < 30; frame++) {
      const expected = sample(video, frame);
      for (const edit of [split, frame < 9 ? trimEnd : trimStart]) {
        const actual = sample(edit, frame);
        assert(
          Math.abs(actual.opacity! - expected.opacity!) < 1e-10,
          `opacity at frame ${frame}`,
        );
        assert(
          Math.abs(actual.scale! - expected.scale!) < 1e-10,
          `scale at frame ${frame}`,
        );
      }
    }

    const transitioning = await compile('transitions', {
      ...original,
      transitions: [
        { id: 'entrance', kind: 'fade-in', clipId: 'first', frames: 8 },
        {
          id: 'dissolve',
          kind: 'cross-dissolve',
          from: 'first',
          to: 'second',
          frames: 8,
        },
        { id: 'exit', kind: 'fade-out', clipId: 'second', frames: 8 },
      ],
    });
    assert.deepEqual(
      describeMotionGraphics(transitioning).clips.map(
        ({ splitLimits }) => splitLimits,
      ),
      [
        { earliest: 8, latest: 26 },
        { earliest: 34, latest: 52 },
      ],
    );
    for (const [clip, at] of [
      ['first', 3],
      ['first', 27],
      ['second', 32],
      ['second', 53],
    ] as const)
      assert.throws(
        () =>
          editMotionDefinition(
            transitioning,
            { operation: 'split', clip, at },
            'right',
          ),
        /edge of the clip’s transition/,
      );
    for (const [clip, at] of [
      ['first', 8],
      ['first', 26],
      ['second', 34],
      ['second', 52],
    ] as const) {
      const edited = await compile(
        'edge-' + at,
        editMotionDefinition(
          transitioning,
          { operation: 'split', clip, at },
          'right',
        ),
      );
      for (const frame of [0, 7, 8, 25, 26, 29, 30, 33, 34, 51, 52, 59]) {
        const samples = async (video: typeof edited) =>
          (await inspectGraphicFrames(video, frame)).map(
            ({ samples }) => samples,
          );
        assert.deepEqual(await samples(edited), await samples(transitioning));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
