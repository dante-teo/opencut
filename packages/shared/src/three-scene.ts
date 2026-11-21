import type { AnimatedNumber } from './graphic-scene.js';

export type AnimatedVector = readonly [
  AnimatedNumber,
  AnimatedNumber,
  AnimatedNumber,
];

export interface ThreeScene {
  version: 1;
  camera: {
    position: AnimatedVector;
    target: AnimatedVector;
    fov?: number | undefined;
  };
  lights: readonly {
    type: 'ambient' | 'directional';
    color: string;
    intensity: number;
    position?: readonly [number, number, number] | undefined;
  }[];
  model?:
    | {
        position?: AnimatedVector | undefined;
        rotation?: AnimatedVector | undefined;
        scale?: AnimatedVector | undefined;
        animation?:
          | {
              name: string;
              speed?: number | undefined;
              outOfRange?: 'hold' | 'loop' | 'error' | undefined;
            }
          | undefined;
      }
    | undefined;
  meshes?:
    | readonly {
        id: string;
        geometry: 'box' | 'sphere';
        color: string;
        position?: AnimatedVector | undefined;
        rotation?: AnimatedVector | undefined;
        scale?: AnimatedVector | undefined;
        roughness?: number | undefined;
        metalness?: number | undefined;
        texture?:
          | {
              resource: string;
              repeat?: readonly [number, number] | undefined;
              offset?: readonly [number, number] | undefined;
              rotation?: number | undefined;
            }
          | undefined;
      }[]
    | undefined;
}
