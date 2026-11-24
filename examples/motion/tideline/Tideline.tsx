import { useRef } from 'react';
import { createSpring, stagger, svg } from 'animejs';
import { useGraphicTimeline } from '@opencut/graphics/anime';
import { useGraphicRandom, useGraphicSvgId } from '@opencut/graphics/react';

const ink = '#f2e8cb';
const seafoam = '#b7e2ca';
const grid = '#78a59c';
const wave =
  'M1080 590 C1190 590 1228 384 1370 384 C1513 384 1522 658 1650 658 C1723 658 1771 592 1824 532';
const contour =
  'M1248 545 C1281 435 1391 401 1493 449 C1596 497 1672 449 1690 554 C1669 647 1599 711 1490 664 C1385 618 1279 649 1248 545 Z';
const returnContour =
  'M1248 545 C1281 435 1391 411 1493 411 C1596 411 1672 449 1690 545 C1669 647 1599 690 1490 690 C1385 690 1279 649 1248 545 Z';
const diagramCenter = '1470px 540px';

const chapters = [
  { title: '', note: 'Measure the rise and fall.', code: '01 / OBSERVE' },
  {
    title: 'Map the swell',
    note: 'Turn a moving signal into a shape.',
    code: '02 / TRACE',
  },
  {
    title: 'Find the rhythm',
    note: 'Every tide carries a pattern.',
    code: '03 / RETURN',
  },
];

