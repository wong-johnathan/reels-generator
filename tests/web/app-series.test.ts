import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import {
  HealthReportSchema,
  OverviewSchema,
  SeriesDetailSchema,
  SeriesVersionDetailSchema,
} from '../../contract/api.js';
import type { SeriesSummarySchema } from '../../contract/api.js';

type SeriesSummary = z.infer<typeof SeriesSummarySchema>;
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import {
  SeriesConflictError,
  createMemorySeriesGateway,
  type MemorySeriesSeed,
} from '../../src/web/series/gateway.js';
import { byId, byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * F-03 signal: "editing a series shows the version-mint commit and 'existing
 * projects/assets untouched' (R-002-3)".
 *
 * Everything here runs against the in-memory gateway and the injected session
 * store: no socket, no database, no provider, no network. The contract route
 * shapes are B-13's to satisfy at INT-01; this card proves the web behaviour
 * and the version-mint semantics the operator sees.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');
const detail = SeriesDetailSchema.parse(FIXTURES['series.get']);
const version3 = SeriesVersionDetailSchema.parse(FIXTURES['series.versions.get']);

const PINS = { SB: 3, IM: 3, NA: 3, TC: 3 } as const;

function seed(overrides: Partial<MemorySeriesSeed> = {}): MemorySeriesSeed {
  return {
    detail,
    versions: [version3],
    projects: [{ id: '22222222-2222-4222-8222-111111111111', pins: PINS }],
    inFlightBatches: detail.in_flight_batches,
    ...overrides,
  };
}

function app(overrides: Partial<WebAppDependencies> = {}) {
  const sessions = new MemorySessionStore();
  const gateway = createMemorySeriesGateway(seed());
  const authenticate = ({
    username,
    password,
  }: {
    username: string;
    password: string;
  }): { kind: 'authenticated'; username: string } | { kind: 'rejected' } =>
    username === 'operator' && password === 'preview-passphrase'
      ? { kind: 'authenticated', username }
      : { kind: 'rejected' };
  const handle = createWebApp({
    sessions,
    authenticate,
    overview,
    health,
    now: () => NOW,
    series: gateway,
    ...overrides,
  });
  return { handle, gateway, sessions };
}

async function signedIn(): Promise<{
  handle: (
    request: WebRequest,
  ) => Promise<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;
  gateway: ReturnType<typeof createMemorySeriesGateway>;
  cookie: string;
}> {
  const { handle, gateway } = app();
  const response = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  const header = response.headers['set-cookie'] ?? '';
  return { handle, gateway, cookie: header.split(';')[0] ?? '' };
}

const get = (path: string, cookie?: string): WebRequest => ({
  method: 'GET',
  url: path,
  ...(cookie === undefined ? {} : { headers: { cookie } }),
});

const post = (path: string, body: Record<string, string>, cookie: string): WebRequest => ({
  method: 'POST',
  url: path,
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

const formValues = (summary: SeriesSummary = detail, overrides: Record<string, string> = {}) => ({
  name: summary.name,
  'niche.subject': 'psychology for founders',
  'niche.audience': 'solo builders',
  'niche.boundaries': 'no medical advice',
  'niche.language': 'en',
  'niche.location': 'global',
  'niche.prohibited_topics': 'politics',
  'niche.preferred_sources': 'peer-reviewed journals',
  'script_style.tone': 'dry, concrete',
  'script_style.structure': 'hook\ntension\nturn\nlanding',
  'voice_config.voice_id': 'voice-fixture',
  'voice_config.speed': '1',
  'voice_config.style': 'documentary',
  narration_language: 'en',
  'art_style.preset': 'inking-comic',
  'art_style.palette': 'duotone',
  'art_style.recurring_protagonist': 'on',
  default_aspect_ratio: '9:16',
  target_duration_s: '75',
  image_resolution: '1K',
  mode: 'creative',
  revision: String(detail.revision),
  ...overrides,
});

describe('access control (R-015-4)', () => {
  it('sends every series route to /login without a session', async () => {
    const { handle } = app();
    for (const path of ['/series', '/series/new', '/series/' + detail.id]) {
      const response = await handle(get(path));
      expect(response.status, path).toBe(303);
      expect(response.headers['location'], path).toBe(
        '/login?required=1&next=' + encodeURIComponent(path),
      );
    }
  });
});

describe('S-03 Series list', () => {
  it('renders the seeded series with its current version and open batches', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get('/series', cookie));
    expect(response.status).toBe(200);
    const doc = parseHtml(response.body);
    expect(byTag(doc, 'h1')[0] && textOf(byTag(doc, 'h1')[0]!)).toBe('Series');
    expect(response.body).toContain(detail.name);
    expect(response.body).toContain('data-version="3"');
    expect(response.body).toContain('1 open batch');
  });

  it('renders the empty state when the operator has no series yet (US-008)', async () => {
    const { handle, cookie } = await signedIn();
    const empty = createWebApp({
      sessions: new MemorySessionStore(),
      authenticate: async () => ({ kind: 'authenticated' as const, username: 'operator' }),
      overview,
      health,
      now: () => NOW,
      series: {
        list: async () => [],
        get: async () => null,
        create: async () => {
          throw new Error('not used');
        },
        update: async () => {
          throw new Error('not used');
        },
        createBatch: async () => {
          throw new Error('not used');
        },
      },
    });
    expect(handle).toBeDefined();
    // Sign in to the empty-list app itself so the cookie resolves in its store.
    const login = await empty({
      method: 'POST',
      url: '/login',
      body: 'username=operator&password=preview-passphrase',
    });
    const emptyCookie = (login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    expect(emptyCookie.startsWith('reels_session=')).toBe(true);
    expect(cookie.startsWith('reels_session=')).toBe(true);
    const response = await empty(get('/series', emptyCookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('No series yet.');
    expect(response.body).toContain('/series/new');
  });

  it('answers 503 with a retry when the list cannot be loaded', async () => {
    const { handle } = app({
      series: {
        list: async () => {
          throw new Error('database unreachable');
        },
        get: async () => null,
        create: async () => {
          throw new Error('unavailable');
        },
        update: async () => {
          throw new Error('unavailable');
        },
        createBatch: async () => {
          throw new Error('unavailable');
        },
      },
    });
    const login = await handle({
      method: 'POST',
      url: '/login',
      body: 'username=operator&password=preview-passphrase',
    });
    const cookie = (login.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    const response = await handle(get('/series', cookie));
    expect(response.status).toBe(503);
    expect(response.body.startsWith('<!doctype html>')).toBe(true);
    expect(response.body).toContain('<main id="main"');
    expect(response.body).toContain('The series list could not be loaded. Nothing was changed.');
    expect(response.body).toContain('Retry');
  });
});

describe('S-04 create (US-008, UX A-4/A-5)', () => {
  it('serves the collapsed form with the version-1 commit panel', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get('/series/new', cookie));
    expect(response.status).toBe(200);
    const doc = parseHtml(response.body);
    expect(byTag(doc, 'fieldset')).toHaveLength(2);
    expect(byTag(doc, 'details')).toHaveLength(1);
    expect(textOf(byTag(doc, 'h1')[0]!)).toBe('New series');
    expect(textOf(parseHtml(response.body))).toContain('This creates the series and mints v1.');
    expect(response.body).toContain('Create series');
    // The action must be the route that accepts POST: /series answers GET only,
    // so a form pointing there 405s on submit with nothing to act on.
    expect(response.body).toContain('method="post" action="/series/new"');
    // A one-line niche invites one-line niches; the field must be a textarea.
    expect(response.body).toContain('<textarea');
    expect(response.body).toMatch(/<textarea[^>]*name="niche\.subject"/);
  });

  it('creates version 1 and redirects to the saved editor', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const response = await handle(
      post('/series/new', formValues(detail, { name: 'Second series' }), cookie),
    );
    expect(response.status).toBe(303);
    const location = response.headers['location'] ?? '';
    expect(location).toMatch(/^\/series\/[0-9a-f-]{36}\?saved=1$/);

    const page = await handle(get(location, cookie));
    expect(page.status).toBe(200);
    expect(page.body).toContain('Saved as v1');
    expect(page.body).toContain('data-version="1"');
    expect(gateway.seriesCount()).toBe(2);
  });

  it('returns 422 with field errors and the typed values intact', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const response = await handle(
      post('/series/new', formValues(detail, { name: '', target_duration_s: '400' }), cookie),
    );
    expect(response.status).toBe(422);
    expect(response.body).toContain('Enter a series name.');
    expect(response.body).toContain(
      'Target duration must be a whole number of seconds from 10 to 180.',
    );
    expect(response.body).toContain('value="400"');
    expect(gateway.seriesCount()).toBe(1);
  });

  it('rejects a name whose derived slug another series already uses, without minting', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const response = await handle(
      post('/series/new', formValues(detail, { name: detail.name }), cookie),
    );
    expect(response.status).toBe(422);
    expect(response.body).toContain('That name is already used by another series.');
    expect(gateway.seriesCount()).toBe(1);
  });
});

