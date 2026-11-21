import { defineVideo, videoParams, type VideoDefinition } from '@opencut/sdk';
import waterline from './waterline.video.json' with { type: 'json' };

export default defineVideo(
  {
    bars: videoParams
      .array(videoParams.json())
      .min(1)
      .default(waterline.parameters.bars.default),
  },
  ({ bars }) => {
    const data = structuredClone(waterline.composition);
    Object.assign(data.assets.chart.scene.children[4]!, { children: bars });
    return data as VideoDefinition;
  },
);
