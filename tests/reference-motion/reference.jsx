import React, { useLayoutEffect, useRef, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  Composition,
  Easing,
  OffthreadVideo,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  registerRoot,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { HtmlInCanvasMotionBlur } from '@remotion/motion-blur';
import {
  useAudioData,
  visualizeAudio,
  visualizeAudioWaveform,
} from '@remotion/media-utils';
import lottie from 'lottie-web/build/player/lottie_light.js';
import {
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import captions from './field-captions.json';
import './reference.css';

const font = new FontFace('Reference', `url(${staticFile('font.ttf')})`, {
  weight: '100 900',
});
const fontHandle = delayRender('Load comparison typeface');
font.load().then((loaded) => {
  document.fonts.add(loaded);
  continueRender(fontHandle);
}, cancelRender);

const ink = '#eaf5f1';
const sea = '#54e1cc';
const midnight = '#101d2b';
const file = (name) => staticFile(name);
const ramp = (frame, from, to) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.32, 0, 0.18, 1),
  });
const fill = { position: 'absolute', inset: 0 };
const label = { fontSize: 26, letterSpacing: 4, fontWeight: 700, color: sea };

function Water({ start = 0, style }) {
  return (
    <OffthreadVideo
      src={file('water.mp4')}
      trimBefore={start}
      muted
      style={{ width: '100%', height: '100%', objectFit: 'cover', ...style }}
    />
  );
}

function FieldNotes() {
  const frame = useCurrentFrame();
  const sourceTime = (frame + 300) / 30;
  const cue = captions.find(
    ({ words }) =>
      sourceTime >= words[0][0] && sourceTime < words.at(-1)[1] + 0.16,
  );
  return (
    <AbsoluteFill style={{ background: midnight, color: ink }}>
      <OffthreadVideo
        src={file('speaker.mp4')}
        trimBefore={300}
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: '48% 50%',
        }}
      />
      <Sequence from={240} durationInFrames={120}>
        <Water start={30} />
      </Sequence>
      <Sequence from={540} durationInFrames={150}>
        <Water start={240} />
      </Sequence>
      <Audio src={file('speech-padded.wav')} trimBefore={300} />
      <Audio
        src={file('score.wav')}
        volume={(t) => 0.48 * Math.min(1, t / 25, (900 - t) / 50)}
      />
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(transparent 49%, #0b152c00 56%, #081628e6 95%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 86,
          top: 104,
          ...label,
          color: ink,
        }}
      >
        FIELD NOTES / 国家公园
        <div
          style={{
            marginTop: 9,
            width: 270 * ramp(frame, 0, 42),
            height: 6,
            background: sea,
          }}
        />
      </div>
      {frame >= 45 && frame < 165 && (
        <div
          style={{
            position: 'absolute',
            left: 86,
            top: 1120,
            background: '#112233e8',
            borderLeft: `8px solid ${sea}`,
            padding: '20px 32px',
            transform: `translateX(${-34 * (1 - ramp(frame, 45, 61))}px)`,
            opacity: ramp(frame, 45, 56) * (1 - ramp(frame, 151, 164)),
          }}
        >
          <div style={{ fontSize: 54, fontWeight: 800 }}>Barack Obama</div>
          <div style={{ fontSize: 31, color: sea }}>
            White House archive · 白宫档案
          </div>
        </div>
      )}
      {cue && (
        <div
          style={{
            position: 'absolute',
            left: 86,
            top: 1380,
            width: 908,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '6px 14px',
              fontSize: 55,
              fontWeight: 800,
              lineHeight: 1.12,
            }}
          >
            {cue.words.map(([from, to, word], i) => {
              const active = sourceTime >= from && sourceTime < to;
              return (
                <span
                  key={i}
                  style={{
                    borderRadius: 10,
                    padding: '1px 7px',
                    color: active ? midnight : ink,
                    background: active ? sea : 'transparent',
                    textShadow: active ? 'none' : '0 2px 9px #00101c',
                  }}
                >
                  {word}
                </span>
              );
            })}
          </div>
          <div style={{ marginTop: 24, fontSize: 43, color: '#d7eae4' }}>
            {cue.zh}
          </div>
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          left: 86,
          bottom: 119,
          width: 908,
          height: 4,
          background: '#ffffff40',
        }}
      >
        <div
          style={{
            width: `${(frame + 1) / 9}%`,
            height: '100%',
            background: sea,
          }}
        />
      </div>
    </AbsoluteFill>
  );
}

