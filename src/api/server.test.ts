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

describe('page paths without an auth runtime (probe-only embedding)', () => {
  const handle = createRequestHandler(async () => ({ ready: true, degraded_reasons: [] }));

  it('answers page paths with 404 rather than a redirect, since no session store exists', async () => {
    const login = await handle({ method: 'GET', url: '/login' });
    expect(login.status).toBe(404);
    expect(login.headers['location']).toBeUndefined();

    const root = await handle({ method: 'GET', url: '/' });
    expect(root.status).toBe(404);
    expect(root.headers['location']).toBeUndefined();
  });

  it('leaves the probes untouched', async () => {
    expect((await handle({ method: 'GET', url: '/healthz' })).status).toBe(200);
  });
});
