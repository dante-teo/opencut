import type { VisualGroup } from '@opencut/shared';

export interface GroupSurfaces {
  style: VisualGroup;
  backdrop: string;
  content: string;
  matte?: string | undefined;
  id: number;
}

export function transparentGroupSurface(
  label: string,
  width: number,
  height: number,
  { start, end, numerator, denominator }: GroupClock,
) {
  return `color=c=black@0:s=${width}x${height}:r=${numerator}/${denominator},format=rgba,trim=end_frame=${end - start},settb=1/${numerator},setpts=(N+${start})*${denominator}[${label}]`;
}

interface GroupClock {
  start: number;
  end: number;
  numerator: number;
  denominator: number;
}

/** Flatten one isolated subtree and merge it into the current program backdrop. */
export function compositeGroup(
  filters: string[],
  { style, backdrop, content, matte, id }: GroupSurfaces,
  width: number,
  height: number,
  clock: GroupClock,
) {
  const name = (kind: string) => `group${id}${kind}`;
  let foreground = content;
  let background = backdrop;
  const alpha = name('alpha');
  const overlay = (under: string, over: string, output: string, x = 0, y = 0) =>
    filters.push(
      `[${under}][${over}]overlay=x=${x}:y=${y}:format=rgb:alpha=straight:eof_action=pass:repeatlast=0[${output}]`,
    );
  if (matte) {
    filters.push(
      `[${content}]split[${name('rgb')}][${name('rgba')}]`,
      `[${name('rgba')}]alphaextract[${alpha}]`,
      `[${matte}]alphaextract[${name('mask')}]`,
      `[${alpha}][${name('mask')}]blend=all_mode=multiply:shortest=1[${name('masked')}]`,
      `[${name('rgb')}][${name('masked')}]alphamerge[${name('matted')}]`,
    );
    foreground = name('matted');
  }
  const transforms = ['format=rgba'];
  if (style.clip) {
    const { x, y, width: w, height: h } = style.clip;
    transforms.push(
      `crop=${w}:${h}:${x}:${y}:exact=1`,
      `pad=${width}:${height}:${x}:${y}:color=black@0`,
    );
  }
  const scale = style.scale ?? 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (style.blur) {
    transforms.push(
      'format=gbrap',
      'premultiply=inplace=1',
      `gblur=sigma=${style.blur}:steps=2`,
      'unpremultiply=inplace=1',
      'format=rgba',
    );
  }
  if (scale !== 1) transforms.push(`scale=${w}:${h}:flags=bicubic`, 'setsar=1');
  if (style.rotation)
    transforms.push(`rotate=${style.rotation}*PI/180:fillcolor=black@0`);
  if (style.opacity !== undefined && style.opacity !== 1)
    transforms.push(`lut=a=val*${style.opacity}`);
  filters.push(`[${foreground}]${transforms.join(',')}[${name('styled')}]`);

  const x = (style.x ?? 0) + Math.round((width - w) / 2);
  const y = (style.y ?? 0) + Math.round((height - h) / 2);
  if (!style.backdropBlur && (!style.blend || style.blend === 'normal')) {
    overlay(background, name('styled'), name('output'), x, y);
    return name('output');
  }
  // Backdrop operators need a full-canvas straight-alpha foreground.
  filters.push(transparentGroupSurface(name('pad'), width, height, clock));
  overlay(name('pad'), name('styled'), name('aligned'), x, y);
  foreground = name('aligned');
  if (style.backdropBlur) {
    filters.push(
      `[${foreground}]split[${name('foreground')}][${name('blurMaskRgba')}]`,
      `[${name('blurMaskRgba')}]alphaextract[${name('blurMask')}]`,
      `[${background}]split[${name('backdrop')}][${name('blurInput')}]`,
      `[${name('blurInput')}]format=gbrp,gblur=sigma=${style.backdropBlur}:steps=2[${name('blurred')}]`,
      `[${name('blurred')}][${name('blurMask')}]alphamerge[${name('maskedBlur')}]`,
    );
    overlay(name('backdrop'), name('maskedBlur'), name('blurComposite'));
    background = name('blurComposite');
    foreground = name('foreground');
  }
  const blend = style.blend;
  if (blend && blend !== 'normal') {
    const operation =
      blend === 'overlay'
        ? "all_expr='if(lte(A,127),2*A*B/255,255-2*(255-A)*(255-B)/255)'"
        : `all_mode=${blend}`;
    filters.push(
      `[${foreground}]split[${name('blendRgba')}][${name('blendRGB')}]`,
      `[${name('blendRgba')}]alphaextract[${name('blendAlpha')}]`,
      `[${background}]split[${name('under')}][${name('underRGB')}]`,
      `[${name('underRGB')}]format=gbrp[${name('underColor')}]`,
      `[${name('blendRGB')}]format=gbrp[${name('overColor')}]`,
      `[${name('underColor')}][${name('overColor')}]blend=${operation}:shortest=1[${name('mixed')}]`,
      `[${name('mixed')}][${name('blendAlpha')}]alphamerge[${name('over')}]`,
    );
    background = name('under');
    foreground = name('over');
  }
  overlay(background, foreground, name('output'));
  return name('output');
}
