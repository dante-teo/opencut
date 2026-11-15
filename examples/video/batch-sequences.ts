import { videoId } from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';

type Track<T extends VideoDefinition['tracks'][number]['type']> = Extract<
  VideoDefinition['tracks'][number],
  { type: T }
>;
type Cue = NonNullable<VideoDefinition['subtitles']>['cues'][number];
type Transition = NonNullable<VideoDefinition['transitions']>[number];

export function titleCard(
  scope: string,
  content: string,
  at: number,
): Track<'text'>['clips'][number] {
  return {
    id: videoId(scope, 'title'),
    at,
    duration: 8,
    text: { content, fontSize: 20, color: '#ffffff' },
  };
}

export function cameraSequence(scope: string, at: number) {
  const first = videoId(scope, 'first');
  const second = videoId(scope, 'second');
  const clips: Track<'video'>['clips'] = [
    {
      id: first,
      at,
      asset: 'picture',
      sourceIn: 2,
      sourceOut: 20,
      muted: true,
      visual: { fit: 'cover' },
    },
    {
      id: second,
      at: at + 18,
      asset: 'picture',
      sourceIn: 22,
      sourceOut: 40,
      muted: true,
      visual: { fit: 'cover' },
    },
  ];
  const transitions: Transition[] = [
    {
      id: videoId(scope, 'dissolve'),
      kind: 'cross-dissolve',
      frames: 4,
      from: first,
      to: second,
    },
  ];
  return { clips, transitions };
}

export function caption(
  scope: string,
  text: string,
  from: number,
  to: number,
): Cue {
  return {
    id: videoId(scope, 'caption'),
    text,
    start: { numerator: from, denominator: 24 },
    end: { numerator: to, denominator: 24 },
  };
}

export function soundtrack(
  scope: string,
  duration: number,
): Track<'audio'>['clips'][number] {
  return {
    id: videoId(scope, 'music'),
    asset: 'music',
    at: 0,
    sourceOut: duration,
    volume: 0.55,
    fadeIn: 3,
    fadeOut: 5,
    effects: [{ type: 'eq', frequency: 120, db: -2 }],
  };
}
