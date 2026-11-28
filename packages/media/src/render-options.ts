export { renderQualities } from '@opencut/shared';
export type { RenderQuality } from '@opencut/shared';

export const renderCodecs = ['h264', 'hevc'] as const;
export const renderEncoders = ['auto', 'software', 'videotoolbox'] as const;
export const renderResolutions = ['project', '720p', '1080p'] as const;

export type RenderCodec = (typeof renderCodecs)[number];
export type RenderEncoder = (typeof renderEncoders)[number];
export type RenderResolution = (typeof renderResolutions)[number];
