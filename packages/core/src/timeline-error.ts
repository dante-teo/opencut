export class TimelineError extends Error {
  override name = 'TimelineError';
  constructor(
    public readonly code:
      | 'TRACK_NOT_FOUND'
      | 'CLIP_NOT_FOUND'
      | 'TRACK_NOT_EMPTY'
      | 'INVALID_EDIT'
      | 'SPLIT_BOUNDS',
    message: string,
  ) {
    super(message);
  }
}
