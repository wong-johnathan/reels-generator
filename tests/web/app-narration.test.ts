import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  NarrationViewSchema,
  OverviewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { createMemoryNarrationGateway } from '../../src/web/narration/gateway.js';
import { ACCEPT_UNWIRED_REASON, type NarrationView } from '../../src/web/narration/model.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byId, byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-14 route behaviour over the real request handler: GET /videos/:id/audio
 * plus the two commits (US-021, US-022, R-009-3/4). In-memory gateways only —
 * no socket, no database, no provider.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: NarrationView = NarrationViewSchema.parse(FIXTURES['audio.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

function freshView(overrides: Partial<NarrationView> = {}): NarrationView {
  return { ...fixture, accepted_at: null, ...overrides };
}

async function signedIn(overrides: Partial<WebAppDependencies> = {}) {
  const handle = createWebApp({
    sessions: new MemorySessionStore(),
    authenticate: ({ username, password }: { username: string; password: string }) =>
      username === 'operator' && password === 'preview-passphrase'
        ? { kind: 'authenticated', username }
        : { kind: 'rejected' },
    overview,
    health,
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
  const call = async (method: string, path: string, body?: string) =>
    handle({
      method,
      url: path,
      headers: { cookie },
      ...(body === undefined ? {} : { body }),
    } as WebRequest);
  return {
    handle,
    get: (path: string) => call('GET', path),
    post: (path: string, body: string) => call('POST', path, body),
    cookie,
  };
}

function gateway(accept = false) {
  return createMemoryNarrationGateway({ videoId: detail.id, view: freshView(), accept });
}

const audioPath = '/videos/' + detail.id + '/audio';

describe('GET /videos/:id/audio — S-14', () => {
  it('renders the narration panel in place of the stage summaries', async () => {
    const narration = gateway(true);
    const { get } = await signedIn({ narration });
    const response = await get(audioPath);
    expect(response.status).toBe(200);

    const page = parseHtml(response.body);
    const panel = byId(page, 'narration');
    expect(panel?.attrs['data-state']).toBe('ready');
    expect(panel?.attrs['data-video-id']).toBe(detail.id);
    expect(
      byTag(page, 'article').filter((node) => node.attrs['data-stage-summary'] !== undefined),
    ).toHaveLength(0);
    expect(byTag(page, 'audio')).toHaveLength(1);
    const scripts = byTag(page, 'script').map((node) => node.attrs['src']);
    expect(scripts).toContain('/assets/client/narration.js');
    expect(scripts).toContain('/assets/client/workspace.js');
  });
  it('serves the enhancer module and its shared model through the asset routes', async () => {
    const narration = gateway(true);
    const { get } = await signedIn({
      narration,
      assets: {
        readClientModule: (name: string) =>
          name === 'narration' ? 'export const initNarration = 1;' : null,
        readSharedModule: (path: string) =>
          path === 'narration/model.js' ? 'export const formatTransportTime = 1;' : null,
      },
    });
    const client = await get('/assets/client/narration.js');
    expect(client.status).toBe(200);
    expect(client.body).toContain('initNarration');
    const shared = await get('/assets/narration/model.js');
    expect(shared.status).toBe(200);
    expect(shared.body).toContain('formatTransportTime');
    expect((await get('/assets/narration/other.js')).status).toBe(404);
  });

  it('allows media from the same origin in the CSP (the player would be blocked otherwise)', async () => {
    const narration = gateway(true);
    const { get } = await signedIn({ narration });
    const response = await get(audioPath);
    expect(response.headers['content-security-policy']).toContain("media-src 'self'");
  });

  it('explains an unreadable narration instead of inventing one', async () => {
    const failing = {
      get: async () => {
        throw new Error('boom');
      },
      rerun: async () => ({ queued: true }),
    };
    const { get } = await signedIn({ narration: failing });
    const response = await get(audioPath);
    expect(response.status).toBe(503);
    const page = parseHtml(response.body);
    const notice = byTag(page, 'div').find((node) => node.attrs['data-notice'] === 'error');
    expect(textOf(notice as never)).toContain('Narration could not be loaded');
  });

  it('renders the commit notices the redirect carries', async () => {
    const narration = gateway(true);
    const { get } = await signedIn({ narration });
    const page = parseHtml((await get(audioPath + '?notice=rerun-queued')).body);
    const notice = byTag(page, 'div').find((node) => node.attrs['data-notice'] === 'success');
    expect(textOf(notice as never)).toContain('Narration re-run queued: 1 TTS call.');
    const accepted = parseHtml((await get(audioPath + '?notice=accepted')).body);
    expect(textOf(accepted)).toContain('Timing accepted.');
  });

  it('keeps the F-04 stage summary when no narration gateway is mounted', async () => {
    const { get } = await signedIn();
    const response = await get(audioPath);
    const page = parseHtml(response.body);
    expect(byId(page, 'narration')).toBeUndefined();
    expect(
      byTag(page, 'article').filter((node) => node.attrs['data-stage-summary'] !== undefined)
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('POST /videos/:id/audio/rerun', () => {
  it('queues exactly one TTS call and redirects to the notice', async () => {
    const narration = gateway(true);
    const { post } = await signedIn({ narration });
    const response = await post(audioPath + '/rerun', 'reason=script%20tightened');
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe(audioPath + '?notice=rerun-queued');
    expect(narration.calls.rerun).toEqual([{ videoId: detail.id, reason: 'script tightened' }]);
  });

  it('refuses a second call while the take is running (409, no extra call)', async () => {
    const narration = gateway(true);
    const { post } = await signedIn({ narration });
    expect((await post(audioPath + '/rerun', '')).status).toBe(303);
    const second = await post(audioPath + '/rerun', '');
    expect(second.status).toBe(409);
    expect(textOf(parseHtml(second.body))).toContain('Narration is already running.');
    expect(narration.calls.rerun).toHaveLength(1);
  });

  it('rejects a reason longer than the contract allows', async () => {
    const narration = gateway(true);
    const { post } = await signedIn({ narration });
    const response = await post(audioPath + '/rerun', 'reason=' + 'x'.repeat(501));
    expect(response.status).toBe(400);
    expect(narration.calls.rerun).toHaveLength(0);
  });

  it('answers 503, spending nothing, when narration is not mounted', async () => {
    const { post } = await signedIn();
    const response = await post(audioPath + '/rerun', '');
    expect(response.status).toBe(503);
  });
});

describe('POST /videos/:id/audio/accept', () => {
  it('accepts the timing when the seam is wired and redirects', async () => {
    const narration = gateway(true);
    const { post, get } = await signedIn({ narration });
    const response = await post(
      audioPath + '/accept',
      'alignment_id=aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
    );
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe(audioPath + '?notice=accepted');
    expect(narration.calls.accept).toEqual([
      { videoId: detail.id, alignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111' },
    ]);
    const page = byId(parseHtml((await get(audioPath)).body), 'narration-accept');
    expect(page?.attrs['data-accept']).toBe('accepted');
  });

  it('refuses accept with no alignment id rather than inventing one', async () => {
    const narration = gateway(true);
    const { post } = await signedIn({ narration });
    const response = await post(audioPath + '/accept', '');
    expect(response.status).toBe(400);
    expect(narration.calls.accept).toHaveLength(0);
  });

  it('answers 503 with the gap reason when the gateway has no accept seam', async () => {
    const narration = gateway(false);
    const { post } = await signedIn({ narration });
    const response = await post(
      audioPath + '/accept',
      'alignment_id=aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
    );
    expect(response.status).toBe(503);
    expect(textOf(parseHtml(response.body))).toContain(ACCEPT_UNWIRED_REASON);
    expect(narration.calls.accept).toHaveLength(0);
  });

  it('refuses a timing outside the band with 409 (R-009-4)', async () => {
    const narration = createMemoryNarrationGateway({
      videoId: detail.id,
      view: freshView({
        duration_s: 79.1,
        band: { min_s: 71.3, max_s: 78.8, within_band: false },
      }),
      accept: true,
    });
    const { post } = await signedIn({ narration });
    const response = await post(
      audioPath + '/accept',
      'alignment_id=aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
    );
    expect(response.status).toBe(409);
    expect(textOf(parseHtml(response.body))).toContain('outside the band');
    expect(narration.calls.accept).toHaveLength(0);
  });
});

describe('routing edges', () => {
  it('404s an unknown audio action and 405s a commit on another tab', async () => {
    const narration = gateway(true);
    const { get, post } = await signedIn({ narration });
    expect((await get(audioPath + '/delete')).status).toBe(404);
    expect((await post('/videos/' + detail.id + '/script', '')).status).toBe(405);
    expect((await post(audioPath + '/rerun/extra', '')).status).toBe(404);
  });
});
