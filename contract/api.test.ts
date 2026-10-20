import { describe, expect, it } from 'vitest';

import { ROUTES, type RouteDef, type RouteId } from './api.js';
import { FIXTURES, SSE_FIXTURE } from './mock/fixtures.js';
import { SseEventSchema } from './api.js';

describe('API contract', () => {
  it('freezes the Milestone A endpoint list', () => {
    const routes = ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(routes).size, 'duplicate method+path').toBe(routes.length);
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);

    const expectedA = [
      'GET /healthz',
      'GET /readyz',
      'GET /api/session',
      'POST /api/login',
      'POST /api/logout',
      'GET /api/overview',
      'GET /api/series',
      'POST /api/series',
      'GET /api/series/:seriesId',
      'PATCH /api/series/:seriesId',
      'GET /api/series/:seriesId/versions',
      'POST /api/series/:seriesId/versions',
      'GET /api/series/:seriesId/versions/:versionId',
      'POST /api/series/:seriesId/videos',
      'GET /api/videos/:videoId',
      'POST /api/videos/:videoId/invalidation-preview',
      'GET /api/videos/:videoId/topic',
      'PUT /api/videos/:videoId/topic',
      'POST /api/videos/:videoId/topic/approve',
      'GET /api/videos/:videoId/script',
      'PUT /api/videos/:videoId/script',
      'POST /api/videos/:videoId/script/approve',
      'POST /api/videos/:videoId/script/reject',
      'GET /api/videos/:videoId/storyboard',
      'POST /api/videos/:videoId/storyboard/approve',
      'GET /api/videos/:videoId/scenes',
      'GET /api/videos/:videoId/scenes/:sceneId',
      'POST /api/videos/:videoId/scenes/:sceneId/replace-image',
      'GET /api/videos/:videoId/audio',
      'POST /api/videos/:videoId/audio/rerun',
      'POST /api/videos/:videoId/audio/accept',
      'GET /api/videos/:videoId/render',
      'POST /api/videos/:videoId/render/approve',
      'GET /api/videos/:videoId/export',
      'POST /api/videos/:videoId/export',
      'GET /api/videos/:videoId/attempts',
      'GET /api/videos/:videoId/retry-scope',
      'POST /api/videos/:videoId/stages/:stage/retry',
      'GET /api/health',
      'GET /api/settings/providers',
      'GET /api/events',
    ].sort();
    expect(routes.sort()).toEqual(expectedA);
  });

  it('only exempts the probes and the auth endpoints from the session requirement', () => {
    const publicRoutes = ROUTES.filter((route) => !route.auth).map((route) => route.id);
    expect(publicRoutes).toEqual(['health.live', 'health.ready', 'auth.session', 'auth.login']);
  });

  it('serves a fixture that validates against the declared response schema for every route', () => {
    const failures: string[] = [];
    for (const route of ROUTES as readonly RouteDef[]) {
      const fixture = FIXTURES[route.id as RouteId];
      if (fixture === undefined) {
        failures.push(`${route.id}: no fixture`);
        continue;
      }
      if (route.contentType === 'text/event-stream') continue;
      const parsed = route.response.safeParse(fixture);
      if (!parsed.success)
        failures.push(`${route.id}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    expect(failures).toEqual([]);
  });

  it('keeps the SSE replay fixture valid against the event union', () => {
    expect(SSE_FIXTURE).toHaveLength(5);
    for (const event of SSE_FIXTURE) {
      const parsed = SseEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(event.type)).toBe(true);
    }
  });

  it('rejects a zero revision and a malformed scene number', async () => {
    const { ScriptSaveRequestSchema, SceneNoSchema, InvalidationPreviewRequestSchema } =
      await import('./api.js');
    expect(
      ScriptSaveRequestSchema.safeParse({
        revision: 0,
        content: { hook: '', narration: '', ending: '', title: '', description: '', hashtags: [] },
      }).success,
    ).toBe(false);
    expect(SceneNoSchema.safeParse('S1').success).toBe(false);
    expect(SceneNoSchema.safeParse('S01').success).toBe(true);
    expect(InvalidationPreviewRequestSchema.safeParse({ revision: 1, edits: [] }).success).toBe(
      false,
    );
  });
});
