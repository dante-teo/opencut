export interface GraphicAudioAnalysis {
  version: 1;
  source: 'mix' | { track: string };
  window: 512 | 1024 | 2048 | 4096;
  hop: number;
  waveform: number;
  bins: number;
  beats?: readonly { numerator: number; denominator: number }[] | undefined;
}

export interface GraphicAudioSample {
  waveform: readonly number[];
  spectrum: readonly number[];
  rms: number;
  beat: boolean;
}
