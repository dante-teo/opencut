import type { CSSProperties, ReactNode } from 'react';
import { graphicProgress, useGraphicTiming } from './react.js';

import { parseTemplateProps } from './template-props.js';
import type { TemplateProps } from './template-props.js';

type Colors = Pick<
  TemplateProps<'LowerThird'>,
  'accent' | 'ink' | 'paper' | 'theme'
>;
const themes = {
  dark: { accent: '#77f6c7', ink: '#f6faf8', paper: '#10302c' },
  light: { accent: '#006f56', ink: '#12352c', paper: '#edf9f4' },
};

function useLayout(colors: Colors) {
  const { frame, durationFrames, width, height } = useGraphicTiming();
  const scale = Math.min(width, height);
  const base = themes[colors.theme ?? 'dark'];
  const beats = Math.max(1, Math.min(18, Math.floor(durationFrames / 4)));
  const show =
    (durationFrames < 3 ? 1 : graphicProgress(frame, 0, beats)) *
    (durationFrames < 3
      ? 1
      : 1 - graphicProgress(frame, durationFrames - beats, durationFrames - 1));
  return {
    scale,
    width,
    height,
    show,
    step: (factor: number) => Math.round(scale * factor),
    reveal: graphicProgress(
      frame,
      0,
      Math.min(36, Math.max(1, durationFrames - beats - 1)),
    ),
    accent: colors.accent ?? base.accent,
    ink: colors.ink ?? base.ink,
    paper: colors.paper ?? base.paper,
  };
}

type Layout = ReturnType<typeof useLayout>;
const longText: CSSProperties = { overflowWrap: 'anywhere', lineHeight: 1.14 };

