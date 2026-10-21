import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  OverviewSchema,
  ScriptViewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { createMemoryScriptGateway } from '../../src/web/script/gateway.js';
import { createMemoryVideoGateway } from '../../src/web/workspace/gateway.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byTag, parseHtml, textOf, type HtmlNode } from './helpers/html.js';

/**
 * S-10 — script review, claims and the approval gate (UI_SPEC §6.6 W-05,
 * R-005-2, R-003-2, R-027-3), rendered by the real request handler over an
 * in-memory gateway. No provider, no socket, no database.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);
const approved = ScriptViewSchema.parse(FIXTURES['script.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

const draft = ScriptViewSchema.parse({
  ...approved,
  revision: 5,
  status: 'draft',
  approved_at: null,
});

function unsourced(script: typeof approved) {
  const [first] = script.claims;
  if (first === undefined) throw new Error('fixture has no claims');
  return {
    ...script,
    claims: [
      { ...first, id: '22222222-2222-4222-8222-222222222222', status: 'unsourced', source: null },
      { ...first, id: '33333333-3333-4333-8333-333333333333', status: 'unsourced', source: null },
      { ...first, id: '44444444-4444-4444-8444-444444444444', status: 'sourced' },
    ],
  };
}

function blockedScript() {
  return ScriptViewSchema.parse(unsourced(draft));
}

function app(overrides: Partial<WebAppDependencies> = {}) {
  return createWebApp({
    sessions: new MemorySessionStore(),
    authenticate: ({ username, password }: { username: string; password: string }) =>
      username === 'operator' && password === 'preview-passphrase'
        ? { kind: 'authenticated', username }
        : { kind: 'rejected' },
    overview,
    health,
    now: () => NOW,
    video: createMemoryVideoGateway([detail as VideoDetail]),
    ...overrides,
  });
}

async function signedIn(overrides: Partial<WebAppDependencies> = {}) {
  const handle = app(overrides);
  const response = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  const cookie = (response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return async (path: string) => handle({ method: 'GET', url: path, headers: { cookie } });
}

function findById(node: HtmlNode, id: string): HtmlNode | undefined {
  if (node.attrs['id'] === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function scriptTab(page: HtmlNode): HtmlNode {
  const panel = findById(page, 'workspace-panel');
  const found = byTag(panel ?? page, 'section').find(
    (node) => node.attrs['data-script-review'] !== undefined,
  );
  if (found === undefined) throw new Error('no script review section');
  return found;
}

describe('GET /videos/:id/script — the S-10 surface', () => {
  it('renders the status bar, the word budget and the 8-gram result', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([approved]) });
    const response = await get('/videos/' + detail.id + '/script');
    expect(response.status).toBe(200);

    const page = parseHtml(response.body);
    const section = scriptTab(page);
    expect(section.attrs['data-script-revision']).toBe('4');
    expect(section.attrs['data-video-id']).toBe(detail.id);

    expect(textOf(findById(page, 'script-rev') as HtmlNode)).toContain('Script rev 4');
    expect(textOf(findById(page, 'script-budget-words') as HtmlNode)).toBe(
      '228 words → 75.1 s @ 3.035 w/s',
    );
    expect(textOf(findById(page, 'script-budget-band') as HtmlNode)).toBe(
      'band 216–239 words (71.2–78.7 s)',
    );

    const chip = findById(page, 'script-eight-gram');
    expect(chip?.attrs['data-state']).toBe('done');
    expect(textOf(chip as HtmlNode)).toContain('8-gram PASS');
    expect(textOf(findById(page, 'script-eight-gram-text') as HtmlNode)).toBe(
      '8-gram scan: PASS — no run of 8 or more words matches a stored reference.',
    );
  });

  it('renders labelled editor fields holding the current revision', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([approved]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    for (const field of ['hook', 'narration', 'ending', 'title', 'description', 'hashtags']) {
      const input = byTag(page, 'textarea')
        .concat(byTag(page, 'input'))
        .find((node) => node.attrs['data-field'] === field);
      expect(input, field).toBeDefined();
      const id = input?.attrs['id'] ?? '';
      expect(id.length).toBeGreaterThan(0);
      const label = byTag(page, 'label').find((node) => node.attrs['for'] === id);
      expect(label, field + ' label').toBeDefined();
    }
    const hook = byTag(page, 'textarea').find((node) => node.attrs['data-field'] === 'hook');
    expect(textOf(hook as HtmlNode)).toBe(approved.content.hook);
    const revisionField = byTag(page, 'input').find(
      (node) => node.attrs['data-revision-field'] !== undefined,
    );
    expect(revisionField?.attrs['value']).toBe('4');
  });

  it('renders the claim rows with their source status and the C-10 summary', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([approved]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    expect(textOf(findById(page, 'script-claims-summary') as HtmlNode)).toBe(
      'CLAIMS (2 factual · 1 sourced · 1 unsourced)',
    );
    const rows = byTag(page, 'tr').filter((node) => node.attrs['data-claim-status'] !== undefined);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.attrs['data-claim-status']).toBe('sourced');
    expect(textOf(rows[0] as HtmlNode)).toContain('example.org ok');
    expect(rows[1]?.attrs['data-claim-status']).toBe('unsourced');
    expect(textOf(rows[1] as HtmlNode)).toContain('-- !');
  });

  it('replaces the approve control with the record line once approved', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([approved]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    expect(findById(page, 'script-approve')?.attrs['hidden']).toBeDefined();
    expect(findById(page, 'script-approve')?.attrs['disabled']).toBeDefined();
    const record = findById(page, 'script-approved-record');
    expect(record?.attrs['hidden']).toBeUndefined();
    expect(textOf(record as HtmlNode)).toBe('Approved rev 4 · operator · 2026-10-20T09:41:12Z');
  });

  it('shows the change-impact panel collapsed to one line with no changes', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([approved]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    const impact = byTag(page, 'aside').find((node) => node.attrs['data-impact'] !== undefined);
    expect(impact).toBeDefined();
    expect(textOf(impact as HtmlNode)).toContain('Change impact');
    expect(textOf(findById(page, 'script-impact-message') as HtmlNode)).toBe('No unsaved changes');

    const apply = byTag(page, 'button').find((node) => node.attrs['data-commit'] === 'edit');
    const regenerate = byTag(page, 'button').find(
      (node) => node.attrs['data-commit'] === 'regenerate',
    );
    expect(apply).toBeDefined();
    expect(regenerate).toBeDefined();
    expect(apply?.attrs['disabled']).toBeDefined();
    expect(regenerate?.attrs['disabled']).toBeDefined();
    expect(apply?.attrs['type']).toBe('submit');
  });

  it('keeps the AX-02 DOM order: status, budget, editor, claims, approval, impact', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([approved]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);
    const section = scriptTab(page);

    const ids: string[] = [];
    const walk = (node: HtmlNode): void => {
      const id = node.attrs['id'];
      if (id !== undefined) ids.push(id);
      for (const child of node.children) walk(child);
    };
    walk(section);

    const at = (id: string): number => ids.indexOf(id);
    expect(at('script-rev')).toBeLessThan(at('script-budget-words'));
    expect(at('script-budget-words')).toBeLessThan(at('script-editor'));
    expect(at('script-editor')).toBeLessThan(at('script-claims'));
    expect(at('script-claims')).toBeLessThan(at('script-approval'));
    expect(at('script-approval')).toBeLessThan(at('script-impact'));
  });
});

describe('S-10 gate and empty states', () => {
  it('disables approval with the exact C-10 reason wired by aria-describedby', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([blockedScript()]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    const approve = findById(page, 'script-approve');
    expect(approve?.attrs['disabled']).toBeDefined();
    expect(approve?.attrs['aria-describedby']).toBe('script-approve-reason');
    expect(textOf(findById(page, 'script-approve-reason') as HtmlNode)).toBe(
      'Script approval is blocked: 2 of 3 factual claims have no resolvable source. Source, reword or acknowledge all 2 first.',
    );
    expect(approve?.attrs['aria-disabled']).toBe('true');
  });

  it('enables approval when the script is clean and states what it unlocks (C-09)', async () => {
    const clean = ScriptViewSchema.parse({
      ...draft,
      claims: [approved.claims[0]],
    });
    const get = await signedIn({ script: createMemoryScriptGateway([clean]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    const approve = findById(page, 'script-approve');
    expect(approve?.attrs['disabled']).toBeUndefined();
    expect(approve?.attrs['aria-describedby']).toBeUndefined();
    expect(textOf(findById(page, 'script-unlock') as HtmlNode)).toBe(
      'Approving the script unlocks 17 image calls and 1 TTS call for this video. Nothing runs until you approve.',
    );
  });

  it('shows the blocking reason and a link to the topic tab when there is no script', async () => {
    const get = await signedIn({ script: createMemoryScriptGateway([]) });
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);

    expect(findById(page, 'script-empty')).toBeDefined();
    expect(textOf(findById(page, 'script-empty') as HtmlNode)).toContain(
      'The script is blocked on topic approval.',
    );
    const link = byTag(page, 'a').find(
      (node) => node.attrs['href'] === '/videos/' + detail.id + '/topic',
    );
    expect(link).toBeDefined();
  });

  it('falls back to the F-04 stage summary when no script gateway is mounted', async () => {
    const get = await signedIn();
    const page = parseHtml((await get('/videos/' + detail.id + '/script')).body);
    expect(findById(page, 'script-empty')).toBeUndefined();
    expect(
      byTag(page, 'article').some((node) => node.attrs['data-stage-summary'] !== undefined),
    ).toBe(true);
  });
});
