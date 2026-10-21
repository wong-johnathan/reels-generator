import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  OverviewSchema,
  RenderViewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { RenderRefusedError, createMemoryRenderGateway } from '../../src/web/quality/gateway.js';
import { APPROVAL_GATE_LINE, type RenderView } from '../../src/web/quality/model.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byId, byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-15 route behaviour over the real request handler: GET
 * /videos/:id/render and POST /videos/:id/render/approve (US-024, US-025,
 * R-005-3/4). In-memory gateways only — no socket, no database, no provider.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: RenderView = RenderViewSchema.parse(FIXTURES['render.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

function renderView(overrides: Partial<RenderView> = {}): RenderView {
  return { ...fixture, approved: false, approved_at: null, ...overrides };
}

function gateway(overrides: Partial<RenderView> = {}) {
  return createMemoryRenderGateway({
    videoId: detail.id,
    view: renderView(overrides),
    revision: 1,
    now: () => NOW,
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

const renderPath = '/videos/' + detail.id + '/render';

describe('GET /videos/:id/render — S-15', () => {
  it('renders the render panel in place of the stage summaries', async () => {
    const { get } = await signedIn({ render: gateway() });
    const response = await get(renderPath);
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);
    const panel = byId(page, 'quality');
    expect(panel?.attrs['data-state']).toBe('awaiting_approval');
    expect(
      byTag(page, 'article').filter((node) => node.attrs['data-stage-summary'] !== undefined),
    ).toHaveLength(0);
    expect(byTag(page, 'video')).toHaveLength(1);
    const scripts = byTag(page, 'script').map((node) => node.attrs['src']);
    expect(scripts).toContain('/assets/client/workspace.js');
  });

  it('allows same-origin media in the CSP (the render player would be blocked otherwise)', async () => {
    const { get } = await signedIn({ render: gateway() });
    const response = await get(renderPath);
    expect(response.headers['content-security-policy']).toContain("media-src 'self'");
  });

  it('keeps the F-04 stage summary when no render gateway is mounted', async () => {
    const { get } = await signedIn();
    const page = parseHtml((await get(renderPath)).body);
    expect(byId(page, 'quality')).toBeUndefined();
    expect(
      byTag(page, 'article').filter((node) => node.attrs['data-stage-summary'] !== undefined)
        .length,
    ).toBeGreaterThan(0);
  });

  it('renders an unreadable render as an error notice, not as an approved video', async () => {
    const failing = {
      get: async () => {
        throw new Error('boom');
      },
      approve: async () => renderView(),
    };
    const { get } = await signedIn({ render: failing });
    const response = await get(renderPath);
    expect(response.status).toBe(503);
    const page = parseHtml(response.body);
    const notice = byTag(page, 'div').find((node) => node.attrs['data-notice'] === 'error');
    expect(textOf(notice as never)).toContain('could not be loaded');
    expect(byTag(page, 'form')).toHaveLength(0);
  });

  it('renders the approval notice the redirect carries', async () => {
    const approved = gateway();
    await approved.approve(detail.id, { revision: 1 });
    const { get } = await signedIn({ render: approved });
    const page = parseHtml((await get(renderPath + '?notice=approved')).body);
    const notice = byTag(page, 'div').find((node) => node.attrs['data-notice'] === 'success');
    expect(notice?.attrs['role']).toBe('status');
    expect(textOf(notice as never)).toContain('Export is enabled');
    expect(byId(page, 'quality-approved')).toBeDefined();
  });
});

describe('POST /videos/:id/render/approve — the final-approval gate', () => {
  it('records the approval, redirects to the notice and makes export available', async () => {
    const renders = gateway();
    const { post, get } = await signedIn({ render: renders });
    const response = await post(renderPath + '/approve', 'revision=1');
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe(renderPath + '?notice=approved');
    expect(renders.calls.approve).toEqual([{ videoId: detail.id, revision: 1, note: null }]);

    const page = parseHtml((await get(renderPath)).body);
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('approved');
    const approved = textOf(byId(page, 'quality-approved') as never);
    expect(approved).toContain('Final approval recorded 2026-10-20T09:41:12Z.');
    expect(approved).toContain('Export is enabled; nothing else changed.');
    const exportLink = byTag(page, 'a').find((node) =>
      (node.attrs['href'] ?? '').endsWith('/export'),
    );
    expect(exportLink?.attrs['href']).toBe('/videos/' + detail.id + '/export');
    expect(byTag(page, 'form')).toHaveLength(0);
  });

  it('carries the operator note to the contract request', async () => {
    const renders = gateway();
    const { post } = await signedIn({ render: renders });
    await post(renderPath + '/approve', 'revision=1&note=checked%20the%20captions');
    expect(renders.calls.approve).toEqual([
      { videoId: detail.id, revision: 1, note: 'checked the captions' },
    ]);
  });

  it('refuses a post with no revision instead of guessing one', async () => {
    const renders = gateway();
    const { post } = await signedIn({ render: renders });
    const response = await post(renderPath + '/approve', '');
    expect(response.status).toBe(422);
    expect(renders.calls.approve).toHaveLength(0);
    const notice = byTag(parseHtml(response.body), 'div').find(
      (node) => node.attrs['data-notice'] === 'error',
    );
    expect(textOf(notice as never)).toContain('did not carry the revision');
  });

  it('refuses a stale page revision and sends nothing', async () => {
    const renders = gateway();
    const { post } = await signedIn({ render: renders });
    await renders.approve(detail.id, { revision: 1 });
    const response = await post(renderPath + '/approve', 'revision=1');
    expect(response.status).toBe(409);
    expect(renders.calls.approve).toHaveLength(1);
    expect(textOf(parseHtml(response.body))).toContain('already approved');
  });

  it('refuses approval while QC fails and names the failing check', async () => {
    const renders = gateway({
      qc: {
        ...fixture.qc,
        status: 'fail',
        checks: fixture.qc.checks.map((check) =>
          check.requirement === 'R-010-6' ? { ...check, pass: false, measured: '94.2 %' } : check,
        ),
      },
    });
    const { post } = await signedIn({ render: renders });
    const response = await post(renderPath + '/approve', 'revision=1');
    expect(response.status).toBe(409);
    expect(renders.calls.approve).toHaveLength(0);
    const page = parseHtml(response.body);
    expect(textOf(byId(page, 'quality-approval-reason') as never)).toContain('QC-6');
    const notice = byTag(page, 'div').find((node) => node.attrs['data-notice'] === 'error');
    expect(textOf(notice as never)).toContain('Nothing was approved');
  });

  it('refuses approval when a check has not reported (never treats a gap as a pass)', async () => {
    const renders = gateway({
      qc: {
        ...fixture.qc,
        checks: fixture.qc.checks.filter((check) => check.requirement !== 'R-010-3'),
      },
    });
    const { post } = await signedIn({ render: renders });
    const response = await post(renderPath + '/approve', 'revision=1');
    expect(response.status).toBe(409);
    expect(renders.calls.approve).toHaveLength(0);
    expect(textOf(parseHtml(response.body))).toContain('R-010-3');
  });

  it('rejects a note longer than the contract allows', async () => {
    const renders = gateway();
    const { post } = await signedIn({ render: renders });
    const response = await post(renderPath + '/approve', 'revision=1&note=' + 'x'.repeat(2001));
    expect(response.status).toBe(400);
    expect(renders.calls.approve).toHaveLength(0);
  });

  it('answers 503, approving nothing, when the render surface is not mounted', async () => {
    const { post } = await signedIn();
    const response = await post(renderPath + '/approve', 'revision=1');
    expect(response.status).toBe(503);
  });

  it('keeps the gate copy the operator is agreeing to above the button', async () => {
    const { get } = await signedIn({ render: gateway() });
    const page = parseHtml((await get(renderPath)).body);
    expect(textOf(byId(page, 'quality-gate-line') as never)).toBe(APPROVAL_GATE_LINE);
    const button = byId(page, 'quality-approve-button') as never;
    expect(textOf(button)).toBe('Approve final');
  });
});

describe('routing edges', () => {
  it('404s an unknown render action and 405s a commit on another tab', async () => {
    const { get, post } = await signedIn({ render: gateway() });
    expect((await get(renderPath + '/delete')).status).toBe(404);
    expect((await get(renderPath + '/approve')).status).toBe(404);
    expect((await post('/videos/' + detail.id + '/audio', '')).status).toBe(405);
    expect((await post(renderPath + '/approve/extra', 'revision=1')).status).toBe(404);
  });
});

describe('createMemoryRenderGateway', () => {
  it('exposes the revision the approve request needs and stamps the approval', async () => {
    const renders = createMemoryRenderGateway({
      videoId: detail.id,
      view: renderView(),
      revision: 4,
      now: () => NOW,
    });
    expect(await renders.revision(detail.id)).toBe(4);
    const approved = await renders.approve(detail.id, { revision: 4 });
    expect(approved.approved).toBe(true);
    expect(approved.approved_at).toBe('2026-10-20T09:41:12.000Z');
    expect(renders.current()?.approved).toBe(true);
  });

  it('refuses a second approval and a stale revision with named refusals', async () => {
    const renders = createMemoryRenderGateway({
      videoId: detail.id,
      view: renderView(),
      revision: 2,
      now: () => NOW,
    });
    await expect(renders.approve(detail.id, { revision: 1 })).rejects.toBeInstanceOf(
      RenderRefusedError,
    );
    await renders.approve(detail.id, { revision: 2 });
    await expect(renders.approve(detail.id, { revision: 2 })).rejects.toThrow('already approved');
  });

  it('never approves a failing or unreported QC run', async () => {
    const failing = createMemoryRenderGateway({
      videoId: detail.id,
      view: renderView({ qc: { ...fixture.qc, status: 'fail' } }),
      revision: 1,
    });
    await expect(failing.approve(detail.id, { revision: 1 })).rejects.toThrow('QC');

    const unknown = createMemoryRenderGateway({
      videoId: detail.id,
      view: renderView({
        qc: { ...fixture.qc, checks: fixture.qc.checks.slice(0, 5) },
      }),
      revision: 1,
    });
    await expect(unknown.approve(detail.id, { revision: 1 })).rejects.toThrow('R-010-7');
  });

  it('returns null for another video id', async () => {
    const renders = createMemoryRenderGateway({
      videoId: detail.id,
      view: renderView(),
      revision: 1,
    });
    expect(await renders.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
