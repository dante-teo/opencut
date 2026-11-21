import { defineVideo, videoParams, type VideoDefinition } from '@opencut/sdk';
import signal from './signal.video.json' with { type: 'json' };

export default defineVideo(
  {
    audio: videoParams
      .enum(signal.parameters.audio.choices)
      .default(signal.parameters.audio.default),
    description: videoParams
      .string()
      .default(signal.parameters.description.default),
  },
  ({ audio, description }) => {
    const data = structuredClone(signal.composition);
    data.assets.tone.path = audio;
    Object.assign(data.assets.displays.scene.children[3]!, {
      content: description,
    });
    return data as VideoDefinition;
  },
);