describe('S-04 edit and the version mint (R-002-1/3, IP-02)', () => {
  it('shows the commit panel with the next version and the untouched-work sentence', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get('/series/' + detail.id, cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('Version commit');
    expect(response.body).toContain('Saving mints <strong');
    expect(response.body).toContain('>v4</strong>');
    expect(response.body).toContain(
      '1 open batch keeps its current pins; stages that have not started will use v4 when they ' +
        'start. v3 stays immutable. Existing projects and their assets are untouched.',
    );
    expect(response.body).toContain('No changes');
  });

  it('mints v4 on save, redirects, and leaves every existing project pin untouched', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const before = gateway.projectsOf(detail.id);

    const response = await handle(
      post(
        '/series/' + detail.id,
        formValues(detail, { 'voice_config.speed': '1.2', revision: String(detail.revision) }),
        cookie,
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/series/' + detail.id + '?saved=4');

    const after = gateway.projectsOf(detail.id);
    expect(after).toEqual(before);
    expect(after[0]?.pins).toEqual(PINS);

    const updated = await gateway.get(detail.id);
    expect(updated?.current_version).toBe(4);
    expect(updated?.version_count).toBe(4);
    expect(updated?.revision).toBe(detail.revision + 1);
    expect(updated?.in_flight_batches).toBe(detail.in_flight_batches);

    const minted = gateway.versionsOf(detail.id).at(-1)!;
    expect(minted.version).toBe(4);
    expect(minted.changed_fields).toContain('voice_config.speed');
    expect(minted.snapshot['voice_config']).toMatchObject({ speed: 1.2 });

    const page = await handle(get('/series/' + detail.id + '?saved=4', cookie));
    expect(page.body).toContain('Saved as v4');
    expect(page.body).toContain('data-version="4"');
    const live = byId(parseHtml(page.body), 'live-status')!;
    expect(live.attrs['data-message']).toBe(
      'Saved as v4. Existing projects and their assets are untouched.',
    );
    expect(live.attrs['aria-live']).toBe('polite');
  });

  it('never mutates the previous version snapshot (v3 stays immutable)', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const snapshotBefore = JSON.parse(JSON.stringify(gateway.versionsOf(detail.id)[0]?.snapshot));
    await handle(
      post(
        '/series/' + detail.id,
        formValues(detail, { 'art_style.preset': 'flat-comic' }),
        cookie,
      ),
    );
    expect(gateway.versionsOf(detail.id)[0]?.snapshot).toEqual(snapshotBefore);
    expect(gateway.versionsOf(detail.id)[0]?.version).toBe(3);
  });

  it('treats a save with no changes as a no-op, not a version (R-002-1)', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const response = await handle(post('/series/' + detail.id, formValues(detail), cookie));
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/series/' + detail.id + '?unchanged=1');
    expect((await gateway.get(detail.id))?.current_version).toBe(3);
    const page = await handle(get(response.headers['location'] ?? '/series', cookie));
    expect(page.body).toContain('No changes. Nothing was saved.');
  });

  it('answers the IP-09 conflict with 409, the current revision and the typed text preserved', async () => {
    const { handle, cookie, gateway } = await signedIn();
    const response = await handle(
      post(
        '/series/' + detail.id,
        formValues(detail, { 'voice_config.speed': '1.4', revision: '2' }),
        cookie,
      ),
    );
    expect(response.status).toBe(409);
    expect(response.body).toContain('This series was saved by another tab at');
    expect(response.body).toContain(
      '(revision 4). Your revision 2 was not saved. Nothing was overwritten.',
    );
    expect(response.body).toContain('value="1.4"');
    expect(response.body).toContain('Discard mine');
    expect((await gateway.get(detail.id))?.current_version).toBe(3);
  });

  it('refuses edits to an archived series with the R-001-3 reason', async () => {
    const archived = SeriesDetailSchema.parse({ ...detail, status: 'archived' });
    const gateway = createMemorySeriesGateway(seed({ detail: archived }));
    const { handle } = app({ series: gateway });
    const login = await handle({
      method: 'POST',
      url: '/login',
      body: 'username=operator&password=preview-passphrase',
    });
    const cookie = (login.headers['set-cookie'] ?? '').split(';')[0] ?? '';

    const read = await handle(get('/series/' + detail.id, cookie));
    expect(read.status).toBe(200);
    expect(read.body).toContain('Archived series cannot be edited or used for new batches.');

    const write = await handle(post('/series/' + detail.id, formValues(archived), cookie));
    expect(write.status).toBe(409);
    expect(write.body).toContain('Archived series cannot be edited or used for new batches.');
    expect((await gateway.get(detail.id))?.current_version).toBe(3);
  });

  it('answers an unknown series with the SY-3 page', async () => {
    const { handle, cookie } = await signedIn();
    const response = await handle(get('/series/99999999-9999-4999-8999-999999999999', cookie));
    expect(response.status).toBe(404);
    expect(response.body).toContain('Page not found');
  });

  it('accepts only GET/HEAD on the list and GET/HEAD/POST on a series', async () => {
    const { handle, cookie } = await signedIn();
    const list = await handle({ method: 'PUT', url: '/series', headers: { cookie } });
    expect(list.status).toBe(405);
    expect(list.headers['allow']).toBe('GET, HEAD');
    const series = await handle({
      method: 'DELETE',
      url: '/series/' + detail.id,
      headers: { cookie },
    });
    expect(series.status).toBe(405);
    expect(series.headers['allow']).toBe('GET, HEAD, POST');
  });
});

