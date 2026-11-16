export const renderQualities = ['fast', 'quality', 'maximum'] as const;
export type RenderQuality = (typeof renderQualities)[number];

export const renderQualityProfiles = {
  fast: {
    encoding: { preset: 'ultrafast', crf: '28' },
    interpolation: 'fast',
    superResolution: 'fast',
  },
  quality: {
    encoding: { preset: 'veryfast', crf: '17' },
    interpolation: 'quality',
    superResolution: 'quality',
  },
  maximum: {
    encoding: { preset: 'medium', crf: '16' },
    interpolation: 'quality',
    superResolution: 'quality',
  },
} as const;
