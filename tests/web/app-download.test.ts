import { describe, expect, it } from 'vitest';

import { OverviewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import type { VideoDownloadFile, VideoDownloadGateway } from '../../src/web/download/gateway.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';

/**
 * S-15 download route — GET /videos/:id/download (US-024).
 *
 * In-memory gateways only: the download seam is injected, so the route's four
 * outcomes (authenticated 200, unauthenticated redirect, 404 missing asset,
 * 503 unbound store) are exercised without a socket, database or object store.
 */
const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

const BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]);

function downloadFile(): VideoDownloadFile {
  return { bytes: BYTES, mimeType: 'video/mp4', filename: 'quiet-machines-1.mp4' };
}

function downloadGateway(file: VideoDownloadFile | null): VideoDownloadGateway {
  return { download: async () => file };
}

const downloadPath = '/videos/' + detail.id + '/download';

async function signedIn(overrides: Partial<WebAppDependencies> = {}) {
  const handle = createWebApp({
    sessions: new MemorySessionStore(),
    authenticate: ({ username, password }: { username: string; password: string }) =>
      username === 'operator' && password === 'preview-passphrase'
        ? { kind: 'authenticated', username }
        : { kind: 'rejected' },
    overview,
    now: () => NOW,
    video: createMemoryVideoGateway([detail]),
    ...overrides,
  });
  const login = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  const cookie = (login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  const call = (method: string, path: string) =>
    handle({ method, url: path, headers: { cookie } } as WebRequest);
  return { handle, get: (path: string) => call('GET', path), cookie };
}

describe('GET /videos/:id/download — S-15', () => {
  it('streams the final MP4 with the right headers and attachment filename', async () => {
    const { get } = await signedIn({ download: downloadGateway(downloadFile()) });
    const response = await get(downloadPath);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="quiet-machines-1.mp4"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toBe('');
    expect(response.bodyBytes).toEqual(BYTES);
  });

  it('redirects an unauthenticated request to login', async () => {
    const handle = createWebApp({
      sessions: new MemorySessionStore(),
      authenticate: async () => ({ kind: 'rejected' }),
      overview,
      now: () => NOW,
      video: createMemoryVideoGateway([detail]),
      download: downloadGateway(downloadFile()),
    });
    const response = await handle({ method: 'GET', url: downloadPath });
    expect(response.status).toBe(303);
    expect(response.headers['location']).toContain('/login');
  });

  it('answers 404 when the video has no rendered asset', async () => {
    const { get } = await signedIn({ download: downloadGateway(null) });
    const response = await get(downloadPath);
    expect(response.status).toBe(404);
    expect(response.bodyBytes).toBeUndefined();
  });

  it('answers 503 when no object store is bound', async () => {
    const { get } = await signedIn();
    const response = await get(downloadPath);
    expect(response.status).toBe(503);
    expect(response.body).toContain('not_ready');
  });

  it('405s a non-GET method on the download path', async () => {
    const { handle, cookie } = await signedIn({ download: downloadGateway(downloadFile()) });
    const response = await handle({
      method: 'POST',
      url: downloadPath,
      headers: { cookie },
      body: '',
    } as WebRequest);
    expect(response.status).toBe(405);
  });
});
