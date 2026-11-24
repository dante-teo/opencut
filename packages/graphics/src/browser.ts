import { createElement } from 'react';
import type { ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { graphicContext } from './react.js';
import type { GraphicTiming } from './react.js';
import type { GraphicAudioSample } from '@opencut/shared';

const nextPaint = window.requestAnimationFrame.bind(window);

export interface GraphicFrame {
  timing: GraphicTiming;
  props: Record<string, unknown>;
  audio?: GraphicAudioSample;
  mediaFrames?: Record<string, string>;
}

declare global {
  interface Window {
    renderOpenCutGraphic(
      frame: GraphicFrame,
      requestId: number,
    ): Promise<number>;
    setOpenCutGraphicResources(
      resources: Record<string, string>,
    ): Promise<void> | void;
    disposeOpenCutGraphic?(): Promise<void> | void;
  }
}

export function installGraphic(
  component: ComponentType,
  fontAliases = false,
  seed?: number,
) {
  if (!component)
    throw new Error('Export a React component as the default export.');
  const host = document.getElementById('graphic')!;
  let root: ReturnType<typeof createRoot> | undefined;
  let resources: Record<string, string> = {};
  const decodedImages = new Map<string, Promise<void>>();
  window.setOpenCutGraphicResources = async (captured) => {
    resources = Object.freeze(captured);
    if (!fontAliases) return;
    await Promise.all(
      Object.entries(resources).flatMap(([name, url]) => {
        if (!url.startsWith('data:font/')) return [];
        const font = new FontFace(`OpenCut Resource ${name}`, `url("${url}")`, {
          weight: '100 900',
        });
        return [
          font.load().then(
            (loaded) => document.fonts.add(loaded),
            (cause: unknown) => {
              throw new Error(`Could not load declared font '${name}'.`, {
                cause,
              });
            },
          ),
        ];
      }),
    );
  };
  window.disposeOpenCutGraphic = () => root?.unmount();
  window.renderOpenCutGraphic = async (
    { timing, props, audio, mediaFrames },
    requestId,
  ) => {
    const readiness: Promise<unknown>[] = [];
    const animation =
      seed === undefined ? undefined : { seed, prepare: [] as (() => void)[] };
    if (
      animation &&
      (timing.frame < 0 || timing.frame >= timing.durationFrames)
    )
      throw new RangeError(
        'Requested source frame is outside the composition.',
      );
    root?.unmount();
    const errors: unknown[] = [];
    root = createRoot(host, {
      onUncaughtError: (error) => errors.push(error),
      onRecoverableError: (error) => errors.push(error),
    });
    flushSync(() => {
      root!.render(
        createElement(
          graphicContext.Provider,
          {
            value: {
              timing,
              resources: mediaFrames
                ? Object.freeze({ ...resources, ...mediaFrames })
                : resources,
              readiness,
              animation,
              audio,
            },
          },
          createElement(component, props),
        ),
      );
    });
    if (errors.length) throw errors[0];
    const images = Array.from(document.images, (image) => {
      image.loading = 'eager';
      return image.decode();
    });
    // Computed urls include imported CSS and styles set by React.
    const cssSources = new Set<string>();
    for (const element of host.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        for (const property of [
          style.backgroundImage,
          style.maskImage,
          style.borderImageSource,
          style.listStyleImage,
          style.content,
        ]) {
          for (const match of property.matchAll(/url\("([^"]+)"\)/g))
            cssSources.add(match[1]!);
        }
      }
    }
    for (const source of cssSources) {
      if (source.startsWith('#') || source.startsWith(location.href + '#'))
        continue;
      if (!source.startsWith('data:image/'))
        throw new Error(
          'CSS images must come from captured local graphics resources.',
        );
      let decoding = decodedImages.get(source);
      if (!decoding) {
        if (decodedImages.size >= 32) decodedImages.clear();
        const image = new Image();
        image.src = source;
        decoding = image.decode();
        decodedImages.set(source, decoding);
      }
      images.push(decoding);
    }
    if (animation) {
      if (
        host.querySelector(
          'audio, video, iframe, object, embed, animate, animateTransform, animateMotion, set',
        )
      )
        throw new Error(
          'Use timeline-controlled graphics and ordinary OpenCut audio or video tracks.',
        );
      for (const element of host.querySelectorAll<SVGImageElement>('image')) {
        const source = element.href.baseVal;
        if (!source.startsWith('data:image/'))
          throw new Error(
            'SVG images must come from captured local graphics resources.',
          );
        const image = new Image();
        image.src = source;
        images.push(image.decode());
      }
    }
    await Promise.all([document.fonts.ready, ...images, ...readiness]);
    for (const font of document.fonts)
      if (font.status === 'error')
        throw new Error(`Could not load font '${font.family}'.`);
    if (animation) {
      for (const prepare of animation.prepare) prepare();
      if (document.getAnimations().length)
        throw new Error(
          'Browser animations must use a host-controlled Anime.js timeline.',
        );
      // Synchronize with paint while keeping time on the requested source frame.
      await new Promise<void>((ready) => nextPaint(() => ready()));
    }
    return requestId;
  };
}
