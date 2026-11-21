export interface VisualGroup {
  id: string;
  tracks: readonly string[];
  matte?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  scale?: number | undefined;
  rotation?: number | undefined;
  opacity?: number | undefined;
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay' | undefined;
  clip?: { x: number; y: number; width: number; height: number } | undefined;
  blur?: number | undefined;
  backdropBlur?: number | undefined;
}
