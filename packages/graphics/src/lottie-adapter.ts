import type { AnimationItem } from 'lottie-web';
import lottie from 'lottie-web/build/player/lottie_light.js';
import type { GraphicFrameAdapter } from './frame-adapter.js';
import { exactSeconds, intrinsicTime } from './intrinsic-time.js';
import type { IntrinsicRange } from './intrinsic-time.js';

export interface LottieClock {
  fr: number;
  ip: number;
  op: number;
}

export function lottieFrameAdapter(
  clock: LottieClock,
  range: IntrinsicRange,
): GraphicFrameAdapter {
  const duration = (clock.op - clock.ip) / clock.fr;
  return async ({ host, resources, signal }) => {
    const url = resources.__opencut_asset!;
    const bytes = Uint8Array.from(
      atob(url.slice(url.indexOf(',') + 1)),
      (char) => char.charCodeAt(0),
    );
    const animationData: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const animation = lottie.loadAnimation({
      container: host,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      animationData,
      rendererSettings: {
        preserveAspectRatio: 'xMidYMid meet',
        progressiveLoad: false,
      },
    });
    try {
      animation.setSubframe(true);
      await waitForVector(animation, signal);
      return {
        seek({ timing }) {
          const time = intrinsicTime(exactSeconds(timing), duration, range);
          const relative = Math.min(
            clock.op - clock.ip - 0.000001,
            time * clock.fr,
          );
          // lottie-web applies its firstFrame (the asset's ip) internally.
          animation.goToAndStop(relative, true);
        },
        dispose() {
          animation.destroy();
        },
      };
    } catch (error) {
      animation.destroy();
      throw error;
    }
  };
}

function waitForVector(animation: AnimationItem, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const ready = () => settle(resolve);
    const failed = () =>
      settle(() =>
        reject(new Error('Lottie failed preparing the vector scene.')),
      );
    const aborted = () => settle(() => reject(signal.reason));
    const stop = [
      animation.addEventListener('DOMLoaded', ready),
      animation.addEventListener('data_failed', failed),
      animation.addEventListener('error', failed),
    ];
    function settle(after: () => void) {
      signal.removeEventListener('abort', aborted);
      for (const dispose of stop) dispose();
      after();
    }
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (animation.isLoaded) ready();
  });
}
