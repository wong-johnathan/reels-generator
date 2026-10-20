import { describe, expect, it } from 'vitest';

import { ErrorEnvelopeSchema, ROUTES, SseEventSchema, type RouteDef } from '../api.js';
import { FIXTURES } from './fixtures.js';
import { createMockHandler, sseBody } from './server.js';

const COOKIE = { cookie: 'session=mock-session-token' };

function pathOf(route: RouteDef): string {
  return route.path
    .replace(':seriesId', '11111111-1111-4111-8111-111111111111')
    .replace(':versionId', '11111111-1111-4111-8111-333333333333')
    .replace(':videoId', '22222222-2222-4222-8222-111111111111')
    .replace(':sceneId', 'dddddddd-dddd-4ddd-8ddd-000000000001')
    .replace(':stage', 'NA');
}

describe('contract mock server', () => {
  const handle = createMockHandler();

  it('answers every contracted route with its fixture', () => {
    for (const route of ROUTES as readonly RouteDef[]) {
      const response = handle({ method: route.method, url: pathOf(route), headers: COOKIE });
      expect(response.status, `${route.id} status`).toBe(route.status ?? 200);
      if (route.contentType === 'text/event-stream') {
        expect(response.headers['content-type']).toContain('text/event-stream');
        continue;
      }
      expect(response.headers['content-type']).toContain('application/json');
      expect(JSON.parse(response.body), `${route.id} body`).toEqual(
        FIXTURES[route.id as keyof typeof FIXTURES],
      );
    }
  });

  it('rejects an unauthenticated call to a protected route with the error envelope', () => {
    const response = handle({
      method: 'GET',
      url: '/api/videos/22222222-2222-4222-8222-111111111111',
    });
    expect(response.status).toBe(401);
    const parsed = ErrorEnvelopeSchema.parse(JSON.parse(response.body));
    expect(parsed.error.code).toBe('unauthorized');
  });

  it('allows the probes and the session lookup without a cookie', () => {
    for (const url of ['/healthz', '/readyz', '/api/session']) {
      expect(handle({ method: 'GET', url }).status).toBe(200);
    }
  });

  it('ignores the query string when matching a route', () => {
    const response = handle({
      method: 'GET',
      url: '/api/videos/22222222-2222-4222-8222-111111111111/attempts?stage=NA&limit=10',
      headers: COOKIE,
    });
    expect(response.status).toBe(200);
  });

  it('returns 404 for an unknown path and 405 for a known path with the wrong method', () => {
    const notFound = handle({ method: 'GET', url: '/api/nope', headers: COOKIE });
    expect(notFound.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(notFound.body)).error.code).toBe('not_found');

    const wrongMethod = handle({ method: 'DELETE', url: '/api/overview', headers: COOKIE });
    expect(wrongMethod.status).toBe(405);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(wrongMethod.body)).error.code).toBe(
      'method_not_allowed',
    );
  });

  it('serialises SSE frames whose data parses as contract events', () => {
    const body = sseBody(FIXTURES['events.stream'] as unknown[]);
    const frames = body.split('\n\n').filter((frame) => frame.trim() !== '');
    expect(frames).toHaveLength(5);
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const event = JSON.parse((dataLine ?? '').slice('data: '.length));
      expect(SseEventSchema.safeParse(event).success, frame).toBe(true);
    }
    const streamed = handle({ method: 'GET', url: '/api/events', headers: COOKIE });
    expect(streamed.body.startsWith('id: 1\nevent: stage.updated\n')).toBe(true);
  });

  it('is deterministic: two identical requests produce identical bytes', () => {
    const a = handle({ method: 'GET', url: '/api/series', headers: COOKIE });
    const b = handle({ method: 'GET', url: '/api/series', headers: COOKIE });
    expect(a.body).toBe(b.body);
  });

  it('lets a caller override one fixture without touching the rest', () => {
    const custom = createMockHandler({
      fixtures: { 'health.ready': { ready: false, degraded_reasons: ['postgres down'] } },
    });
    const response = custom({ method: 'GET', url: '/readyz' });
    expect(JSON.parse(response.body).ready).toBe(false);
    expect(custom({ method: 'GET', url: '/api/session' }).body).toBe(
      handle({ method: 'GET', url: '/api/session' }).body,
    );
  });
});
