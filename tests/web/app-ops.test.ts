import { describe, expect, it } from 'vitest';

import {
  AttemptRowSchema,
  ExportViewSchema,
  HealthReportSchema,
  OverviewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { createMemoryOpsGateway } from '../../src/web/health/gateway.js';
import { createMemoryExportGateway } from '../../src/web/provenance/gateway.js';
import type { ExportView } from '../../src/web/provenance/model.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byId, byTag, findAll, parseHtml, textOf } from './helpers/html.js';

/**
 * Route behaviour over the real request handler for S-16, S-19 and S-21:
 * GET /videos/:id/export, POST /videos/:id/export, GET /health, GET /settings.
 * In-memory gateways only — no socket, database or provider.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: ExportView = ExportViewSchema.parse(FIXTURES['export.get']);
const attemptRow = AttemptRowSchema.parse(
  (FIXTURES['attempts.list'] as { attempts: unknown[] }).attempts[0],
);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

function exportView(overrides: Partial<ExportView> = {}): ExportView {
  return { ...fixture, ...overrides };
}

function exportGateway(overrides: Partial<ExportView> = {}) {
  return createMemoryExportGateway({
    videoId: detail.id,
    view: exportView(overrides),
    now: () => NOW,
  });
}

function opsGateway() {
  return createMemoryOpsGateway({
    report: health,
    attemptsByVideo: { [detail.id]: [attemptRow] },
  });
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

const exportPath = '/videos/' + detail.id + '/export';

describe('GET /videos/:id/export — S-16', () => {
  it('renders the export panel in place of the stage summaries', async () => {
    const { get } = await signedIn({ exportPackage: exportGateway() });
    const response = await get(exportPath);
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);
    expect(byId(page, 'export')?.attrs['data-video-id']).toBe(detail.id);
    expect(
      byTag(page, 'article').filter((node) => node.attrs['data-stage-summary'] !== undefined),
    ).toHaveLength(0);
    expect(byTag(page, 'script').map((node) => node.attrs['src'])).toContain(
      '/assets/client/workspace.js',
    );
  });

  it('states not eligible while final approval is missing', async () => {
    const { get } = await signedIn({ exportPackage: exportGateway() });
    const page = parseHtml((await get(exportPath)).body);
    expect(byId(page, 'export')?.attrs['data-state']).toBe('not_eligible');
    expect(textOf(byId(page, 'export')!)).toContain(
      'Not eligible for export. Final approval is required first.',
    );
  });

  it('serves the built package with its five downloads and pins', async () => {
    const { get } = await signedIn({
      exportPackage: exportGateway({
        status: 'done',
        package_built_at: '2026-10-20T09:45:00.000Z',
      }),
    });
    const page = parseHtml((await get(exportPath)).body);
    expect(byId(page, 'export')?.attrs['data-state']).toBe('built');
    expect(
      byTag(page, 'a').filter((node) =>
        (node.attrs['class'] ?? '').includes('export-row-download'),
      ),
    ).toHaveLength(5);
    expect(
      findAll(byId(page, 'export-pins')!, (node) => node.attrs['data-stage'] !== undefined),
    ).toHaveLength(11);
  });

  it('keeps the F-04 stage summaries when no export surface is mounted', async () => {
    const { get } = await signedIn();
    const page = parseHtml((await get(exportPath)).body);
    expect(byId(page, 'export')).toBeUndefined();
    expect(
      byTag(page, 'article').filter((node) => node.attrs['data-stage-summary'] !== undefined),
    ).not.toHaveLength(0);
  });

  it('answers 503 with an honest banner when the export view cannot be loaded', async () => {
    const broken = {
      get: async () => {
        throw new Error('boom');
      },
    };
    const { get } = await signedIn({ exportPackage: broken });
    const response = await get(exportPath);
    expect(response.status).toBe(503);
    const page = parseHtml(response.body);
    expect(textOf(byId(page, 'export-notice')!)).toContain('could not be loaded');
  });

  it('redirects an unauthenticated reader to login', async () => {
    const { get } = await signedIn({ exportPackage: exportGateway() });
    const unauthenticated = createWebApp({
      sessions: new MemorySessionStore(),
      authenticate: () => ({ kind: 'rejected' }),
      overview,
      health,
      now: () => NOW,
    });
    const response = await unauthenticated({ method: 'GET', url: exportPath });
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.headers['location'] ?? '').toContain('/login');
    expect((await get(exportPath)).status).toBe(200);
  });
});

describe('POST /videos/:id/export — export.build', () => {
  it('builds an approved, unbuilt package and redirects to the built notice', async () => {
    const gateway = createMemoryExportGateway({
      videoId: detail.id,
      view: exportView({ status: 'not_run', package_built_at: null }),
      now: () => NOW,
    });
    const { post, get } = await signedIn({ exportPackage: gateway });
    const response = await post(exportPath, '');
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe(exportPath + '?notice=built');
    expect(gateway.current()?.status).toBe('done');
    expect(gateway.current()?.package_built_at).toBe('2026-10-20T09:41:12.000Z');

    const page = parseHtml((await get(response.headers['location'] ?? exportPath)).body);
    expect(byId(page, 'export')?.attrs['data-state']).toBe('built');
    expect(byId(page, 'export-notice')?.attrs['data-notice']).toBe('success');
    expect(textOf(byId(page, 'export-notice')!)).toContain('built');
  });

  it('refuses to build while export is blocked, with a 409 and a named reason', async () => {
    const { post } = await signedIn({ exportPackage: exportGateway() });
    const response = await post(exportPath, '');
    expect(response.status).toBe(409);
    const page = parseHtml(response.body);
    expect(byId(page, 'export-notice')?.attrs['data-notice']).toBe('error');
    expect(textOf(byId(page, 'export-notice')!)).toContain('final approval is required first');
    expect(byId(page, 'export')?.attrs['data-state']).toBe('not_eligible');
  });

  it('answers 503 JSON when no export surface is mounted', async () => {
    const { post } = await signedIn();
    const response = await post(exportPath, '');
    expect(response.status).toBe(503);
    expect(response.headers['content-type'] ?? '').toContain('application/json');
    expect(JSON.parse(response.body).error.code).toBe('not_ready');
  });

  it('answers 503 JSON when the gateway has no build seam', async () => {
    const { post } = await signedIn({ exportPackage: { get: async () => fixture } });
    const response = await post(exportPath, '');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.message).toContain('not mounted');
  });

  it('rejects POST on any other video path', async () => {
    const { post } = await signedIn({ exportPackage: exportGateway() });
    const response = await post('/videos/' + detail.id + '/render', '');
    expect(response.status).toBe(405);
  });
});

describe('GET /health — S-19', () => {
  it('renders the health page with the status strip from the same report', async () => {
    const { get } = await signedIn({ ops: opsGateway() });
    const response = await get('/health');
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);
    expect(byId(page, 'health')?.attrs['data-state']).toBe('degraded');
    expect(textOf(byId(page, 'health-heading')!)).toBe('Health details');
    expect(byTag(page, 'h1').length).toBe(1);
  });

  it('lists the selected video attempt rows, newest first', async () => {
    const { get } = await signedIn({ ops: opsGateway() });
    const page = parseHtml((await get('/health?video=' + detail.id)).body);
    expect(findAll(page, (node) => node.attrs['data-attempt'] !== undefined)).toHaveLength(1);
    expect(byId(page, 'health-attempt-video')).toBeDefined();
  });

  it('keeps the stage filter in the URL and the form', async () => {
    const { get } = await signedIn({ ops: opsGateway() });
    const page = parseHtml((await get('/health?video=' + detail.id + '&stage=NA')).body);
    const select = byId(page, 'health-stage-filter')!;
    const selected = byTag(select, 'option').filter((node) => node.attrs['selected'] !== undefined);
    expect(selected.map((node) => node.attrs['value'])).toEqual(['NA']);
  });

  it('ignores a malformed video or stage instead of failing the page', async () => {
    const { get } = await signedIn({ ops: opsGateway() });
    const response = await get('/health?video=not-a-uuid&stage=ZZ');
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);
    expect(byId(page, 'health-video-picker')).toBeDefined();
  });

  it('answers 503 with a named unavailable section when ops is not mounted', async () => {
    const { get } = await signedIn();
    const response = await get('/health');
    expect(response.status).toBe(503);
    expect(textOf(parseHtml(response.body))).toContain('Health data is not mounted');
  });

  it('answers 503 when the health report throws, and does not half-render', async () => {
    const broken = {
      health: async () => {
        throw new Error('db down');
      },
      settings: async () => {
        throw new Error('db down');
      },
      attempts: async () => [],
    };
    const { get } = await signedIn({ ops: broken });
    const response = await get('/health');
    expect(response.status).toBe(503);
    expect(textOf(parseHtml(response.body))).toContain('could not be loaded');
  });

  it('refuses a non-GET method', async () => {
    const { post } = await signedIn({ ops: opsGateway() });
    expect((await post('/health', '')).status).toBe(405);
  });
});

describe('GET /settings — S-21', () => {
  it('renders the read-only settings page from health.providers', async () => {
    const { get } = await signedIn({ ops: opsGateway() });
    const response = await get('/settings');
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);
    expect(byId(page, 'settings')?.attrs['data-read-only']).toBe('true');
    expect(textOf(byId(page, 'settings-summary')!)).toBe('3 of 3 keys present.');
    expect(byTag(page, 'input')).toHaveLength(0);
  });

  it('answers 503 when settings cannot be loaded', async () => {
    const broken = {
      health: async () => health,
      settings: async () => {
        throw new Error('nope');
      },
      attempts: async () => [],
    };
    const { get } = await signedIn({ ops: broken });
    const response = await get('/settings');
    expect(response.status).toBe(503);
    expect(textOf(parseHtml(response.body))).toContain('Settings is not available');
  });

  it('answers 503 when ops is not mounted', async () => {
    const { get } = await signedIn();
    expect((await get('/settings')).status).toBe(503);
  });
});
