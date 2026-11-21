import { useLayoutEffect, useRef } from 'react';
import {
  useGraphicExactTiming,
  useGraphicReadiness,
  useGraphicTiming,
} from '@opencut/graphics/react';

export default function ReadinessDial({ label = 'SOURCE CLOCK' }) {
  const { width, height } = useGraphicTiming();
  const { numerator, denominator } = useGraphicExactTiming();
  const ready = useGraphicReadiness();
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const surface = canvas.current!;
    ready(
      (async () => {
        await document.fonts.ready;
        const context = surface.getContext('2d')!;
        const seconds = numerator / denominator;
        context.clearRect(0, 0, width, height);
        context.fillStyle = '#142839';
        context.fillRect(0, 0, width, height);
        const radius = height * 0.3;
        context.lineWidth = 6;
        context.strokeStyle = '#54e1cc';
        context.beginPath();
        context.arc(
          width / 2,
          height / 2,
          radius,
          -Math.PI / 2,
          -Math.PI / 2 + (seconds % 2) * Math.PI,
        );
        context.stroke();
        context.fillStyle = '#eaf5f1';
        context.textAlign = 'center';
        context.font = '600 20px system-ui';
        context.fillText(label, width / 2, height / 2);
        context.fillText(seconds.toFixed(3) + ' s', width / 2, height / 2 + 30);
      })(),
    );
  }, [width, height, numerator, denominator, label, ready]);

  return <canvas ref={canvas} width={width} height={height} />;
}
