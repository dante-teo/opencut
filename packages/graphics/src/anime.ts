import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { createScope, createTimeline, engine } from 'animejs';
import type { Timeline } from 'animejs';
import { useGraphicContext } from './react.js';

// OpenCut samples the JavaScript engine. Browser paint never advances its clock.
engine.useDefaultMainLoop = false;

/** Build one paused timeline after the component commits and resources load. */
export function useGraphicTimeline<T extends HTMLElement | SVGSVGElement>(
  root: RefObject<T | null>,
  build: (timeline: Timeline, element: T) => (() => void) | void,
) {
  const { animation, timing } = useGraphicContext();
  if (!animation)
    throw new Error('useGraphicTimeline requires animation: { version: 1 }.');
  useLayoutEffect(() => {
    const element = root.current;
    if (!element)
      throw new Error('Attach the animation scope to a rendered element.');
    let scope: ReturnType<typeof createScope> | undefined;
    let cleanup: (() => void) | void;
    let unmounted = false;
    animation.prepare.push(() => {
      if (unmounted) return;
      scope = createScope({ root: element, defaults: { autoplay: false } });
      // Let Anime.js leave its scope before propagating author errors.
      const failure = scope.execute(() => {
        try {
          const timeline = createTimeline({ autoplay: false });
          cleanup = build(timeline, element);
          timeline.pause();
          timeline.seek(timing.seconds * 1000, true);
        } catch (cause) {
          return { cause };
        }
      });
      if (failure) throw failure.cause;
    });
    return () => {
      unmounted = true;
      try {
        cleanup?.();
      } finally {
        scope?.revert();
      }
    };
  }, [animation, timing, root, build]);
}