function Device({ x, y, angle, accent, width, title, detail }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - 170,
        width,
        height: 340,
        transform: `perspective(950px) rotateY(${angle}deg) rotateX(6deg)`,
        background: `linear-gradient(160deg,${accent}70,#18254a 62%,#09152b)`,
        border: `2px solid ${accent}`,
        borderRadius: 28,
        boxShadow: '0 58px 85px #03061bba',
        overflow: 'hidden',
        padding: '38px 44px',
        color: ink,
      }}
    >
      <div style={{ ...label, color: accent }}>{detail}</div>
      <div style={{ fontSize: 83, fontWeight: 900, marginTop: 20 }}>
        {title}
      </div>
      <svg width="490" height="100" viewBox="0 0 490 100">
        <path
          d="M0 76C94 97 112 13 201 50S350 82 490 14"
          fill="none"
          stroke={accent}
          strokeWidth="5"
        />
      </svg>
    </div>
  );
}

function PrismCards() {
  const frame = useCurrentFrame();
  const entrance = spring({
    frame,
    fps: 30,
    from: 670,
    to: 960,
    config: { mass: 1, stiffness: 175, damping: 13 },
  });
  const x = interpolate(frame, [72, 90], [entrance, 960], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill>
      <Device
        x={1280}
        y={580}
        angle={-22}
        accent="#a39ffc"
        width={580}
        title="Flow"
        detail="02 / MONITOR"
      />
      <Device
        x={x}
        y={630}
        angle={18}
        accent="#72ffe5"
        width={700}
        title="Prism"
        detail="01 / CONTROL"
      />
    </AbsoluteFill>
  );
}

function Prism() {
  const frame = useCurrentFrame();
  const transition = ramp(frame, 315, 344);
  return (
    <AbsoluteFill style={{ color: ink, background: '#13122c' }}>
      <Sequence from={315}>
        <Water start={0} style={{ filter: 'brightness(.62)' }} />
      </Sequence>
      <AbsoluteFill
        style={{
          clipPath: `inset(0 ${transition * 100}% 0 0)`,
          background:
            'radial-gradient(ellipse at 30% 75%,#35436d,#1b2347 53%,#121128)',
        }}
      >
        <div
          style={{
            ...fill,
            clipPath: `ellipse(${45 * ramp(frame, 0, 54)}% 57% at 56% 64%)`,
            background:
              'linear-gradient(120deg,#44cabc44,transparent 52%,#b752df65)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            width: '100%',
            top: 100,
            textAlign: 'center',
          }}
        >
          <div style={label}>PRISM SYSTEMS / PRODUCT STUDY</div>
          <div style={{ fontSize: 109, fontWeight: 900, letterSpacing: -7 }}>
            {Array.from('See the current.').map((char, i) => {
              const phase = ramp(frame, i * 2, i * 2 + 18);
              return (
                <span
                  key={i}
                  style={{
                    display: 'inline-block',
                    opacity: phase,
                    whiteSpace: 'pre',
                    transform: `translateY(${45 * (1 - phase)}px)`,
                  }}
                >
                  {char}
                </span>
              );
            })}
          </div>
        </div>
        <HtmlInCanvasMotionBlur
          width={1920}
          height={1080}
          samples={8}
          shutterAngle={180}
        >
          <PrismCards />
        </HtmlInCanvasMotionBlur>
      </AbsoluteFill>
      {frame >= 324 && (
        <div
          style={{
            position: 'absolute',
            bottom: 110,
            left: 132,
            opacity: ramp(frame, 324, 365),
            textShadow: '0 4px 15px #020b1a',
          }}
        >
          <div style={label}>PRISM / 2026</div>
          <div style={{ fontSize: 76, fontWeight: 850 }}>Find the flow.</div>
        </div>
      )}
    </AbsoluteFill>
  );
}

