import { describe, expect, it } from 'vitest';

import { MemorySessionStore, SESSION_COOKIE } from '../auth/session.js';
import { createWebApp } from '../app.js';

const ASSET_ID = '2abdea3d-3188-4f02-b584-bf14fb4e025a';

function appFor(proxy: {
  get: (id: string, variant: 'thumb' | 'detail' | 'full') => Promise<unknown>;
}) {
  const sessions = new MemorySessionStore();
  const session = sessions.create('operator', Date.now());
  return {
    app: createWebApp({
      sessions,
      authenticate: async () => ({ kind: 'rejected' as const }),
      overview: {} as never,
      assetProxy: proxy as never,
    }),
    cookie: SESSION_COOKIE + '=' + session.token,
  };
}

describe('authenticated asset proxy route', () => {
  it('returns stored image/audio/video bytes with cache and content headers', async () => {
    const { app, cookie } = appFor({
      get: async () => ({
        bytes: Uint8Array.from([1, 2, 3]),
        mimeType: 'video/mp4',
        etag: '"abc"',
      }),
    });

    const response = await app({
      method: 'GET',
      url: '/asset/' + ASSET_ID + '/full',
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(response.bodyBytes).toEqual(Uint8Array.from([1, 2, 3]));
    expect(response.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '3',
      etag: '"abc"',
    });
  });

  it('keeps the asset route behind the normal session guard', async () => {
    const { app } = appFor({ get: async () => null });
    const response = await app({ method: 'GET', url: '/asset/' + ASSET_ID + '/thumb' });
    expect(response.status).toBe(303);
    expect(response.headers.location).toContain('/login?required=1');
  });
});
