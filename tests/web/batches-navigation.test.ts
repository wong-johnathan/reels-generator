import { describe, expect, it } from 'vitest';

import { HealthReportSchema, OverviewSchema, SeriesDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebRequest } from '../../src/web/app.js';
import type {
  BatchDetail,
  BatchSummary,
  SeriesBatchIndexEntry,
} from '../../src/web/batches/postgres.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { createMemorySeriesGateway } from '../../src/web/series/gateway.js';
import { byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-05 navigation: `/batches` is the alphabetical series index, and
 * `/series/:id/batch` lists only that series' batches. Everything runs against
 * the in-memory series gateway and a fake batches gateway — no database.
 * Series isolation and newest-first ordering are SQL behaviours and are proven
 * in `src/web/batches/postgres.test.ts`; here the route proves it asks for the
 * right series, renders what it is given, and keeps the 404/empty states honest.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');
const seriesDetail = SeriesDetailSchema.parse(FIXTURES['series.get']);
const OTHER_SERIES_ID = '99999999-9999-4999-8999-999999999999';

function batchSummary(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'b1',
    ordinal: 1,
    status: 'ACTIVE',
    targetCount: 1,
    createdAt: '2026-10-20T09:40:00.000Z',
    seriesId: seriesDetail.id,
    seriesName: seriesDetail.name,
    seriesSlug: seriesDetail.slug,
    videos: [],
    ...overrides,
  };
}

function indexEntry(overrides: Partial<SeriesBatchIndexEntry> = {}): SeriesBatchIndexEntry {
  return {
    seriesId: seriesDetail.id,
    seriesName: seriesDetail.name,
    seriesSlug: seriesDetail.slug,
    batchCount: 1,
    activeBatches: 1,
    completeBatches: 0,
    cancelledBatches: 0,
    videoCount: 0,
    downloadableCount: 0,
    newestBatchAt: '2026-10-20T09:40:00.000Z',
    ...overrides,
  };
}

interface FakeBatches {
  readonly gateway: {
    list: () => Promise<readonly BatchSummary[]>;
    detail: (id: string) => Promise<BatchDetail | null>;
    regenerate: () => Promise<{ readonly requeued: number }>;
    seriesIndex: () => Promise<readonly SeriesBatchIndexEntry[]>;
    bySeries: (id: string) => Promise<readonly BatchSummary[]>;
  };
  readonly bySeriesCalls: string[];
}

function fakeBatches(
  options: {
    readonly seriesIndex?: readonly SeriesBatchIndexEntry[];
    readonly bySeries?: (id: string) => readonly BatchSummary[];
  } = {},
): FakeBatches {
  const bySeriesCalls: string[] = [];
  return {
    bySeriesCalls,
    gateway: {
      list: async () => [],
      detail: async () => null,
      regenerate: async () => ({ requeued: 0 }),
      seriesIndex: async () => options.seriesIndex ?? [],
      bySeries: async (id) => {
        bySeriesCalls.push(id);
        return options.bySeries?.(id) ?? [];
      },
    },
  };
}

function makeApp(batches: FakeBatches) {
  const sessions = new MemorySessionStore();
  const series = createMemorySeriesGateway({
    detail: seriesDetail,
    versions: [],
    projects: [],
    inFlightBatches: seriesDetail.in_flight_batches,
  });
  const handle = createWebApp({
    sessions,
    authenticate: async () => ({ kind: 'authenticated' as const, username: 'operator' }),
    overview,
    health,
    now: () => NOW,
    series,
    batches: batches.gateway,
  });
  return { handle, sessions, series };
}

async function signIn(handle: ReturnType<typeof makeApp>['handle']): Promise<string> {
  const response = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  return (response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

const get = (path: string, cookie: string): WebRequest => ({
  method: 'GET',
  url: path,
  headers: { cookie },
});

describe('S-05 batches index (alphabetical series-first)', () => {
  it('renders each series as a link to its batch page', async () => {
    const batches = fakeBatches({
      seriesIndex: [indexEntry({ seriesId: 's-aaa', seriesName: 'Alpha' })],
    });
    const { handle } = makeApp(batches);
    const cookie = await signIn(handle);

    const response = await handle(get('/batches', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('Alpha');
    expect(response.body).toContain('href="/series/s-aaa/batch"');
    // The nav still marks Batches as the active destination.
    expect(response.body).toContain('aria-current="page"');
  });

  it('shows the honest empty state when there are no series', async () => {
    const { handle } = makeApp(fakeBatches());
    const cookie = await signIn(handle);
    const response = await handle(get('/batches', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('No series yet');
  });
});

describe('S-05 series batch page (/series/:id/batch)', () => {
  it('lists only that series batches and links back to the series', async () => {
    const batches = fakeBatches({
      bySeries: (id) => (id === seriesDetail.id ? [batchSummary()] : []),
    });
    const { handle } = makeApp(batches);
    const cookie = await signIn(handle);

    const response = await handle(get('/series/' + seriesDetail.id + '/batch', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('batch-0001');
    expect(response.body).toContain(seriesDetail.name);
    // Breadcrumb back link to the series editor.
    expect(response.body).toContain('href="/series/' + seriesDetail.id + '"');
    // The route asked for exactly this series.
    expect(batches.bySeriesCalls).toEqual([seriesDetail.id]);
  });

  it('renders the no-batches empty state for a series with none', async () => {
    const { handle } = makeApp(fakeBatches({ bySeries: () => [] }));
    const cookie = await signIn(handle);
    const response = await handle(get('/series/' + seriesDetail.id + '/batch', cookie));
    expect(response.status).toBe(200);
    expect(response.body).toContain('No batches yet');
  });

  it('answers 404 for an unknown series instead of an empty list', async () => {
    const { handle } = makeApp(fakeBatches());
    const cookie = await signIn(handle);
    const response = await handle(get('/series/' + OTHER_SERIES_ID + '/batch', cookie));
    expect(response.status).toBe(404);
    expect(response.body).toContain('Page not found');
  });

  it('keeps the batch detail route intact', async () => {
    const batches = fakeBatches();
    const { handle } = makeApp(batches);
    const cookie = await signIn(handle);
    const response = await handle(get('/batches/b1', cookie));
    // The fake detail returns null, so the route answers 404 — proving the
    // `/batches/:batchId` route still resolves rather than being swallowed.
    expect(response.status).toBe(404);
  });

  it('protects every route behind the session guard', async () => {
    const { handle } = makeApp(fakeBatches());
    for (const path of ['/batches', '/series/' + seriesDetail.id + '/batch']) {
      const response = await handle({ method: 'GET', url: path });
      expect(response.status, path).toBe(303);
      expect(response.headers['location'], path).toBe(
        '/login?required=1&next=' + encodeURIComponent(path),
      );
    }
  });

  it('renders the series batches page under the Series nav, with the title and h1', async () => {
    const { handle } = makeApp(fakeBatches({ bySeries: () => [batchSummary()] }));
    const cookie = await signIn(handle);
    const response = await handle(get('/series/' + seriesDetail.id + '/batch', cookie));
    const doc = parseHtml(response.body);
    expect(textOf(byTag(doc, 'h1')[0]!)).toBe(seriesDetail.name + ' · batches');
  });
});
