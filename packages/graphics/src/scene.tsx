import { Fragment, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import {
  graphicNodeTime,
  interpolate,
  interpolateColor,
  sampleMotion,
  staggerTime,
} from '@opencut/shared';
import type {
  AnimatedNumber,
  GraphicAudioSample,
  GraphicScene,
  GraphicSceneNode,
  SceneColor,
  SceneMask,
  ScenePaint,
} from '@opencut/shared';
import { svgPathProperties } from 'svg-path-properties';
import {
  useGraphicAudio,
  useGraphicReadiness,
  useGraphicTiming,
} from './react.js';

type NumberAtTime = (
  value: AnimatedNumber,
  min?: number,
  max?: number,
) => number;

function sample(time: number): NumberAtTime {
  return (value, min = -32768, max = 32768) =>
    Math.max(
      min,
      Math.min(
        max,
        typeof value === 'number' ? value : sampleMotion(value, time),
      ),
    );
}

function color(value: SceneColor, at: NumberAtTime) {
  return typeof value === 'string'
    ? value
    : interpolateColor(
        value.from === 'transparent' ? '#00000000' : value.from,
        value.to === 'transparent' ? '#00000000' : value.to,
        at(value.progress, 0, 1),
      );
}

function paint(value: ScenePaint, at: NumberAtTime) {
  if (typeof value !== 'object' || !('stops' in value)) return color(value, at);
  const stops = value.stops
    .map(({ color: value, offset }) => `${color(value, at)} ${offset * 100}%`)
    .join(', ');
  return `linear-gradient(${at(value.angle)}deg, ${stops})`;
}

function maskStyle(
  mask: SceneMask,
  at: NumberAtTime,
  width: number,
  height: number,
): CSSProperties {
  switch (mask.type) {
    case 'rect': {
      const x = at(mask.x);
      const y = at(mask.y);
      return {
        clipPath: `inset(${y}px ${width - x - at(mask.width, 0, 8192)}px ${height - y - at(mask.height, 0, 8192)}px ${x}px round ${at(mask.radius ?? 0, 0, 8192)}px)`,
      };
    }
    case 'ellipse':
      return {
        clipPath: `ellipse(${at(mask.radiusX, 0, 8192)}px ${at(mask.radiusY, 0, 8192)}px at ${at(mask.x)}px ${at(mask.y)}px)`,
      };
    case 'path':
      return { clipPath: `path('${mask.d}')` };
    case 'gradient': {
      const start = at(mask.start, 0, 1) * 100;
      const end = Math.max(start, at(mask.end, 0, 1) * 100);
      return {
        maskImage: `linear-gradient(${at(mask.angle)}deg, black ${start}%, transparent ${end}%)`,
      };
    }
  }
}

const paths = new Map<string, InstanceType<typeof svgPathProperties>>();
function pathPoint(d: string, progress: number) {
  let path = paths.get(d);
  if (!path) {
    if (paths.size >= 64) paths.clear();
    path = new svgPathProperties(d);
    paths.set(d, path);
  }
  return path.getPropertiesAtLength(progress * path.getTotalLength());
}

const full: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
};
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const words = new Intl.Segmenter('und', { granularity: 'word' });
type TextNode = Extract<GraphicSceneNode, { type: 'text' }>;

function textContent(
  node: TextNode,
  value: string,
  time: number,
  at: NumberAtTime,
) {
  if (node.runs) {
    return node.runs.map((run, i) => (
      <span
        key={i}
        style={{
          color: run.color && color(run.color, at),
          fontFamily: run.font
            ? `"OpenCut Resource ${run.font}", "OpenCut CJK", sans-serif`
            : undefined,
          fontWeight: run.weight,
        }}
      >
        {run.text}
      </span>
    ));
  }
  if (node.highlight) {
    const active = node.highlight.find(
      ({ start, end }) => time >= start && time < end,
    );
    if (!active) return value;
    return (
      <>
        {value.slice(0, active.from)}
        <span
          style={{
            color: active.color && color(active.color, at),
            backgroundColor: color(active.background, at),
            borderRadius: 4,
            boxShadow: `0 0 0 .09em ${color(active.background, at)}`,
          }}
        >
          {value.slice(active.from, active.to)}
        </span>
        {value.slice(active.to)}
      </>
    );
  }
  const kinetic = node.kinetic;
  if (!kinetic) return value;
  let count = 0;
  const animated = (part: string, i: number) => {
    if (/^\s+$/u.test(part)) return part;
    const phase = interpolate(
      staggerTime(time, count++, kinetic.stagger),
      [0, kinetic.duration],
      [0, 1],
      { easing: 'ease-out' },
    );
    return (
      <span
        key={i}
        style={{
          display: 'inline-block',
          opacity: phase,
          transform: `translateY(${(1 - phase) * (kinetic.offsetY ?? 20)}px)`,
        }}
      >
        {part}
      </span>
    );
  };
  if (kinetic.unit === 'line')
    return value.split('\n').map((line, i) => (
      <Fragment key={i}>
        {i > 0 && <br />}
        {animated(line, i)}
      </Fragment>
    ));
  return [...(kinetic.unit === 'word' ? words : graphemes).segment(value)].map(
    ({ segment }, i) => animated(segment, i),
  );
}

