import { defineVideo, videoParams as z } from '@opencut/sdk';
import {
  cameraSequence,
  caption,
  soundtrack,
  titleCard,
} from './batch-sequences.ts';

const fixtures = '../../tests/fixtures/generated';
const sizes = {
  wide: { width: 320, height: 180 },
  tall: { width: 180, height: 320 },
  square: { width: 240, height: 240 },
};
const sources = {
  studio: `${fixtures}/video-medium.mp4`,
  field: `${fixtures}/video-long.mp4`,
};

export default defineVideo(
  {
    title: z.string().trim().min(1).max(32),
    subtitle: z.string().trim().min(1).max(40),
    layout: z.enum(['wide', 'tall', 'square']),
    footage: z.enum(['studio', 'field']).default('studio'),
    music: z.enum(['tone', 'location']).default('tone'),
  },
  ({ title, subtitle, layout, footage, music }) => {
    const intro = cameraSequence('intro', 0);
    const outro = cameraSequence('outro', 36);
    return {
      name: title,
      canvas: { ...sizes[layout], frameRate: 24, durationFrames: 72 },
      assets: {
        picture: {
          kind: 'video',
          path: sources[footage],
          recipe: [{ type: 'resize', width: 320, height: 180 }],
        },
        music:
          music === 'tone'
            ? { kind: 'audio', path: `${fixtures}/audio-tone.wav` }
            : {
                kind: 'audio',
                path: sources.field,
                recipe: [{ type: 'extractAudio' }],
              },
      },
      tracks: [
        {
          id: 'picture-track',
          type: 'video',
          clips: [...intro.clips, ...outro.clips],
        },
        {
          id: 'titles',
          type: 'text',
          clips: [
            titleCard('intro', title, 0),
            titleCard('outro', 'See you soon', 64),
          ],
        },
        {
          id: 'soundtrack',
          type: 'audio',
          clips: [soundtrack('programme', 72)],
        },
      ],
      subtitles: {
        style: { fontSize: 16 },
        cues: [
          caption('intro', subtitle, 8, 34),
          caption('outro', subtitle, 38, 64),
        ],
      },
      transitions: [...intro.transitions, ...outro.transitions],
    };
  },
);
