import { describe, expect, it } from 'vitest';

import { NarrationViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createAuthPreviewHandler } from '../../src/web/authPreview.js';

/**
 * The F-02 preview mounts the production-shaped handler with an in-memory
 * store and a deterministic fake sign-in. This is the surface used for the
 * browser evidence; no socket is bound here and nothing leaves the process.
 */

const NOW = Date.parse('2026-10-20T09:41:12.000Z');
const handle = createAuthPreviewHandler({ now: () => NOW });

const login = (
  password: string,
  cookie?: string,
): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: string }> =>
  handle({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams({ username: 'operator', password }).toString(),
  });

describe('auth preview', () => {
  it('starts on the login page and protects the overview', async () => {
    const overview = await handle({ method: 'GET', url: '/' });
    expect(overview.status).toBe(303);
    expect(overview.headers['location']).toBe('/login?required=1');
    const page = await handle({ method: 'GET', url: '/login?required=1' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Sign in to continue.');
  });

  it('signs in with the deterministic fake and then serves the shell', async () => {
    const response = await login('preview');
    expect(response.status).toBe(303);
    const cookie = response.headers['set-cookie']!.split(';')[0]!;
    const overview = await handle({ method: 'GET', url: '/', headers: { cookie } });
    expect(overview.status).toBe(200);
    expect(overview.body).toContain('operator');
  });

  it('rejects the wrong fake password with the spec copy', async () => {
    const response = await login('nope');
    expect(response.status).toBe(401);
    expect(response.body).toContain('Wrong username or password');
  });

  it('serves the transpiled login module as browser ESM', async () => {
    const response = await handle({ method: 'GET', url: '/assets/client/login.js' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toContain('initLogin');
    expect(response.body).not.toContain('interface ');
  });
});

describe('S-14 narration preview (US-021, US-022)', () => {
  const video = VideoDetailSchema.parse(FIXTURES['video.get']);
  const narration = NarrationViewSchema.parse(FIXTURES['audio.get']);
  const audioPath = '/videos/' + video.id + '/audio';

  async function cookie(): Promise<string> {
    const response = await login('preview');
    return response.headers['set-cookie']!.split(';')[0]!;
  }

  it('renders the audio tab with the fixture take and the accept gap', async () => {
    const session = await cookie();
    const response = await handle({ method: 'GET', url: audioPath, headers: { cookie: session } });
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-narration');
    expect(response.body).toContain('data-state="ready"');
    expect(response.body).toContain('src="' + (narration.asset?.urls.full ?? '') + '"');
    expect(response.body).toContain('data-accept="unwired"');
    expect(response.body).not.toContain('Timing accepted');
    expect(response.headers['content-security-policy']).toContain("media-src 'self'");
  });

  it('serves the narration asset as a real WAV so playback can be exercised', async () => {
    const session = await cookie();
    const response = await handle({
      method: 'GET',
      url: narration.asset?.urls.full ?? '/asset/none/full',
      headers: { cookie: session },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('audio/wav');
    expect(response.body.slice(0, 4)).toBe('RIFF');
    expect(response.body.slice(8, 12)).toBe('WAVE');
    // 8 kHz mono 16-bit at the fixture duration, within one sample frame.
    const expected = 44 + Math.round((narration.duration_s ?? 0) * 8000) * 2;
    expect(response.body.length).toBe(expected);
  });

  it('serves the enhancer and its shared model', async () => {
    const session = await cookie();
    const client = await handle({
      method: 'GET',
      url: '/assets/client/narration.js',
      headers: { cookie: session },
    });
    expect(client.status).toBe(200);
    expect(client.body).toContain('initNarration');
    const shared = await handle({
      method: 'GET',
      url: '/assets/narration/model.js',
      headers: { cookie: session },
    });
    expect(shared.status).toBe(200);
    expect(shared.body).toContain('formatTransportTime');
  });

  it('guards the audio asset and honours byte ranges so the player can seek', async () => {
    const anonymous = await handle({
      method: 'GET',
      url: narration.asset?.urls.full ?? '/asset/none/full',
      headers: {},
    });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.location).toBe('/login?required=1');

    const session = await cookie();
    const response = await handle({
      method: 'GET',
      url: narration.asset?.urls.full ?? '/asset/none/full',
      headers: { cookie: session, range: 'bytes=100-199' },
    });
    expect(response.status).toBe(206);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toBe(
      'bytes 100-199/' + String(44 + Math.round((narration.duration_s ?? 0) * 8000) * 2),
    );
    expect(response.headers['content-length']).toBe('100');
    expect(response.body.length).toBe(100);
  });

  it('clamps an open-ended range to the end of the take', async () => {
    const session = await cookie();
    const total = 44 + Math.round((narration.duration_s ?? 0) * 8000) * 2;
    const response = await handle({
      method: 'GET',
      url: narration.asset?.urls.full ?? '/asset/none/full',
      headers: { cookie: session, range: 'bytes=' + String(total - 32) + '-' },
    });
    expect(response.status).toBe(206);
    expect(response.body.length).toBe(32);
    expect(response.headers['content-range']).toBe(
      'bytes ' + String(total - 32) + '-' + String(total - 1) + '/' + String(total),
    );
  });
});