function SceneText({
  node,
  at,
  time,
}: {
  node: TextNode;
  at: NumberAtTime;
  time: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const register = useGraphicReadiness();
  const size = at(node.size, 1, 512);
  const width = at(node.width, 0, 8192);
  const height = at(node.height, 0, 8192);
  const content = node.counter
    ? at(node.counter.value, -1e9, 1e9).toFixed(node.counter.digits ?? 0) +
      (node.counter.suffix ?? '')
    : (node.content ?? '');
  useLayoutEffect(() => {
    const box = host.current!;
    if (!node.overflow || node.overflow === 'clip') return;
    register(
      (async () => {
        await document.fonts.ready;
        const fits = () =>
          box.scrollWidth <= box.clientWidth + 1 &&
          box.scrollHeight <= box.clientHeight + 1;
        if (fits()) return;
        if (node.overflow === 'fit') {
          let lo = Math.min(node.minSize ?? 12, size);
          let hi = size;
          box.style.fontSize = lo + 'px';
          if (fits()) {
            for (let i = 0; i < 8; i++) {
              const mid = (lo + hi) / 2;
              box.style.fontSize = mid + 'px';
              if (fits()) lo = mid;
              else hi = mid;
            }
            box.style.fontSize = lo + 'px';
            return;
          }
        }
        throw new Error(
          `Scene text '${node.id}' exceeds its ${width}×${height} px box at source frame ${time.toFixed(4)}.`,
        );
      })(),
    );
  }, [register, node, time, size, width, height]);

  return (
    <div
      ref={host}
      style={{
        width,
        height,
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: node.font
          ? `"OpenCut Resource ${node.font}", "OpenCut CJK", sans-serif`
          : undefined,
        fontSize: size,
        lineHeight: node.lineHeight ?? 1.16,
        fontWeight: node.weight ?? 700,
        color: color(node.color, at),
        textAlign: node.align ?? 'left',
        ...(node.stroke && {
          WebkitTextStroke: `${at(node.stroke.width, 0, 16)}px ${color(node.stroke.color, at)}`,
          paintOrder: 'stroke fill',
        }),
      }}
    >
      {textContent(node, content, time, at)}
    </div>
  );
}

interface SceneSurface {
  width: number;
  height: number;
  resources: Readonly<Record<string, string>>;
  audio: GraphicAudioSample | undefined;
}

function drawNode(
  node: GraphicSceneNode,
  parentTime: number,
  surface: SceneSurface,
) {
  const time = graphicNodeTime(parentTime, node.timing);
  if (time === undefined) return null;
  const at = sample(time);
  const { width, height, resources } = surface;
  let x = at(node.x ?? 0);
  let y = at(node.y ?? 0);
  let rotation = at(node.rotation ?? 0, -36000, 36000);
  if (node.follow) {
    const path = pathPoint(node.follow.d, at(node.follow.progress, 0, 1));
    x += path.x;
    y += path.y;
    if (node.follow.orient)
      rotation += (Math.atan2(path.tangentY, path.tangentX) * 180) / Math.PI;
  }
  const { effects } = node;
  const filters = [];
  if (effects?.blur !== undefined)
    filters.push(`blur(${at(effects.blur, 0, 128)}px)`);
  if (effects?.brightness !== undefined)
    filters.push(`brightness(${at(effects.brightness, 0, 4)})`);
  if (effects?.saturation !== undefined)
    filters.push(`saturate(${at(effects.saturation, 0, 4)})`);
  if (effects?.shadow) {
    const { x, y, blur, color: shade } = effects.shadow;
    filters.push(
      `drop-shadow(${at(x)}px ${at(y)}px ${at(blur, 0, 128)}px ${color(shade, at)})`,
    );
  }
  const { origin = [0, 0] } = node;
  const transform = ['translate(' + x + 'px,' + y + 'px)'];
  if (node.perspective !== undefined)
    transform.push(`perspective(${node.perspective}px)`);
  if (rotation) transform.push(`rotate(${rotation}deg)`);
  if (node.rotateX !== undefined)
    transform.push(`rotateX(${at(node.rotateX)}deg)`);
  if (node.rotateY !== undefined)
    transform.push(`rotateY(${at(node.rotateY)}deg)`);
  if (node.scaleX !== undefined || node.scaleY !== undefined)
    transform.push(
      `scale(${at(node.scaleX ?? 1, 0.001, 8)}, ${at(node.scaleY ?? 1, 0.001, 8)})`,
    );

  let body;
  switch (node.type) {
    case 'group':
      body = (
        <div style={{ ...full, isolation: 'isolate' }}>
          {node.children.map((child) => drawNode(child, time, surface))}
        </div>
      );
      break;
    case 'rect':
    case 'ellipse':
      body = (
        <div
          style={{
            width: at(node.width, 0, 8192),
            height: at(node.height, 0, 8192),
            background: paint(node.fill, at),
            borderRadius:
              node.type === 'ellipse' ? '50%' : at(node.radius ?? 0, 0, 8192),
          }}
        />
      );
      break;
    case 'path':
      body = (
        <svg width={width} height={height} style={{ overflow: 'visible' }}>
          <path
            d={node.d}
            fill={node.fill ? color(node.fill, at) : 'none'}
            stroke={node.stroke && color(node.stroke, at)}
            strokeWidth={at(node.strokeWidth ?? 1, 0, 128)}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...(node.draw !== undefined && {
              pathLength: 1,
              strokeDasharray: '1 1',
              strokeDashoffset: 1 - at(node.draw, 0, 1),
            })}
          />
        </svg>
      );
      break;
    case 'audio': {
      const analysis = surface.audio;
      if (!analysis)
        throw new Error(
          `Audio node '${node.id}' is missing its declared analysis.`,
        );
      const w = at(node.width, 0, 8192);
      const h = at(node.height, 0, 8192);
      const tint = color(node.color, at);
      const gain = node.gain ?? 1;
      const visible = (value: number) =>
        Math.max(-1, Math.min(1, value * gain));
      if (node.mode === 'beat') {
        const size = analysis.beat ? 1 : 0.43;
        body = (
          <div
            style={{
              width: w * size,
              height: h * size,
              marginLeft: (w * (1 - size)) / 2,
              marginTop: (h * (1 - size)) / 2,
              borderRadius: '50%',
              background: tint,
            }}
          />
        );
      } else if (node.mode === 'rms') {
        body = (
          <div
            style={{
              width: w * Math.max(0, visible(analysis.rms)),
              height: h,
              background: tint,
            }}
          />
        );
      } else if (node.mode === 'waveform') {
        const points = analysis.waveform
          .map(
            (value, i) =>
              `${(w * i) / Math.max(analysis.waveform.length - 1, 1)},${h * (0.5 - 0.5 * visible(value))}`,
          )
          .join(' ');
        body = (
          <svg width={w} height={h} style={{ overflow: 'visible' }}>
            <polyline
              points={points}
              fill="none"
              stroke={tint}
              strokeWidth="3"
            />
          </svg>
        );
      } else {
        const step = w / analysis.spectrum.length;
        body = (
          <svg width={w} height={h}>
            {analysis.spectrum.map((value, i) => {
              const bar = Math.min(h, 3 + h * visible(value));
              return (
                <rect
                  key={i}
                  x={i * step}
                  y={h - bar}
                  width={step * 0.76}
                  height={bar}
                  rx="3"
                  fill={tint}
                />
              );
            })}
          </svg>
        );
      }
      break;
    }
    case 'media-frame':
    case 'image':
      body = (
        <img
          src={resources[node.resource]}
          alt=""
          style={{
            width: at(node.width, 0, 8192),
            height: at(node.height, 0, 8192),
            objectFit: node.fit ?? 'contain',
            display: 'block',
          }}
        />
      );
      break;
    case 'text':
      body = <SceneText key={node.id} node={node} time={time} at={at} />;
      break;
  }
  return (
    <div
      key={node.id}
      data-scene-id={node.id}
      style={{
        ...full,
        transform: transform.join(' '),
        transformOrigin: `${origin[0]}px ${origin[1]}px`,
        opacity: at(node.opacity ?? 1, 0, 1),
        mixBlendMode: node.blend,
        filter: filters.join(' ') || undefined,
      }}
    >
      {node.mask ? (
        <div style={{ ...full, ...maskStyle(node.mask, at, width, height) }}>
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
}

export function SceneGraphic({
  scene,
  resources,
}: {
  scene: GraphicScene;
  resources: Readonly<Record<string, string>>;
}) {
  const audio = useGraphicAudio();
  const { width, height, frame, frameRate, exactSourceTime } =
    useGraphicTiming();
  const time = exactSourceTime
    ? (exactSourceTime.numerator * frameRate.numerator) /
      (exactSourceTime.denominator * frameRate.denominator)
    : frame;
  return (
    <div style={{ ...full, isolation: 'isolate' }}>
      {scene.children.map((node) =>
        drawNode(node, time, { width, height, resources, audio }),
      )}
    </div>
  );
}
