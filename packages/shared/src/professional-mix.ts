export const audioRoles = ['dialogue', 'music', 'other'] as const;
export type AudioRole = (typeof audioRoles)[number];
export const dialoguePresets = [
  'natural-cinematic',
  'clear-voiceover',
] as const;
export const deliveryPresets = ['web', 'broadcast', 'film'] as const;
export type DialoguePreset = (typeof dialoguePresets)[number];
export type DeliveryPreset = (typeof deliveryPresets)[number];

/** Linear interpolation in dB on the mixer's 48 kHz sample clock. */
export interface MixGainPoint {
  sample: number;
  db: number;
}
export interface MixAutomation {
  /** Clip-local keys. An empty curve explicitly disables correction. */
  dialogue?: Record<string, MixGainPoint[]> | undefined;
  /** Project-time keys for the music bus. An empty curve disables ducking. */
  music?: MixGainPoint[] | undefined;
}

export interface ProfessionalMix {
  preset: DialoguePreset;
  enabled?: boolean | undefined;
  cleanup?: number | undefined;
  warmth?: number | undefined;
  clarity?: number | undefined;
  consistency?: number | undefined;
  dialogueLufs?: number | undefined;
  highPassHz?: number | undefined;
  eq?: { frequency: number; q: number; db: number }[] | undefined;
  deEsser?: number | undefined;
  compressor?:
    | {
        thresholdDb: number;
        ratio: number;
        attackMs: number;
        releaseMs: number;
      }
    | undefined;
  ai?: 'deepfilternet' | undefined;
  dereverb?: number | undefined;
  matching?: { amount: number; referenceClip?: string | undefined } | undefined;
  crossfadeMs?: number | undefined;
  ducking?:
    | {
        depthDb?: number | undefined;
        attackMs?: number | undefined;
        holdMs?: number | undefined;
        releaseMs?: number | undefined;
      }
    | undefined;
  delivery?:
    | {
        preset: DeliveryPreset;
        integratedLufs?: number | undefined;
        truePeakDbtp?: number | undefined;
        loudnessRange?: number | undefined;
      }
    | undefined;
  automation?: MixAutomation | undefined;
}

export interface VideoMixEdit {
  mix: ProfessionalMix | null;
  roles?: Record<string, AudioRole> | undefined;
}

export const deliveryTargets = {
  web: { integratedLufs: -16, truePeakDbtp: -1.5, loudnessRange: 12 },
  broadcast: { integratedLufs: -23, truePeakDbtp: -1, loudnessRange: 15 },
  film: { integratedLufs: -24, truePeakDbtp: -2, loudnessRange: 20 },
} satisfies Record<DeliveryPreset, object>;

export const dialoguePresetControls = {
  'natural-cinematic': {
    cleanup: 0.38,
    warmth: 0.42,
    clarity: 0.32,
    consistency: 0.6,
    dialogueLufs: -22,
    duckingDepth: 10,
  },
  'clear-voiceover': {
    cleanup: 0.65,
    warmth: 0.28,
    clarity: 0.58,
    consistency: 0.8,
    dialogueLufs: -19,
    duckingDepth: 13,
  },
} satisfies Record<DialoguePreset, object>;
