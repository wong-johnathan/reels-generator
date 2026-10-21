/**
 * S-16's commit notices, keyed by the `?notice=` token the redirect carries.
 * Kept beside the surface so the route and the renderer share one wording.
 */
export interface ExportNotice {
  readonly kind: 'success' | 'error' | 'info';
  readonly message: string;
}

export function exportNotice(token: string | null): ExportNotice | null {
  switch (token) {
    case 'built':
      return {
        kind: 'success',
        message:
          'Package built. The five files are listed with their sizes and SHA-256; nothing else changed.',
      };
    default:
      return null;
  }
}
