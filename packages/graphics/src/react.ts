import { createContext, useContext } from 'react';
import type { GraphicAudioSample } from '@opencut/shared';

export interface GraphicTiming {
  frame: number;
  durationFrames: number;
  frameRate: { numerator: number; denominator: number };
  seconds: number;
  /** Runtime samples this exact source time only for opt-in graphics. */
  exactSourceTime?: { numerator: number; denominator: number } | undefined;
  width: number;
  height: number;
}

export const graphicContext = createContext<{
  timing: GraphicTiming;
  resources: Record<string, string>;
  readiness: Promise<unknown>[];
  audio?: GraphicAudioSample | undefined;
} | null>(null);

function useGraphicContext() {
  const value = useContext(graphicContext);
  if (!value) throw new Error('Graphics hooks require an OpenCut graphic.');
  return value;
}

/** Source-local timing on the project frame grid, independent of output FPS. */
export function useGraphicTiming(): GraphicTiming {
  return useGraphicContext().timing;
}

/** An exact source clock in seconds, independent of requested output FPS. */
export function useGraphicExactTiming() {
  const { exactSourceTime } = useGraphicTiming();
  if (!exactSourceTime)
    throw new Error('This graphic must opt into exact sampling.');
  return exactSourceTime;
}

export function useGraphicAudio(): GraphicAudioSample | undefined {
  return useGraphicContext().audio;
}

export function useGraphicFrame() {
  return useGraphicTiming().frame;
}

/** Register capture work synchronously from a layout effect for this request. */
export function useGraphicReadiness() {
  const { readiness } = useGraphicContext();
  return (ready: Promise<unknown>) => {
    readiness.push(ready);
  };
}

/** Immutable local resource mapping for the current asset. */
export function useGraphicResources() {
  return useGraphicContext().resources as Readonly<Record<string, string>>;
}

/** Return the captured data URL of a declared image, font, or JSON file. */
export function useGraphicResource(id: string) {
  const { resources } = useGraphicContext();
  if (!Object.hasOwn(resources, id))
    throw new Error(`Unknown graphics resource '${id}'.`);
  return resources[id]!;
}

/** Read a declared JSON resource. Keep returned values immutable. */
export function useGraphicData(id: string): unknown {
  const resource = useGraphicResource(id);
  const prefix = 'data:application/json;base64,';
  if (!resource.startsWith(prefix))
    throw new Error(`Graphics resource '${id}' is not JSON.`);
  const bytes = Uint8Array.from(atob(resource.slice(prefix.length)), (byte) =>
    byte.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Smoothly interpolate from 0 to 1 across a source-frame interval. */
export function graphicProgress(frame: number, start: number, end: number) {
  if (end <= start) return frame >= end ? 1 : 0;
  const t = Math.max(0, Math.min(1, (frame - start) / (end - start)));
  return t * t * (3 - 2 * t);
}