export default function Tideline({
  headline,
  accent,
}: {
  headline: string;
  accent: string;
}) {
  const root = useRef<SVGSVGElement>(null);
  const typeMask = useGraphicSvgId();
  const seaGradient = useGraphicSvgId();
  const random = useGraphicRandom();

  useGraphicTimeline(root, (timeline, surface) => {
    const trace = surface.querySelector<SVGPathElement>('.trace')!;
    const target = surface.querySelector<SVGPathElement>('.target')!;
    const spring = createSpring({ stiffness: 120, damping: 18 });
    timeline
      .add(
        '.word-0',
        {
          translateY: [155, 0],
          opacity: [0, 1],
          duration: 860,
          delay: stagger(115),
          ease: spring,
        },
        100,
      )
      .add(
        '.meta-0',
        {
          translateY: [18, 0],
          opacity: [0, 1],
          duration: 620,
          delay: stagger(125),
          ease: 'out(3)',
        },
        630,
      )
      .add(
        svg.createDrawable(trace),
        { draw: ['0 0', '0 1'], duration: 2800, ease: 'inOut(2)' },
        480,
      )
      .add(
        '.buoy',
        {
          ...svg.createMotionPath(trace),
          opacity: [0, 1, 1, 0],
          duration: 2800,
          ease: 'inOut(2)',
        },
        480,
      )
      .add(
        '.tick',
        {
          scaleY: [0, 1],
          opacity: [0, 0.9],
          duration: 420,
          delay: stagger(64),
          ease: 'out(3)',
        },
        480,
      )
      .add(
        '.chapter-0',
        { opacity: [1, 0], translateY: [0, -64], duration: 530, ease: 'in(2)' },
        3600,
      )
      .add(
        '.plot',
        { opacity: [1, 0], scale: [1, 0.83], duration: 650, ease: 'inOut(2)' },
        3620,
      )
      .add(
        '.sweep',
        {
          translateX: [-1960, 1960],
          opacity: [0, 0.65, 0.65, 0],
          duration: 880,
          ease: 'inOut(3)',
        },
        3660,
      )
      .add(
        '.word-1',
        {
          translateY: [160, 0],
          opacity: [0, 1],
          duration: 850,
          delay: stagger(112),
          ease: 'out(4)',
        },
        4080,
      )
      .add(
        '.meta-1',
        {
          opacity: [0, 1],
          translateY: [22, 0],
          duration: 510,
          delay: stagger(90),
          ease: 'out(3)',
        },
        4730,
      )
      .add(
        '.isobar',
        {
          opacity: [0, 1],
          scale: [0.65, 1],
          duration: 700,
          delay: stagger(105),
          ease: 'out(3)',
        },
        4050,
      )
      .add(
        '.contour',
        {
          d: svg.morphTo(target, 0),
          fill: [accent, seafoam],
          duration: 2300,
          ease: 'inOut(3)',
        },
        5290,
      )
      .add(
        '.chapter-1',
        { opacity: [1, 0], translateY: [0, -64], duration: 500, ease: 'in(2)' },
        7960,
      )
      .add(
        '.contours',
        {
          opacity: [1, 0],
          rotate: [0, 18],
          scale: [1, 1.16],
          duration: 670,
          ease: 'inOut(2)',
        },
        7980,
      )
      .add(
        '.sweep-return',
        {
          translateX: [1960, -1960],
          opacity: [0, 0.58, 0.58, 0],
          duration: 990,
          ease: 'inOut(3)',
        },
        7970,
      )
      .add(
        '.word-2',
        {
          translateY: [160, 0],
          opacity: [0, 1],
          duration: 970,
          delay: stagger(110),
          ease: spring,
        },
        8450,
      )
      .add(
        '.meta-2',
        {
          opacity: [0, 1],
          translateY: [22, 0],
          duration: 550,
          delay: stagger(90),
          ease: 'out(3)',
        },
        9120,
      )
      .add(
        '.ripple',
        {
          opacity: [0, 0.75],
          scale: [0.35, 1],
          duration: 1000,
          delay: stagger(110),
          ease: 'out(3)',
        },
        8560,
      )
      .add(
        '.needle',
        { rotate: [-126, 22], opacity: [0, 1], duration: 1700, ease: spring },
        9050,
      )
      .add(
        '.terminal',
        { scale: [0, 1], opacity: [0, 1], duration: 550, ease: 'out(3)' },
        10660,
      );
  });

  return (
    <svg
      ref={root}
      viewBox="0 0 1920 1080"
      width="1920"
      height="1080"
      fontFamily="system-ui, sans-serif"
    >
      <defs>
        <clipPath id={typeMask}>
          <rect x="110" y="293" width="790" height="374" />
        </clipPath>
        <linearGradient id={seaGradient}>
          <stop stopColor={accent} stopOpacity="0" />
          <stop offset="1" stopColor={accent} />
        </linearGradient>
      </defs>
      <rect
        className="sweep"
        x="90"
        y="175"
        width="760"
        height="714"
        fill={`url(#${seaGradient})`}
        style={{ opacity: 0 }}
      />
      <rect
        className="sweep-return"
        x="90"
        y="175"
        width="760"
        height="714"
        fill={`url(#${seaGradient})`}
        style={{ opacity: 0 }}
      />
      <g fill={seafoam} fontSize="23" letterSpacing="6" fontWeight="650">
        <text x="116" y="121">
          TIDELINE
        </text>
        <text x="1802" y="121" textAnchor="end">
          COASTAL STUDIES
        </text>
        <text x="116" y="934" fontSize="15" letterSpacing="3">
          DEPTH / AMPLITUDE / PERIOD
        </text>
        <text x="1802" y="934" textAnchor="end" fontSize="15" letterSpacing="3">
          01—03
        </text>
      </g>
      {chapters.map(({ title, note, code }, index) => {
        const words = (index === 0 ? headline : title).trim().split(/\s+/);
        const lines = [words.slice(0, -1).join(' '), words.at(-1)].filter(
          Boolean,
        );
        return (
          <g className={`chapter-${index}`} key={code}>
            <g
              clipPath={`url(#${typeMask})`}
              fontSize="119"
              fontWeight="730"
              letterSpacing="-7"
            >
              {lines.map((line, i) => (
                <text
                  key={i}
                  className={`word-${index}`}
                  x="112"
                  y={456 + i * 132}
                  fill={i ? accent : ink}
                  style={{ opacity: 0 }}
                >
                  {line}
                </text>
              ))}
            </g>
            <text
              className={`meta-${index}`}
              x="120"
              y="250"
              fill={seafoam}
              fontSize="23"
              letterSpacing="5"
              style={{ opacity: 0 }}
            >
              {code}
            </text>
            <text
              className={`meta-${index}`}
              x="120"
              y="728"
              fill={ink}
              fontSize="35"
              style={{ opacity: 0 }}
            >
              {note}
            </text>
          </g>
        );
      })}
      <g className="plot" style={{ transformOrigin: diagramCenter }}>
        {Array.from({ length: 12 }, (_, i) => {
          const height = 22 + random(`gauge-${i}`) * 62;
          return (
            <path
              key={i}
              className="tick"
              d={`M${1098 + i * 63} 806v-${height}`}
              stroke={grid}
              strokeWidth="2"
              style={{ opacity: 0, transformOrigin: '0 806px' }}
            />
          );
        })}
        <path
          className="trace"
          d={wave}
          stroke={seafoam}
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        <circle className="buoy" r="11" fill={accent} style={{ opacity: 0 }} />
      </g>
      <g className="contours" style={{ transformOrigin: diagramCenter }}>
        <path className="target" d={returnContour} visibility="hidden" />
        {[1.47, 1.32, 1.17].map((scale) => (
          <g
            key={scale}
            style={{
              transform: `scale(${scale})`,
              transformOrigin: diagramCenter,
            }}
          >
            <path
              className="isobar"
              d={contour}
              fill="none"
              stroke={grid}
              strokeWidth="2"
              style={{ opacity: 0, transformOrigin: diagramCenter }}
            />
          </g>
        ))}
        <path
          className="isobar contour"
          d={contour}
          fill={accent}
          style={{ opacity: 0, transformOrigin: diagramCenter }}
        />
      </g>
      <g fill="none" strokeWidth="2">
        {[80, 136, 193, 254, 312].map((radius, index) => (
          <circle
            key={radius}
            className="ripple"
            cx="1470"
            cy="540"
            r={radius}
            stroke={index === 2 ? seafoam : grid}
            style={{ opacity: 0, transformOrigin: diagramCenter }}
          />
        ))}
        <g
          className="needle"
          style={{ opacity: 0, transformOrigin: diagramCenter }}
        >
          <path d="M1470 540L1680 415" stroke={accent} strokeWidth="4" />
          <circle cx="1680" cy="415" r="11" fill={accent} stroke="none" />
        </g>
        <circle
          className="terminal"
          cx="1470"
          cy="540"
          r="13"
          fill={ink}
          style={{ opacity: 0, transformOrigin: diagramCenter }}
        />
      </g>
    </svg>
  );
}
