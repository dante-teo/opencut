import type {
  RenderCodec,
  RenderQuality,
  RenderResolution,
} from '@opencut/media';

export const exportRates = [
  'project',
  '24',
  '25',
  '30',
  '60',
  '24000/1001',
  '30000/1001',
  '60000/1001',
] as const;
export interface ExportSettings {
  resolution: RenderResolution;
  frameRate: (typeof exportRates)[number];
  codec: RenderCodec;
  quality: RenderQuality;
  burnSubtitles?: boolean;
}
const defaultSettings: ExportSettings = {
  resolution: 'project',
  frameRate: 'project',
  codec: 'h264',
  quality: 'balanced',
};
export const exportPresets: { name: string; settings: ExportSettings }[] = [
  { name: 'Project · balanced', settings: defaultSettings },
  {
    name: '1080p · high quality',
    settings: { ...defaultSettings, resolution: '1080p', quality: 'high' },
  },
  {
    name: '720p · quick review',
    settings: { ...defaultSettings, resolution: '720p', quality: 'draft' },
  },
  {
    name: '1080p · HEVC',
    settings: { ...defaultSettings, resolution: '1080p', codec: 'hevc' },
  },
];