describe('the S-04 enhancer graph (F-03)', () => {
  const reader =
    (kind: string) =>
    (value: string): string =>
      'export const ' + kind + ' = ' + JSON.stringify(value) + ';';

  it('serves every module the editor module imports, and only those', async () => {
    const { handle } = app({
      assets: {
        readClientModule: reader('client'),
        readSharedModule: (path) =>
          path === 'format.js' || path === 'series/commit.js' || path === 'series/fields.js'
            ? reader('shared')(path)
            : null,
      },
    });

    const editor = await handle(get('/assets/client/series-editor.js'));
    expect(editor.status).toBe(200);
    expect(editor.body).toContain('series-editor');

    for (const path of [
      '/assets/series/commit.js',
      '/assets/series/fields.js',
      '/assets/format.js',
    ]) {
      const response = await handle(get(path));
      expect(response.status, path).toBe(200);
      expect(response.headers['content-type'], path).toContain('javascript');
    }

    const commit = await handle(get('/assets/series/commit.js'));
    expect(commit.body).toContain('series/commit.js');
    const format = await handle(get('/assets/format.js'));
    expect(format.body).toContain('format.js');

    expect((await handle(get('/assets/series/model.js'))).status).toBe(404);
    expect((await handle(get('/assets/series/%2e%2e%2fsecret.js'))).status).toBe(404);
    expect((await handle(get('/assets/series/commit'))).status).toBe(404);
  });
});

describe('the gateway itself (R-002 semantics)', () => {
  it('mints strictly increasing versions and keeps every snapshot', async () => {
    const gateway = createMemorySeriesGateway(seed());
    const first = await gateway.update(detail.id, {
      revision: detail.revision,
      profile: { ...detail.profile, mode: 'factual' },
    });
    expect(first.current_version).toBe(4);
    const second = await gateway.update(detail.id, {
      revision: first.revision,
      profile: { ...detail.profile, mode: 'creative' },
    });
    expect(second.current_version).toBe(5);
    expect(gateway.versionsOf(detail.id).map((version) => version.version)).toEqual([3, 4, 5]);
    expect(gateway.versionsOf(detail.id)[1]?.snapshot['mode']).toBe('factual');
  });

  it('raises a conflict carrying the revision the operator must re-apply onto', async () => {
    const gateway = createMemorySeriesGateway(seed());
    await expect(
      gateway.update(detail.id, { revision: 1, name: 'Renamed' }),
    ).rejects.toBeInstanceOf(SeriesConflictError);
  });
});
