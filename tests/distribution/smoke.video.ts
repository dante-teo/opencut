import { defineVideo } from '@opencut/sdk';

const { title } = await import('./title.ts');

export default defineVideo({
  name: title,
  canvas: { width: 160, height: 90, frameRate: 24, durationFrames: 12 },
  tracks: [
    {
      id: 'titles',
      type: 'text',
      clips: [
        {
          id: 'caption',
          at: 0,
          duration: 12,
          text: { content: title, fontSize: 20 },
        },
      ],
    },
  ],
});
