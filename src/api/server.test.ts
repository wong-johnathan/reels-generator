import { describe, expect, it } from 'vitest';

import { ReadinessSchema, ErrorEnvelopeSchema } from '../../contract/api.js';
import { createRequestHandler, type HealthProbe } from './server.js';

const ready: HealthProbe = async () => ({ ready: true, degraded_reasons: [] });
const degraded: HealthProbe = async () => ({
  ready: false,
  degraded_reasons: ['postgres unreachable — service not ready'],
});

describe('web probes (R-016-1, R-018)', () => {
  it('answers the liveness probe without touching a dependency', async () => {
    const handle = createRequestHandler(async () => {
      throw new Error('the liveness probe must not call the dependency probe');
    });
    const response = await handle({ method: 'GET', url: '/healthz' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('answers 200 on /readyz when every dependency is reachable', async () => {
    const response = await createRequestHandler(ready)({ method: 'GET', url: '/readyz' });
    expect(response.status).toBe(200);
    expect(ReadinessSchema.parse(JSON.parse(response.body))).toEqual({
      ready: true,
      degraded_reasons: [],
    });
  });

  it('answers 503 with a named reason when a dependency is down (R-018-1)', async () => {
    const response = await createRequestHandler(degraded)({ method: 'GET', url: '/readyz' });
    expect(response.status).toBe(503);
    const parsed = ReadinessSchema.parse(JSON.parse(response.body));
    expect(parsed.ready).toBe(false);
    expect(parsed.degraded_reasons[0]).toContain('postgres');
  });

  it('returns the contract error envelope for unknown routes and wrong methods', async () => {
    const handle = createRequestHandler(ready);
    const notFound = await handle({ method: 'GET', url: '/api/whatever' });
    expect(notFound.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(notFound.body)).error.code).toBe('not_found');

    const wrongMethod = await handle({ method: 'POST', url: '/healthz' });
    expect(wrongMethod.status).toBe(405);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(wrongMethod.body)).error.code).toBe(
      'method_not_allowed',
    );
  });

  it('ignores a query string on the probes', async () => {
    const response = await createRequestHandler(ready)({ method: 'GET', url: '/readyz?verbose=1' });
    expect(response.status).toBe(200);
  });
});

describe('page paths in a build without the dashboard mounted', () => {
  const handle = createRequestHandler(async () => ({ ready: true, degraded_reasons: [] }), {
    service: {
      login: async () => ({ kind: 'rejected' as const }),
      authenticate: async () => null,
      logout: async () => undefined,
    } as unknown as Parameters<typeof createRequestHandler>[1] extends infer T
      ? T extends { service: infer S }
        ? S
        : never
      : never,
    sessionTtlSeconds: 60,
  });

  it('answers GET /login with an explicit 503 page, never a redirect', async () => {
    const response = await handle({ method: 'GET', url: '/login' });
    expect(response.status).toBe(503);
    expect(response.headers['location']).toBeUndefined();
    expect(String(response.headers['content-type'])).toContain('text/html');
    expect(response.body).toContain('Web UI not available in this build');
  });

  it('answers GET / the same way, so the /login redirect loop cannot start', async () => {
    const response = await handle({ method: 'GET', url: '/' });
    expect(response.status).toBe(503);
    expect(response.headers['location']).toBeUndefined();
  });

  it('leaves the API and the probes untouched', async () => {
    expect((await handle({ method: 'GET', url: '/healthz' })).status).toBe(200);
    expect((await handle({ method: 'GET', url: '/api/session' })).status).toBe(200);
  });
});
