import { createElement } from 'react';
import type { ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { graphicContext } from './react.js';
import type { GraphicTiming } from './react.js';

export interface GraphicFrame {
  timing: GraphicTiming;
  props: Record<string, unknown>;
}

declare global {
  interface Window {
    renderOpenCutGraphic(
      frame: GraphicFrame,
      requestId: number,
    ): Promise<number>;
    setOpenCutGraphicResources(resources: Record<string, string>): void;
  }
}

export function installGraphic(component: ComponentType) {
  if (!component)
    throw new Error('Export a React component as the default export.');
  const host = document.getElementById('graphic')!;
  let root: ReturnType<typeof createRoot> | undefined;
  let resources: Record<string, string> = {};
  const decodedImages = new Map<string, Promise<void>>();
  window.setOpenCutGraphicResources = (captured) => {
    resources = captured;
  };
  window.renderOpenCutGraphic = async ({ timing, props }, requestId) => {
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
          { value: { timing, resources } },
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
    await Promise.all([document.fonts.ready, ...images]);
    for (const font of document.fonts)
      if (font.status === 'error')
        throw new Error(`Could not load font '${font.family}'.`);
    return requestId;
  };
}
