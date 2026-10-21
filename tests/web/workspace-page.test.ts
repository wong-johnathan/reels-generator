import { describe, expect, it } from 'vitest';

import { HealthReportSchema, OverviewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byTag, parseHtml, textOf, type HtmlNode } from './helpers/html.js';

/**
 * S-09…S-16 shell route behaviour (UI_SPEC §6.5 W-04, IP-03) over the real
 * request handler. The gateway is in memory: no socket, no database, no
 * provider — this proves the route, the shell wiring and the a11y structure.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

function app(overrides: Partial<WebAppDependencies> = {}) {
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
  return { handle };
}

async function signedIn(overrides: Partial<WebAppDependencies> = {}) {
  const { handle } = app(overrides);
  const response = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  const cookie = (response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  const get = async (path: string) =>
    handle({ method: 'GET', url: path, headers: { cookie } } as WebRequest);
  return { handle, get };
}

const workspace = (page: HtmlNode): HtmlNode => {
  const found = byTag(page, 'div').find((node) => node.attrs['data-workspace'] !== undefined);
  if (found === undefined) throw new Error('no workspace root');
  return found;
};

describe('GET /videos/:id — the workspace shell', () => {
  it('renders the rail, the header chip, the tabs and the pins footer', async () => {
    const { get } = await signedIn();
    const response = await get('/videos/' + detail.id);
    expect(response.status).toBe(200);

    const page = parseHtml(response.body);
    const root = workspace(page);
    expect(root.attrs['data-video-id']).toBe(detail.id);

    const rail = byTag(page, 'li').filter((node) => node.attrs['data-stage'] !== undefined);
    expect(rail).toHaveLength(11);

    const chip = page.children.length > 0 ? findById(page, 'video-chip') : undefined;
    expect(chip?.attrs['data-size']).toBe('lg');
    expect(chip?.attrs['data-state']).toBe('awaiting_approval');
    expect(textOf(chip as HtmlNode)).toBe('Awaiting approval');

    const tabs = byTag(page, 'a').filter((node) => node.attrs['role'] === 'tab');
    expect(tabs.map((tab) => textOf(tab).replace(/\s*\(.*\)$/, ''))).toEqual([
      'Topic',
      'Script',
      'Storyboard',
      'Scenes',
      'Audio',
      'Render',
      'Export',
    ]);
    // current_stage is FA, whose gate lives on the Render tab (IP-03).
    expect(tabs.filter((tab) => tab.attrs['aria-selected'] === 'true')).toHaveLength(1);
    expect(tabs.find((tab) => tab.attrs['aria-selected'] === 'true')?.attrs['id']).toBe(
      'workspace-tab-render',
    );

    const footer = byTag(page, 'footer')[0];
    expect(textOf(footer as HtmlNode)).toContain('pins: v3 ×4 · v2 ×3');
    expect(textOf(footer as HtmlNode)).toContain('target 75 s');
    expect(textOf(footer as HtmlNode)).toContain('17 scenes');

    const scripts = byTag(page, 'script').map((node) => node.attrs['src']);
    expect(scripts).toContain('/assets/client/shell.js');
    expect(scripts).toContain('/assets/client/workspace.js');
  });

  it('opens the named tab from the URL and labels the panel for it', async () => {
    const { get } = await signedIn();
    const response = await get('/videos/' + detail.id + '/script');
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);
    const selected = byTag(page, 'a').find(
      (node) => node.attrs['role'] === 'tab' && node.attrs['aria-selected'] === 'true',
    );
    expect(selected?.attrs['id']).toBe('workspace-tab-script');
    const panel = byTag(page, 'section').find((node) => node.attrs['role'] === 'tabpanel');
    expect(panel?.attrs['aria-labelledby']).toBe('workspace-tab-script');
    expect(textOf(panel as HtmlNode)).toContain('Script');
    // The script stage's own data, not a placeholder.
    expect(textOf(panel as HtmlNode)).toContain('approved by operator');
  });

  it('keeps every tab reachable: a blocked or not-run tab still renders its state', async () => {
    const { get } = await signedIn();
    const page = parseHtml((await get('/videos/' + detail.id + '/export')).body);
    const panel = byTag(page, 'section').find((node) => node.attrs['role'] === 'tabpanel');
    expect(textOf(panel as HtmlNode)).toContain('Blocked');
    expect(textOf(panel as HtmlNode)).toContain('final approval required');
  });

  it('explains the first-three checkpoint block on the images tab (R-005-2)', async () => {
    const clone = structuredClone(detail) as VideoDetail;
    const blockedIm = clone.stages.map((stage) =>
      stage.stage === 'IM'
        ? { ...stage, state: 'blocked' as const, blocked_reason: 'script not approved (R-005-2)' }
        : stage,
    );
    const blocked = VideoDetailSchema.parse({ ...clone, stages: blockedIm });
    const { get } = await signedIn({ video: createMemoryVideoGateway([blocked]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/scenes')).body);
    expect(textOf(page)).toContain('script not approved (R-005-2)');
  });
});

describe('the workspace route guards its input', () => {
  it('404s an unknown video inside the app chrome', async () => {
    const { get } = await signedIn();
    const response = await get('/videos/not-a-video');
    expect(response.status).toBe(404);
    expect(response.body).toContain('Go to Overview');
  });

  it('404s an unknown tab instead of rendering the default one', async () => {
    const { get } = await signedIn();
    expect((await get('/videos/' + detail.id + '/nope')).status).toBe(404);
    expect((await get('/videos/' + detail.id + '/script/extra')).status).toBe(404);
    expect((await get('/videos/')).status).toBe(404);
  });

  it('503s, never invents a workspace, when no video store is mounted', async () => {
    const { get } = await signedIn({ video: undefined });
    const response = await get('/videos/' + detail.id);
    expect(response.status).toBe(503);
    expect(response.body).toContain('not mounted');
  });

  it('requires a session before it renders a video', async () => {
    const { handle } = app();
    const response = await handle({ method: 'GET', url: '/videos/' + detail.id });
    expect(response.status).toBe(303);
    expect(response.headers['location']).toContain('/login');
  });
});

describe('the page can reach its enhancer modules, and only those', () => {
  it('serves the workspace enhancer graph and refuses anything else', async () => {
    const reader =
      (kind: string) =>
      (value: string): string =>
        'export const ' + kind + ' = ' + JSON.stringify(value) + ';';
    const { get } = await signedIn({
      assets: {
        readClientModule: reader('client'),
        readSharedModule: (path) =>
          [
            'format.js',
            'workspace/events.js',
            'workspace/glyphs.js',
            'shared/stages.js',
            'shared/states.js',
          ].includes(path)
            ? reader('shared')(path)
            : null,
      },
    });
    for (const path of [
      '/assets/client/workspace.js',
      '/assets/workspace/events.js',
      '/assets/workspace/glyphs.js',
      '/assets/shared/stages.js',
      '/assets/shared/states.js',
      '/assets/format.js',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers['content-type'], path).toContain('javascript');
    }
    expect((await get('/assets/workspace/../secrets.js')).status).toBe(404);
    expect((await get('/assets/shared/nope.js')).status).toBe(404);
    expect((await get('/assets/workspace/events')).status).toBe(404);
  });

  it('allows the same-origin SSE connection in its CSP, and nothing else', async () => {
    const { get } = await signedIn();
    const csp = (await get('/videos/' + detail.id)).headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('connect-src *');
  });
});

function findById(page: HtmlNode, id: string): HtmlNode | undefined {
  const walk = (node: HtmlNode): HtmlNode | undefined => {
    if (node.type === 'element' && node.attrs['id'] === id) return node;
    for (const child of node.children) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(page);
}
