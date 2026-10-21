import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConflictEnvelopeSchema,
  ErrorEnvelopeSchema,
  ROUTES,
  SeriesDetailSchema,
  SeriesVersionDetailSchema,
  SeriesVersionSummarySchema,
} from '../../contract/api.js';
import { SeriesDetailResponseSchema } from '../domain/series.js';
import { provisionAuth, TEST_TTL_SECONDS, type AuthFixture } from '../../tests/helpers/auth.js';
import { SKIP_REASON, testDatabaseUrl } from '../../tests/helpers/pg.js';
import {
  createRequestHandler,
  type AuthRuntime,
  type ContentRuntime,
  type HandlerResponse,
  type HealthProbe,
} from './server.js';

/**
 * B-14 series API through the real request handler: real sessions, real CSRF
 * middleware, real Postgres, no socket and no provider.
 *
 * The route list is read from the frozen contract, so a new series endpoint
 * cannot be added without this suite noticing that it is unauthenticated.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[series route tests skipped] ${SKIP_REASON}`);

const probe: HealthProbe = async () => ({ ready: true, degraded_reasons: [] });
const SERIES_ID = '2b1f5c1e-0d3a-4c6f-9a1e-6f1c2d3e4f50';
const VERSION_ID = '2b1f5c1e-0d3a-4c6f-9a1e-6f1c2d3e4f51';

function cookieValue(headers: HandlerResponse['headers'], name: string): string | undefined {
  const raw = headers['set-cookie'];
  if (raw === undefined) return undefined;
  const cookies = typeof raw === 'string' ? [raw] : [...raw];
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator) === name) return pair.slice(separator + 1);
  }
  return undefined;
}

function json(value: unknown): { headers: Record<string, string>; body: string } {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

function bodyOf<T>(response: HandlerResponse): T {
  return JSON.parse(response.body) as T;
}

describe.skipIf(!hasDatabase)('series API (R-001, R-002, R-009, R-024)', () => {
  let fixture: AuthFixture;
  let handle: ReturnType<typeof createRequestHandler>;
  let sessionCookie = '';
  let csrfToken = '';
  let slugSeq = 0;

  beforeAll(async () => {
    fixture = await provisionAuth();
    const auth: AuthRuntime = {
      service: fixture.service,
      sessionTtlSeconds: TEST_TTL_SECONDS,
      secureCookies: false,
    };
    const content: ContentRuntime = { pool: fixture.pool };
    handle = createRequestHandler(probe, auth, content);

    const login = await handle({
      method: 'POST',
      url: '/api/login',
      ...json({ username: 'owner', password: 'test-operator-password-1' }),
    });
    expect(login.status).toBe(200);
    sessionCookie = cookieValue(login.headers, 'reels_session') ?? '';
    csrfToken = bodyOf<{ csrf_token: string }>(login).csrf_token;
    expect(sessionCookie.length).toBeGreaterThan(0);
    expect(csrfToken.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await fixture.close();
  });

  function authHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    return { cookie: `reels_session=${sessionCookie}`, ...overrides };
  }

  function nextSlug(prefix = 'api-series'): string {
    slugSeq += 1;
    return `${prefix}-${slugSeq}`;
  }

  async function create(profile: Record<string, unknown> = {}): Promise<{
    response: HandlerResponse;
    detail: { id: string; revision: number; current_version_id: string; target_duration_s: number };
  }> {
    const response = await handle({
      method: 'POST',
      url: '/api/series',
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ name: `API series ${slugSeq}`, slug: nextSlug(), profile }),
    });
    return { response, detail: bodyOf(response) };
  }

  it('every contract series route requires a session (R-015-4)', async () => {
    // `video.create` also lives under /api/series but belongs to the video card;
    // this gate covers the series and series-version routes B-14 owns.
    const routes = ROUTES.filter((route) => route.id.startsWith('series.'));
    expect(routes.map((route) => route.id).sort()).toEqual([
      'series.create',
      'series.get',
      'series.list',
      'series.update',
      'series.versions.get',
      'series.versions.list',
      'series.versions.mint',
    ]);

    for (const route of routes) {
      const response = await handle({
        method: route.method,
        url: route.path.replace(':seriesId', SERIES_ID).replace(':versionId', VERSION_ID),
        ...(route.method === 'GET' ? {} : json({})),
      });
      expect(response.status, `${route.id} must be gated`).toBe(401);
      expect(ErrorEnvelopeSchema.parse(bodyOf(response)).error.code).toBe('unauthorized');
    }
  });

  it('mutating series routes require the CSRF token', async () => {
    const created = await create();
    expect(created.response.status).toBe(201);
    const id = created.detail.id;

    const attempts: Array<{ method: string; url: string; body: string }> = [
      { method: 'POST', url: '/api/series', body: JSON.stringify({ name: 'x', slug: nextSlug() }) },
      { method: 'PATCH', url: `/api/series/${id}`, body: JSON.stringify({ revision: 1 }) },
      { method: 'POST', url: `/api/series/${id}/versions`, body: JSON.stringify({ revision: 1 }) },
    ];

    for (const attempt of attempts) {
      const response = await handle({
        method: attempt.method,
        url: attempt.url,
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: attempt.body,
      });
      expect(response.status, `${attempt.method} ${attempt.url}`).toBe(403);
      expect(ErrorEnvelopeSchema.parse(bodyOf(response)).error.code).toBe('unauthorized');
    }
  });

  it('create → 201 with a contract-shaped detail; list and get agree', async () => {
    const { response, detail } = await create({
      niche: { subject: 'psychology', audience: 'commuters' },
      target_duration_s: 75,
    });

    expect(response.status).toBe(201);
    const parsed = SeriesDetailSchema.parse(detail);
    expect(parsed.current_version).toBe(1);
    expect(parsed.version_count).toBe(1);
    expect(parsed.revision).toBe(1);
    expect(parsed.profile.niche).toEqual({ subject: 'psychology', audience: 'commuters' });
    expect(response.headers['cache-control']).toBe('no-store');

    const list = await handle({
      method: 'GET',
      url: '/api/series',
      headers: authHeaders(),
    });
    expect(list.status).toBe(200);
    const payload = bodyOf<{ series: unknown[] }>(list);
    expect(payload.series.some((row) => (row as { id: string }).id === parsed.id)).toBe(true);

    const get = await handle({
      method: 'GET',
      url: `/api/series/${parsed.id}`,
      headers: authHeaders(),
    });
    expect(get.status).toBe(200);
    expect(SeriesDetailSchema.parse(bodyOf(get)).current_version_id).toBe(
      parsed.current_version_id,
    );
  });

  it('PATCH mints a new version; the history and the version detail agree', async () => {
    const { detail } = await create({ target_duration_s: 75, voice_config: { voice_id: 'v1' } });

    const patched = await handle({
      method: 'PATCH',
      url: `/api/series/${detail.id}`,
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({
        revision: detail.revision,
        profile: { target_duration_s: 90, voice_config: { speed: 0.95 } },
      }),
    });

    expect(patched.status).toBe(200);
    const updated = SeriesDetailSchema.parse(bodyOf(patched));
    expect(updated.current_version).toBe(2);
    expect(updated.revision).toBe(2);
    expect(updated.target_duration_s).toBe(90);
    expect(updated.profile.voice_config).toEqual({ voice_id: 'v1', speed: 0.95 });
    expect(updated.current_version_id).not.toBe(detail.current_version_id);

    const history = await handle({
      method: 'GET',
      url: `/api/series/${detail.id}/versions`,
      headers: authHeaders(),
    });
    expect(history.status).toBe(200);
    const versions = bodyOf<{ versions: unknown[] }>(history).versions.map((row) =>
      SeriesVersionSummarySchema.parse(row),
    );
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect(versions[0]?.changed_fields.sort()).toEqual(['target_duration_s', 'voice_config.speed']);

    const one = await handle({
      method: 'GET',
      url: `/api/series/${detail.id}/versions/${detail.current_version_id}`,
      headers: authHeaders(),
    });
    expect(one.status).toBe(200);
    const version = SeriesVersionDetailSchema.parse(bodyOf(one));
    expect(version.version).toBe(1);
    expect(version.snapshot.target_duration_s).toBe(75);
    expect(version.pinned_by).toEqual([]);
  });

  it('a stale revision is a 409 conflict envelope carrying both revisions (R-024)', async () => {
    const { detail } = await create();
    const first = await handle({
      method: 'PATCH',
      url: `/api/series/${detail.id}`,
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ revision: 1, profile: { narration_language: 'de' } }),
    });
    expect(first.status).toBe(200);

    const stale = await handle({
      method: 'PATCH',
      url: `/api/series/${detail.id}`,
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ revision: 1, profile: { narration_language: 'fr' } }),
    });

    expect(stale.status).toBe(409);
    const conflict = ConflictEnvelopeSchema.parse(bodyOf(stale));
    expect(conflict.document).toBe('series');
    expect(conflict.current_revision).toBe(2);
    expect(conflict.your_revision).toBe(1);
  });

  it('POST /versions mints an explicit checkpoint and reports its pins', async () => {
    const { detail } = await create();
    const project = await fixture.pool.query<{ id: string }>(
      `INSERT INTO project (series_id) VALUES ($1) RETURNING id`,
      [detail.id],
    );
    const projectId = project.rows[0]?.id ?? '';

    const response = await handle({
      method: 'POST',
      url: `/api/series/${detail.id}/versions`,
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ revision: detail.revision }),
    });

    expect(response.status).toBe(201);
    const version = SeriesVersionDetailSchema.parse(bodyOf(response));
    expect(version.version).toBe(2);
    expect(version.changed_fields).toEqual([]);
    expect(version.pinned_by).toEqual([]);
    expect(projectId.length).toBeGreaterThan(0);
  });

  it('validation_failed names the offending field', async () => {
    const missing = await handle({
      method: 'POST',
      url: '/api/series',
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ slug: nextSlug() }),
    });
    expect(missing.status).toBe(400);
    const missingBody = ErrorEnvelopeSchema.parse(bodyOf(missing));
    expect(missingBody.error.code).toBe('validation_failed');
    expect(missingBody.error.fields?.name).toBeDefined();

    const badSlug = await handle({
      method: 'POST',
      url: '/api/series',
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ name: 'Bad slug', slug: 'Not A Slug' }),
    });
    expect(badSlug.status).toBe(400);
    expect(ErrorEnvelopeSchema.parse(bodyOf(badSlug)).error.fields?.slug).toBeDefined();

    const badDuration = await handle({
      method: 'POST',
      url: '/api/series',
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({
        name: 'Too long',
        slug: nextSlug(),
        profile: { target_duration_s: 181 },
      }),
    });
    expect(badDuration.status).toBe(400);
    expect(
      ErrorEnvelopeSchema.parse(bodyOf(badDuration)).error.fields?.['profile.target_duration_s'],
    ).toBeDefined();
  });

  it('accepts the PRD duration floor of 10 s (contract C-B14-1)', async () => {
    const { response, detail } = await create({ target_duration_s: 10 });
    expect(response.status).toBe(201);
    expect(detail.target_duration_s).toBe(10);

    // PRD R-009-1 (10–180) is enforced; the frozen contract still says 15–300,
    // so the *domain* response schema is used for 10–14 s. This assertion is
    // the executable record of that divergence (evidence/t_972d5a76.md).
    expect(SeriesDetailResponseSchema.parse(detail).profile.target_duration_s).toBe(10);
    expect(() => SeriesDetailSchema.parse(detail)).toThrow(/Too small/);
  });

  it('answers 404 for unknown or malformed ids and 405 for an unsupported method', async () => {
    const unknown = await handle({
      method: 'GET',
      url: '/api/series/2b1f5c1e-0d3a-4c6f-9a1e-6f1c2d3e4f59',
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(bodyOf(unknown)).error.code).toBe('not_found');

    const malformed = await handle({
      method: 'GET',
      url: '/api/series/not-a-uuid',
      headers: authHeaders(),
    });
    expect(malformed.status).toBe(404);

    const wrongMethod = await handle({
      method: 'DELETE',
      url: '/api/series',
      headers: authHeaders({ 'x-csrf-token': csrfToken }),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe('GET, POST');

    const foreignVersion = await handle({
      method: 'GET',
      url: `/api/series/${SERIES_ID}/versions/${VERSION_ID}`,
      headers: authHeaders(),
    });
    expect(foreignVersion.status).toBe(404);
  });

  it('an HTTP edit never mutates an existing project or its stage pins (R-001-4)', async () => {
    const { detail } = await create({ target_duration_s: 75 });
    const project = await fixture.pool.query<{ id: string }>(
      `INSERT INTO project (series_id) VALUES ($1) RETURNING id`,
      [detail.id],
    );
    const projectId = project.rows[0]?.id ?? '';
    await fixture.pool.query(
      `INSERT INTO video_stage (project_id, stage, state, series_version_id)
       VALUES ($1, 'T', 'done', $2), ($1, 'IM', 'done', $2)`,
      [projectId, detail.current_version_id],
    );

    const before = await fixture.pool.query(
      `SELECT to_jsonb(p) AS project,
              (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.stage) FROM video_stage s WHERE s.project_id = p.id) AS stages
         FROM project p WHERE p.id = $1`,
      [projectId],
    );

    const patched = await handle({
      method: 'PATCH',
      url: `/api/series/${detail.id}`,
      headers: authHeaders({ 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
      body: JSON.stringify({ revision: detail.revision, profile: { target_duration_s: 120 } }),
    });
    expect(patched.status).toBe(200);

    const after = await fixture.pool.query(
      `SELECT to_jsonb(p) AS project,
              (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.stage) FROM video_stage s WHERE s.project_id = p.id) AS stages
         FROM project p WHERE p.id = $1`,
      [projectId],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
