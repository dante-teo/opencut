import {
  AmbientLight,
  AnimationMixer,
  BoxGeometry,
  Color,
  DirectionalLight,
  LinearFilter,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import type {
  BufferGeometry,
  Material,
  Object3D,
  WebGLRendererParameters,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sampleMotion } from '@opencut/shared';
import type { AnimatedVector, ThreeScene } from '@opencut/shared';
import type { GraphicFrameAdapter } from './frame-adapter.js';
import { exactSeconds, intrinsicTime } from './intrinsic-time.js';

function vector(
  value: AnimatedVector,
  time: number,
  angle = false,
  positive = false,
) {
  const min = positive ? 0.001 : -1000;
  const unit = angle ? Math.PI / 180 : 1;
  const values = value.map(
    (channel) =>
      Math.max(
        min,
        Math.min(
          1000,
          typeof channel === 'number' ? channel : sampleMotion(channel, time),
        ),
      ) * unit,
  );
  return new Vector3(values[0], values[1], values[2]);
}

function transform(
  object: Object3D,
  definition: NonNullable<ThreeScene['model']>,
  time: number,
) {
  if (definition.position)
    object.position.copy(vector(definition.position, time));
  if (definition.scale)
    object.scale.copy(vector(definition.scale, time, false, true));
  if (definition.rotation) {
    const angles = vector(definition.rotation, time, true);
    object.rotation.set(angles.x, angles.y, angles.z);
  }
}

function disposeScene(scene: Scene) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
    }
  });
  for (const item of textures) item.dispose();
  for (const item of materials) item.dispose();
  for (const item of geometries) item.dispose();
  scene.clear();
}

export function threeFrameAdapter(definition: ThreeScene): GraphicFrameAdapter {
  return async ({ frame, host, resources, signal }) => {
    const {
      timing: { width, height },
    } = frame;
    const options: WebGLRendererParameters = {
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    };
    const renderer = new WebGLRenderer(options);
    const scene = new Scene();
    const camera = new PerspectiveCamera(
      definition.camera.fov ?? 40,
      width / height,
      0.05,
      10000,
    );
    function dispose() {
      disposeScene(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
    try {
      renderer.setSize(width, height);
      renderer.setClearAlpha(0);
      renderer.outputColorSpace = SRGBColorSpace;
      host.appendChild(renderer.domElement);
      for (const light of definition.lights) {
        const color = new Color(light.color);
        const source =
          light.type === 'ambient'
            ? new AmbientLight(color, light.intensity)
            : new DirectionalLight(color, light.intensity);
        if (source instanceof DirectionalLight)
          source.position.fromArray(light.position ?? [2, 4, 5]);
        scene.add(source);
      }
      const model = resources.__opencut_asset;
      const imported = model
        ? await new GLTFLoader().parseAsync(
            Uint8Array.from(atob(model.slice(model.indexOf(',') + 1)), (char) =>
              char.charCodeAt(0),
            ).buffer,
            '',
          )
        : undefined;
      if (imported) scene.add(imported.scene);
      const animation = definition.model?.animation;
      const clip =
        animation &&
        imported?.animations.find(({ name }) => name === animation.name);
      if (animation && (!clip || clip.duration <= 0))
        throw new Error(
          `GLB has no positive-duration animation '${animation.name}'.`,
        );
      const mixer =
        imported && clip ? new AnimationMixer(imported.scene) : undefined;
      const action = clip && mixer?.clipAction(clip).setLoop(LoopOnce, 1);
      if (action) action.clampWhenFinished = true;

      const meshes: {
        mesh: NonNullable<ThreeScene['meshes']>[number];
        object: Mesh;
      }[] = [];
      for (const mesh of definition.meshes ?? []) {
        const geometry =
          mesh.geometry === 'sphere'
            ? new SphereGeometry(0.5, 32, 16)
            : new BoxGeometry(1, 1, 1);
        const material = new MeshStandardMaterial({
          color: new Color(mesh.color),
          roughness: mesh.roughness ?? 0.45,
          metalness: mesh.metalness ?? 0,
        });
        const object = new Mesh(geometry, material);
        scene.add(object);
        meshes.push({ mesh, object });
        if (mesh.texture) {
          const image = new Image();
          image.src = resources[mesh.texture.resource]!;
          await image.decode();
          signal.throwIfAborted();
          const texture = new Texture(image);
          texture.wrapS = texture.wrapT = RepeatWrapping;
          texture.minFilter = LinearFilter;
          texture.colorSpace = SRGBColorSpace;
          if (mesh.texture.repeat)
            texture.repeat.fromArray(mesh.texture.repeat);
          if (mesh.texture.offset)
            texture.offset.fromArray(mesh.texture.offset);
          texture.rotation = ((mesh.texture.rotation ?? 0) * Math.PI) / 180;
          texture.needsUpdate = true;
          material.map = texture;
        }
      }
      await renderer.compileAsync(scene, camera);
      signal.throwIfAborted();
      return {
        seek({ timing }, signal) {
          const seconds = exactSeconds(timing);
          const time =
            (seconds * timing.frameRate.numerator) /
            timing.frameRate.denominator;
          camera.position.copy(vector(definition.camera.position, time));
          const target = vector(definition.camera.target, time);
          if (camera.position.distanceToSquared(target) < 1e-10)
            throw new Error(
              'Perspective camera position matches its target at this time.',
            );
          camera.lookAt(target);
          if (mixer && action && clip && animation) {
            action.reset().play();
            mixer.setTime(
              intrinsicTime(
                seconds * (animation.speed ?? 1),
                clip.duration,
                animation.outOfRange ?? 'hold',
              ),
            );
          }
          if (imported && definition.model)
            transform(imported.scene, definition.model, time);
          for (const { mesh, object } of meshes) transform(object, mesh, time);
          renderer.render(scene, camera);
          const gl = renderer.getContext();
          gl.finish();
          if (gl.isContextLost())
            throw new Error('The WebGL graphics context was lost.');
          signal.throwIfAborted();
        },
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
    }
  };
}
