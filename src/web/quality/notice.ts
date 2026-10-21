/**
 * S-15's commit notices, keyed by the `?notice=` token the redirect carries.
 * Kept beside the surface so the route and the renderer share one wording.
 */
export interface QualityNotice {
  readonly kind: 'success' | 'error' | 'info';
  readonly message: string;
}

export function qualityNotice(token: string | null): QualityNotice | null {
  switch (token) {
    case 'approved':
      return {
        kind: 'success',
        message:
          'Final approval recorded. Export is enabled; nothing else changed: no provider call ' +
          'was made and no stage re-ran.',
      };
    default:
      return null;
  }
}