function Surface({
  layout,
  children,
  at = 'bottom',
  style,
}: {
  layout: Layout;
  children: ReactNode;
  at?: 'bottom' | 'center';
  style?: CSSProperties;
}) {
  const { step, accent, ink, paper, show } = layout;
  return (
    <div
      style={{
        position: 'absolute',
        left: step(0.065),
        right: step(0.065),
        ...(at === 'bottom'
          ? { bottom: step(0.075) }
          : { top: '50%', translate: '0 -50%' }),
        maxWidth: step(0.98),
        maxHeight: layout.height - step(0.13),
        overflow: 'hidden',
        boxSizing: 'border-box',
        padding: step(0.048),
        color: ink,
        background: paper,
        border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
        borderRadius: step(0.027),
        boxShadow: `0 ${step(0.018)}px ${step(0.045)}px #071b2090`,
        opacity: show,
        transform: `translateY(${step((1 - show) * 0.03)}px)`,
        fontFamily: '"OpenCut CJK", system-ui, sans-serif',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Accent({ layout }: { layout: Layout }) {
  return (
    <div
      aria-hidden
      style={{
        width: layout.step(0.087),
        height: layout.step(0.01),
        background: layout.accent,
        borderRadius: 100,
        marginBottom: layout.step(0.025),
      }}
    />
  );
}

export function LowerThird(props: TemplateProps<'LowerThird'>) {
  const {
    name = '林晓 · Xiao Lin',
    role = '设计研究 / Design research',
    portrait,
    ...colors
  } = parseTemplateProps('LowerThird', props);
  const layout = useLayout(colors);
  const { step, accent } = layout;
  return (
    <Surface
      layout={layout}
      style={{ display: 'flex', alignItems: 'center', gap: step(0.03) }}
    >
      <div
        aria-hidden
        style={{
          width: step(0.013),
          alignSelf: 'stretch',
          flexShrink: 0,
          background: accent,
          borderRadius: 10,
        }}
      />
      {portrait && (
        <img
          alt=""
          src={portrait}
          style={{
            width: step(0.11),
            height: step(0.11),
            flexShrink: 0,
            objectFit: 'cover',
            borderRadius: '50%',
          }}
        />
      )}
      <div style={{ minWidth: 0, ...longText }}>
        <div style={{ fontSize: step(0.057), fontWeight: 740 }}>{name}</div>
        {role && (
          <div
            style={{
              marginTop: step(0.009),
              fontSize: step(0.032),
              color: accent,
            }}
          >
            {role}
          </div>
        )}
      </div>
    </Surface>
  );
}

export function StatisticCard(props: TemplateProps<'StatisticCard'>) {
  const {
    label = '完成项目 / Projects completed',
    value = 128,
    unit = '',
    detail = '',
    ...colors
  } = parseTemplateProps('StatisticCard', props);
  const layout = useLayout(colors);
  const { reveal, step, accent } = layout;
  const display = Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(value * reveal);
  return (
    <Surface layout={layout} at="center">
      <Accent layout={layout} />
      <div style={{ fontSize: step(0.038), ...longText }}>{label}</div>
      <div
        style={{
          fontSize: step(0.136),
          fontWeight: 760,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
          ...longText,
        }}
      >
        {display}
        {unit && (
          <span style={{ fontSize: '.43em', marginInlineStart: '.14em' }}>
            {unit}
          </span>
        )}
      </div>
      {detail && (
        <div style={{ fontSize: step(0.029), ...longText }}>{detail}</div>
      )}
    </Surface>
  );
}

const comparison = [
  { label: '设计 Design', value: 68 },
  { label: '测试 Testing', value: 87 },
  { label: '上线 Launch', value: 52 },
];
export function BarChart(props: TemplateProps<'BarChart'>) {
  const {
    title = '项目进度 / Project progress',
    data: rows = comparison,
    empty = '暂无数据 / No data',
    ...colors
  } = parseTemplateProps('BarChart', props);
  const layout = useLayout(colors);
  const { step, accent, reveal } = layout;
  const negative = Math.min(0, ...rows.map(({ value }) => value));
  const positive = Math.max(0, ...rows.map(({ value }) => value));
  const extent = positive - negative || 1;
  const zero = (-negative / extent) * 100;
  return (
    <Surface layout={layout} at="center">
      <Accent layout={layout} />
      <div
        style={{
          marginBottom: step(0.025),
          fontSize: step(0.043),
          fontWeight: 690,
          ...longText,
        }}
      >
        {title}
      </div>
      {rows.length === 0 && (
        <div style={{ fontSize: step(0.032), ...longText }}>{empty}</div>
      )}
      {rows.map(({ label, value }, index) => {
        const filled = (Math.abs(value) / extent) * 100 * reveal;
        return (
          <div key={index} style={{ marginTop: step(0.018), minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: step(0.012),
                marginBottom: step(0.008),
                fontSize: step(0.027),
              }}
            >
              <span
                style={{
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {value}
              </span>
            </div>
            <svg
              width="100%"
              height={step(0.018)}
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              aria-hidden
            >
              <rect width="100" height="10" rx="2" fill="#ffffff24" />
              <rect
                x={value < 0 ? zero - filled : zero}
                width={filled}
                height="10"
                rx="2"
                fill={accent}
              />
            </svg>
          </div>
        );
      })}
    </Surface>
  );
}

export function Callout(props: TemplateProps<'Callout'>) {
  const {
    label = '关键细节 / Key detail',
    x = 0.7,
    y = 0.45,
    anchorX,
    anchorY,
    ...colors
  } = parseTemplateProps('Callout', props);
  const layout = useLayout(colors);
  const { accent, width, height, step, show } = layout;
  const tx = width * Math.min(0.96, Math.max(0.04, x));
  const ty = height * Math.min(0.96, Math.max(0.04, y));
  const px = anchorX === undefined ? step(0.18) : width * anchorX;
  const py = height * (anchorY ?? 0.22);
  const radius = step(0.017);
  return (
    <>
      <svg
        width={width}
        height={height}
        style={{ position: 'absolute', inset: 0, opacity: show }}
        aria-hidden
      >
        <path
          d={`M${px},${py} L${px},${ty} L${tx},${ty}`}
          fill="none"
          stroke={accent}
          strokeWidth={step(0.007)}
          strokeLinejoin="round"
        />
        <path
          d={`M${tx},${ty} l${tx > px ? -radius * 1.6 : radius * 1.6},-${radius} v${radius * 2}Z`}
          fill={accent}
        />
      </svg>
      <Surface
        layout={layout}
        style={{
          top: step(0.065),
          bottom: 'auto',
          right: 'auto',
          maxWidth: '79%',
          fontSize: step(0.036),
          fontWeight: 680,
          ...longText,
        }}
      >
        {label}
      </Surface>
    </>
  );
}

export function SectionCard(props: TemplateProps<'SectionCard'>) {
  const {
    heading = '下一步 / What’s next',
    body = '从一个简单的想法开始。\nStart with a small idea.',
    icon,
    ...colors
  } = parseTemplateProps('SectionCard', props);
  const layout = useLayout(colors);
  const { paper, ink, accent, show, step } = layout;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        alignItems: 'center',
        boxSizing: 'border-box',
        padding: step(0.1),
        color: ink,
        opacity: show,
        background: `radial-gradient(ellipse at 78% 12%, color-mix(in srgb, ${accent} 30%, ${paper}), ${paper} 75%)`,
        fontFamily: '"OpenCut CJK", system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: '100%', overflow: 'hidden' }}>
        {icon && (
          <img
            src={icon}
            alt=""
            style={{
              display: 'block',
              width: step(0.09),
              height: step(0.09),
              objectFit: 'contain',
              marginBottom: step(0.03),
            }}
          />
        )}
        <Accent layout={layout} />
        <div style={{ fontSize: step(0.104), fontWeight: 760, ...longText }}>
          {heading}
        </div>
        {body && (
          <div
            style={{
              marginTop: step(0.035),
              fontSize: step(0.045),
              ...longText,
              whiteSpace: 'pre-line',
            }}
          >
            {body}
          </div>
        )}
      </div>
    </div>
  );
}
