import {
  defineGraphicScene,
  defineVideo,
  type VideoDefinition,
} from '@opencut/sdk';
import prism from './prism.video.json' with { type: 'json' };

const video = prism as VideoDefinition;
const product = video.assets?.prism;
if (
  product?.kind !== 'graphic' ||
  product.renderer !== 'scene' ||
  !('children' in product.scene)
)
  throw new Error('Prism requires the declarative product scene.');
const scene = defineGraphicScene(product.scene);
product.scene = { ...scene, children: [...scene.children] };
export default defineVideo(video);
