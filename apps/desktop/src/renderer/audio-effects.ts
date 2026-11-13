import type { AudioEffect } from '@opencut/core';
import { roomEchoes } from '@opencut/shared';

export function connectEffects(
  context: AudioContext,
  input: AudioNode,
  output: AudioNode,
  effects: readonly AudioEffect[],
) {
  const nodes: AudioNode[] = [];
  let source = input;
  for (const effect of effects) {
    if (effect.type === 'eq') {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = effect.frequency;
      filter.Q.value = 1;
      filter.gain.value = effect.db;
      source.connect(filter);
      nodes.push(filter);
      source = filter;
    } else if (effect.type === 'de-esser') {
      if (!effect.amount) continue;
      const low = context.createBiquadFilter();
      low.type = 'lowpass';
      const high = context.createBiquadFilter();
      high.type = 'highpass';
      for (const filter of [low, high]) {
        filter.frequency.value = 6500;
        filter.Q.value = 0.5;
        source.connect(filter);
      }
      const dynamics = context.createDynamicsCompressor();
      dynamics.threshold.value = -14 - 24 * effect.amount;
      dynamics.ratio.value = 1 + 9 * effect.amount;
      dynamics.knee.value = 0;
      dynamics.attack.value = 0.002;
      dynamics.release.value = 0.05;
      const sum = context.createGain();
      low.connect(sum);
      high.connect(dynamics).connect(sum);
      nodes.push(low, high, dynamics, sum);
      source = sum;
    } else if (effect.type === 'compressor' || effect.type === 'limiter') {
      const dynamics = context.createDynamicsCompressor();
      dynamics.threshold.value =
        effect.type === 'compressor' ? effect.threshold : effect.ceiling;
      dynamics.ratio.value = effect.type === 'compressor' ? effect.ratio : 20;
      dynamics.knee.value = 0;
      dynamics.attack.value = effect.type === 'compressor' ? 0.005 : 0;
      dynamics.release.value = 0.1;
      source.connect(dynamics);
      nodes.push(dynamics);
      source = dynamics;
    } else if (effect.mix > 0) {
      const sum = context.createGain();
      source.connect(sum);
      nodes.push(sum);
      for (const echo of roomEchoes) {
        const delay = context.createDelay();
        delay.delayTime.value = echo.seconds;
        const gain = context.createGain();
        gain.gain.value = echo.gain * effect.mix;
        source.connect(delay).connect(gain).connect(sum);
        nodes.push(delay, gain);
      }
      source = sum;
    }
  }
  source.connect(output);
  return nodes;
}
