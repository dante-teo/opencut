import { cycleTime, sequenceTime } from './motion.js';
import type { MotionChannel, MotionCycle } from './motion.js';

export type AnimatedNumber = number | MotionChannel;
export type SceneColor =
  string | { from: string; to: string; progress: AnimatedNumber };
export type ScenePaint =
  | SceneColor
  | {
      angle: AnimatedNumber;
      stops: readonly { color: SceneColor; offset: number }[];
    };

export type SceneMask =
  | {
      type: 'rect';
      x: AnimatedNumber;
      y: AnimatedNumber;
      width: AnimatedNumber;
      height: AnimatedNumber;
      radius?: AnimatedNumber | undefined;
    }
  | {
      type: 'ellipse';
      x: AnimatedNumber;
      y: AnimatedNumber;
      radiusX: AnimatedNumber;
      radiusY: AnimatedNumber;
    }
  | { type: 'path'; d: string }
  | {
      type: 'gradient';
      angle: AnimatedNumber;
      start: AnimatedNumber;
      end: AnimatedNumber;
    };

export interface GraphicSceneNodeBase {
  id: string;
  timing?:
    | {
        at: number;
        duration?: number | undefined;
        in?: number | undefined;
        speed?: number | undefined;
        cycle?: MotionCycle | undefined;
      }
    | undefined;
  x?: AnimatedNumber | undefined;
  y?: AnimatedNumber | undefined;
  scaleX?: AnimatedNumber | undefined;
  scaleY?: AnimatedNumber | undefined;
  rotation?: AnimatedNumber | undefined;
  rotateX?: AnimatedNumber | undefined;
  rotateY?: AnimatedNumber | undefined;
  perspective?: number | undefined;
  origin?: readonly [number, number] | undefined;
  opacity?: AnimatedNumber | undefined;
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay' | undefined;
  follow?:
    | {
        d: string;
        progress: AnimatedNumber;
        orient?: boolean | undefined;
      }
    | undefined;
  mask?: SceneMask | undefined;
  effects?:
    | {
        blur?: AnimatedNumber | undefined;
        shadow?:
          | {
              x: AnimatedNumber;
              y: AnimatedNumber;
              blur: AnimatedNumber;
              color: SceneColor;
            }
          | undefined;
        brightness?: AnimatedNumber | undefined;
        saturation?: AnimatedNumber | undefined;
      }
    | undefined;
}

export type GraphicSceneNode = GraphicSceneNodeBase &
  (
    | { type: 'group'; children: readonly GraphicSceneNode[] }
    | {
        type: 'rect';
        width: AnimatedNumber;
        height: AnimatedNumber;
        radius?: AnimatedNumber | undefined;
        fill: ScenePaint;
      }
    | {
        type: 'ellipse';
        width: AnimatedNumber;
        height: AnimatedNumber;
        fill: ScenePaint;
      }
    | {
        type: 'path';
        d: string;
        fill?: SceneColor | undefined;
        stroke?: SceneColor | undefined;
        strokeWidth?: AnimatedNumber | undefined;
        draw?: AnimatedNumber | undefined;
      }
    | {
        type: 'audio';
        mode: 'spectrum' | 'waveform' | 'rms' | 'beat';
        width: AnimatedNumber;
        height: AnimatedNumber;
        color: SceneColor;
        gain?: number | undefined;
      }
    | {
        type: 'image' | 'media-frame';
        resource: string;
        width: AnimatedNumber;
        height: AnimatedNumber;
        fit?: 'contain' | 'cover' | 'fill' | undefined;
      }
    | {
        type: 'text';
        content?: string | undefined;
        runs?:
          | readonly {
              text: string;
              font?: string | undefined;
              color?: SceneColor | undefined;
              weight?: number | undefined;
            }[]
          | undefined;
        counter?:
          | {
              value: AnimatedNumber;
              digits?: number | undefined;
              suffix?: string | undefined;
            }
          | undefined;
        width: AnimatedNumber;
        height: AnimatedNumber;
        size: AnimatedNumber;
        minSize?: number | undefined;
        lineHeight?: number | undefined;
        weight?: number | undefined;
        font?: string | undefined;
        color: SceneColor;
        align?: 'left' | 'center' | 'right' | undefined;
        overflow?: 'fit' | 'clip' | 'error' | undefined;
        stroke?: { color: SceneColor; width: AnimatedNumber } | undefined;
        highlight?:
          | {
              from: number;
              to: number;
              start: number;
              end: number;
              background: SceneColor;
              color?: SceneColor | undefined;
            }[]
          | undefined;
        kinetic?:
          | {
              unit: 'grapheme' | 'word' | 'line';
              stagger: number;
              duration: number;
              offsetY?: number | undefined;
            }
          | undefined;
      }
  );

export interface GraphicScene {
  version: 1;
  units: 'px';
  children: readonly GraphicSceneNode[];
}

export function graphicNodeTime(
  time: number,
  timing: GraphicSceneNode['timing'],
) {
  if (!timing) return time;
  const local = sequenceTime(time, timing.at, timing.duration ?? Infinity);
  if (local === undefined) return undefined;
  const shifted = (timing.in ?? 0) + local * (timing.speed ?? 1);
  return timing.cycle ? cycleTime(shifted, timing.cycle) : shifted;
}
