/**
 * S-14's commit notices, keyed by the `?notice=` token the redirect carries.
 * Kept beside the surface so the route and the renderer share one wording.
 */
export interface NarrationNotice {
  readonly kind: 'success' | 'error' | 'info';
  readonly message: string;
}

export function audioNotice(token: string | null): NarrationNotice | null {
  switch (token) {
    case 'rerun-queued':
      return {
        kind: 'success',
        message: 'Narration re-run queued: 1 TTS call. Timing is derived next, then the render.',
      };
    case 'accepted':
      return {
        kind: 'success',
        message: 'Timing accepted. Captions and the render now use the derived word timings.',
      };
    default:
      return null;
  }
}