const stations = [
  'North pass',
  'Estuary',
  'International catchment intake',
  'South basin',
];
function Waterline({ values = [24, 45, 72, 90] }) {
  const frame = useCurrentFrame();
  const baseline = 790;
  const points = values.map((value, i) => [
    362 + i * 330,
    baseline - value * 4.8,
  ]);
  const path = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y - 28}`)
    .join(' ');
  return (
    <AbsoluteFill style={{ background: '#102234', color: ink }}>
      <div style={{ position: 'absolute', left: 130, top: 86 }}>
        <div style={label}>COMMUNITY WATER / FIELD INDEX</div>
        <div style={{ fontSize: 96, fontWeight: 850, letterSpacing: -4 }}>
          Waterline
        </div>
        <div style={{ color: '#97b9c2', fontSize: 39 }}>
          Normalized intake readings by station
        </div>
      </div>
      <svg width="1920" height="1080" style={fill}>
        {[0, 25, 50, 75, 100].map((n) => (
          <g key={n}>
            <path
              d={`M212 ${baseline - n * 4.8}H1700`}
              stroke="#ffffff26"
              strokeWidth="2"
            />
            <text
              x="188"
              y={baseline - n * 4.8 + 9}
              fill="#a2bcc8"
              fontSize="26"
              textAnchor="end"
            >
              {n}
            </text>
          </g>
        ))}
        {points.map(([x], i) => {
          const p = ramp(frame, 38 + i * 21, 160 + i * 21);
          const h = values[i] * 4.8 * p;
          return (
            <g key={i}>
              <rect
                x={x - 68}
                y={baseline - h}
                width="136"
                height={h}
                rx="9"
                fill={i === 3 ? '#a4f0d7' : '#258f98'}
              />
              <text
                x={x}
                y={baseline - h - 15}
                textAnchor="middle"
                fill={ink}
                fontSize="37"
                fontWeight="800"
              >
                {Math.round(values[i] * p)}
              </text>
            </g>
          );
        })}
        <path
          d={path}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - ramp(frame, 220, 389)}
          stroke="#ffc984"
          fill="none"
          strokeWidth="7"
          strokeLinejoin="round"
        />
        <g opacity={ramp(frame, 356, 395)}>
          <path
            d={`M${points[3][0]},${points[3][1] - 28}l85,-80h150`}
            stroke="#ffcb87"
            strokeWidth="3"
            fill="none"
          />
          <text
            x={points[3][0] + 92}
            y={points[3][1] - 131}
            fill="#ffcb87"
            fontSize="24"
          >
            Highest intake
          </text>
        </g>
      </svg>
      {stations.map((station, i) => (
        <div
          key={station}
          title={station}
          style={{
            position: 'absolute',
            left: points[i][0] - 145,
            top: 829,
            width: 290,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            textAlign: 'center',
            fontSize: 31,
            color: '#b7d2d7',
          }}
        >
          {station}
        </div>
      ))}
      <div style={{ position: 'absolute', left: 130, bottom: 77, ...label }}>
        SOURCE / SYNTHETIC STATION DATA
      </div>
    </AbsoluteFill>
  );
}

function Signal({ pitch = 220 }) {
  const frame = useCurrentFrame();
  const src = file(`signal-${pitch}.wav`);
  const data = useAudioData(src, { sampleRate: 48000 });
  const sourceFrame = frame + 15;
  const wave =
    frame >= 15 && data
      ? visualizeAudioWaveform({
          audioData: data,
          frame: sourceFrame,
          fps: 30,
          windowInSeconds: 0.055,
          numberOfSamples: 192,
          normalize: false,
        })
      : [];
  const spectrum =
    frame >= 15 && data
      ? visualizeAudio({
          audioData: data,
          frame: sourceFrame,
          fps: 30,
          numberOfSamples: 256,
          optimizeFor: 'accuracy',
          smoothing: false,
        })
      : [];
  const marker = [45, 135, 255].find(
    (beat) => frame >= beat && frame < beat + 8,
  );
  return (
    <AbsoluteFill style={{ background: '#141425', color: ink }}>
      <Sequence from={15}>
        <Audio src={src} trimBefore={30} volume={0.7} />
      </Sequence>
      <div style={{ position: 'absolute', left: 132, top: 94 }}>
        <div style={{ ...label, color: '#ffbf83' }}>LAB / AUDIO TELEMETRY</div>
        <div style={{ fontSize: 92, fontWeight: 900 }}>Signal</div>
        <div style={{ fontSize: 36, color: '#a4adc8' }}>
          {pitch} Hz test tone · 48 kHz PCM
        </div>
      </div>
      <svg width="1920" height="1080" style={fill}>
        <rect
          x="132"
          y="363"
          width="1656"
          height="290"
          rx="24"
          fill="#23243e"
        />
        <path d="M156 506 H1764" stroke="#787caa" strokeDasharray="5 11" />
        <polyline
          points={wave
            .map((value, i) => `${156 + (i * 1608) / 191},${506 - value * 354}`)
            .join(' ')}
          stroke={sea}
          strokeWidth="3"
          fill="none"
        />
        {spectrum.slice(0, 48).map((value, i) => {
          const height = Math.min(190, value * 1080) + 3;
          return (
            <rect
              key={i}
              x={132 + i * 34.5}
              y={909 - height}
              width="26"
              height={height}
              rx="3"
              fill={i % 2 ? '#ffae77' : '#f7d69f'}
            />
          );
        })}
        <circle
          cx="1720"
          cy="150"
          r={marker === undefined ? 11 : 26}
          fill={marker === undefined ? '#856f87' : '#ffad73'}
        />
      </svg>
      <div style={{ position: 'absolute', left: 132, bottom: 88, ...label }}>
        TRIM 01.000 S / OFFSET 00.500 S
      </div>
    </AbsoluteFill>
  );
}

function RelayVector() {
  const frame = useCurrentFrame();
  const cursor = useRef(frame);
  cursor.current = frame;
  const vector = useRef(null);
  const animation = useRef(null);
  const [handle] = useState(() => delayRender('Load Relay vector animation'));
  function draw() {
    const i = cursor.current;
    // Trim and speed are in composition frames. The vector clock is 24 fps.
    const source = i < 150 ? i + 24 : 72 + (i - 150) * 1.5;
    animation.current.goToAndStop((source * 24) / 30, true);
  }
  useLayoutEffect(() => {
    let disposed = false;
    fetch(file('relay.json'))
      .then((response) => response.json())
      .then((data) => {
        if (disposed) return;
        const item = lottie.loadAnimation({
          container: vector.current,
          renderer: 'svg',
          loop: false,
          autoplay: false,
          animationData: data,
        });
        animation.current = item;
        item.addEventListener('data_failed', () =>
          cancelRender(new Error('Relay source failed')),
        );
        item.addEventListener('DOMLoaded', () => {
          item.setSubframe(true);
          draw();
          continueRender(handle);
        });
      })
      .catch(cancelRender);
    return () => {
      disposed = true;
      animation.current?.destroy();
      animation.current = null;
    };
  }, [handle]);
  useLayoutEffect(() => {
    if (animation.current?.isLoaded) draw();
  }, [frame]);
  return <div ref={vector} style={fill} />;
}

function Relay() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: midnight, color: ink }}>
      <Water start={90} style={{ filter: 'brightness(.57)' }} />
      <RelayVector />
      <div style={{ position: 'absolute', left: 132, bottom: 97 }}>
        <div style={label}>
          VECTOR TELEMETRY / {frame < 150 ? '1×' : '1.5×'}
        </div>
        <div style={{ fontSize: 76, fontWeight: 850 }}>Relay</div>
      </div>
    </AbsoluteFill>
  );
}

function Model() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const host = useRef(null);
  const runtime = useRef(null);
  const current = useRef(frame);
  current.current = frame;
  const [handle] = useState(() => delayRender('Load Parallax GLB'));
  function draw(t) {
    const { renderer, scene, camera } = runtime.current;
    const angle = interpolate(t, [0, 299], [-0.61, 0.74]);
    camera.position.set(5.4 * Math.sin(angle), 1.7, 5.4 * Math.cos(angle));
    camera.lookAt(0, -0.02, 0);
    renderer.render(scene, camera);
    renderer.getContext().finish();
  }
  useLayoutEffect(() => {
    let active = true;
    let renderer;
    try {
      renderer = new WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
      renderer.setSize(width, height);
      renderer.setClearAlpha(0);
      host.current.appendChild(renderer.domElement);
      const scene = new Scene();
      const key = new DirectionalLight('#fff2df', 2.6);
      key.position.set(2, 4, 5);
      scene.add(key, new AmbientLight('#c4e9ff', 2.0));
      const camera = new PerspectiveCamera(40, width / height, 0.1, 50);
      new GLTFLoader()
        .loadAsync(file('parallax.glb'))
        .then(({ scene: mesh }) => {
          if (!active) return;
          scene.add(mesh);
          runtime.current = { renderer, scene, camera };
          draw(current.current);
          continueRender(handle);
        })
        .catch(cancelRender);
    } catch (error) {
      cancelRender(error);
    }
    return () => {
      active = false;
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
      runtime.current = null;
    };
  }, [width, height, handle]);
  useLayoutEffect(() => {
    if (runtime.current) draw(frame);
  }, [frame]);
  return <div ref={host} style={fill} />;
}

function Parallax() {
  return (
    <AbsoluteFill style={{ background: midnight, color: ink }}>
      <Water start={240} style={{ filter: 'brightness(.47)' }} />
      <Model />
      <div style={{ position: 'absolute', left: 133, top: 106 }}>
        <div style={label}>VOLUME STUDIES / 01</div>
        <div style={{ fontSize: 82, fontWeight: 850 }}>Parallax</div>
      </div>
    </AbsoluteFill>
  );
}

function Root() {
  return (
    <>
      <Composition
        id="FieldNotes"
        component={FieldNotes}
        fps={30}
        width={1080}
        height={1920}
        durationInFrames={900}
      />
      <Composition
        id="Prism"
        component={Prism}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={600}
      />
      <Composition
        id="Waterline"
        component={Waterline}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={600}
      />
      <Composition
        id="Signal"
        component={Signal}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={450}
      />
      <Composition
        id="Relay"
        component={Relay}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={300}
      />
      <Composition
        id="Parallax"
        component={Parallax}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={300}
      />
    </>
  );
}

registerRoot(Root);
