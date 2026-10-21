import { describe, expect, it, vi } from 'vitest';

import { createPreviewHandler } from '../../src/web/preview.js';
import { parseHtml, textOf } from './helpers/html.js';

/**
 * F-01 preview: renders the shell against the frozen contract fixtures so the
 * signal line ("tokens + shell render against mock data") is reproducible with
 * zero live backend, zero database and zero network.
 */

const handle = createPreviewHandler({ now: Date.parse('2026-10-20T09:41:12.000Z') });
const get = (url: string): ReturnType<typeof handle> => handle({ method: 'GET', url });

describe('preview routes', () => {
  it('serves the shell at / as utf-8 HTML', () => {
    const response = get('/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(response.body).toContain('class="status-strip"');
    expect(response.body).toContain('class="rail"');
    expect(response.body).toContain('Content region placeholder');
  });

  it('serves the workspace layout variant with the aside and footer slots', () => {
    const response = get('/workspace');
    expect(response.status).toBe(200);
    expect(response.body).toContain('class="content-grid has-aside"');
    expect(response.body).toContain('class="workspace-footer"');
  });

  it('serves the series list and editor from the same demo gateway', () => {
    const list = get('/series');
    expect(list.status).toBe(200);
    expect(list.body).toContain('class="tbl series-table"');
    const editor = get('/series/11111111-1111-4111-8111-111111111111');
    expect(editor.status).toBe(200);
    expect(editor.body).toContain('Saving mints');
    const create = get('/series/new');
    expect(create.status).toBe(200);
    expect(textOf(parseHtml(create.body))).toContain('This creates the series and mints v1.');
  });

  it('serves the editor client module as browser ESM', () => {
    const response = get('/assets/client/series-editor.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toContain('initSeriesEditor');
    expect(response.body).not.toContain('interface ');
  });

  it('serves the scene grid enhancer as browser ESM beside its behaviours import', () => {
    const response = get('/assets/client/scene-grid.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toContain('initSceneGrid');
    expect(response.body).toContain("from './behaviours.js'");
    expect(response.body).not.toContain('interface ');
  });

  it('serves the token stylesheet with the measured hex values', () => {
    const response = get('/assets/app.css');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(response.body).toContain('--surface-panel: #15181e;');
    expect(response.body).toContain('--accent: #7ea6f8;');
    expect(response.body).toContain('prefers-reduced-motion');
  });

  it('serves the shell module as browser ESM with its imports rewritten to .js', () => {
    const response = get('/assets/client/shell.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toContain("from './behaviours.js'");
    expect(response.body).not.toContain('interface ');
    expect(response.body).not.toContain(': ShellDocument');
  });

  it('answers HEAD with the GET headers and no body', () => {
    const head = handle({ method: 'HEAD', url: '/' });
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(head.body).toBe('');
  });

  it('answers 404 for an unknown path and 405 for a non-GET method', () => {
    expect(get('/nope').status).toBe(404);
    const post = handle({ method: 'POST', url: '/' });
    expect(post.status).toBe(405);
    expect(cookieFree(post.body)).toContain('method_not_allowed');
  });
});

describe('preview security and determinism', () => {
  it('sets a restrictive content security policy with no inline script or style', () => {
    const headers = get('/').headers;
    expect(headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'self'",
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('renders the same bytes for the same request (fixtures are deterministic)', () => {
    expect(get('/').body).toBe(get('/').body);
  });

  it('never reaches the network while rendering', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('preview must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(get('/').status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function cookieFree(body: string): string {
  return body.replace(/\s+/g, ' ');
}
