import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  provisionAuth,
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  TEST_TTL_SECONDS,
  TEST_USERNAME,
  type AuthFixture,
} from '../../tests/helpers/auth.js';
import { SKIP_REASON, testDatabaseUrl } from '../../tests/helpers/pg.js';
import { deriveCsrfToken, hashSessionToken } from './tokens.js';

/**
 * B-13: the login/logout/authenticate service against the real stores.
 * R-015-2 (cookie value hashed at rest), R-015-3 (no reset path), R-015-6
 * (auth is the default) and the TECH_DESIGN §10 login backoff.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[auth service tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('AuthService', () => {
  let fixture: AuthFixture;

  beforeAll(async () => {
    fixture = await provisionAuth();
  });

  afterAll(async () => {
    await fixture.close();
  });

  async function sessionCount(): Promise<number> {
    const result = await fixture.pool.query('SELECT count(*)::int AS n FROM session');
    return result.rows[0]!.n as number;
  }

  it('logs in the seeded operator and persists only the token hash', async () => {
    fixture.clock.set('2026-10-21T00:00:00.000Z');
    const result = await fixture.service.login({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      clientKey: '127.0.0.1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('login failed');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session.username).toBe(TEST_USERNAME);
    expect(result.session.csrfToken).toBe(
      deriveCsrfToken(TEST_SESSION_SECRET, hashSessionToken(result.token)),
    );
    expect(result.session.expiresAt.toISOString()).toBe(
      new Date(Date.parse('2026-10-21T00:00:00.000Z') + TEST_TTL_SECONDS * 1000).toISOString(),
    );

    const row = await fixture.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM session WHERE operator_id = $1 ORDER BY created_at DESC LIMIT 1',
      [fixture.operatorId],
    );
    expect(row.rows[0]!.token_hash).toBe(hashSessionToken(result.token));
    expect(JSON.stringify(result)).not.toContain(TEST_PASSWORD);
  });

  it('rejects a wrong password and an unknown username with the same outcome', async () => {
    const before = await sessionCount();
    await expect(
      fixture.service.login({
        username: TEST_USERNAME,
        password: 'wrong-password-123',
        clientKey: 'ip-a',
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    await expect(
      fixture.service.login({ username: 'nobody', password: TEST_PASSWORD, clientKey: 'ip-b' }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(await sessionCount()).toBe(before);
  });

  it('applies exponential backoff per attempt key and clears it on success', async () => {
    fixture.clock.set('2026-10-21T00:00:00.000Z');
    const key = { username: TEST_USERNAME, clientKey: '10.0.0.9' };
    await expect(
      fixture.service.login({ ...key, password: 'wrong-password-123' }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });

    const blocked = await fixture.service.login({ ...key, password: 'wrong-password-123' });
    expect(blocked).toEqual({ ok: false, reason: 'rate_limited', retryAfterS: 1 });

    fixture.clock.advance(1_000);
    await expect(
      fixture.service.login({ ...key, password: 'wrong-password-123' }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(fixture.backoff.check(`login:10.0.0.9:${TEST_USERNAME}`)).toEqual({
      allowed: false,
      retryAfterS: 4,
    });

    fixture.clock.advance(4_000);
    const ok = await fixture.service.login({ ...key, password: TEST_PASSWORD });
    expect(ok.ok).toBe(true);
    expect(fixture.backoff.check(`login:10.0.0.9:${TEST_USERNAME}`)).toEqual({
      allowed: true,
      retryAfterS: 0,
    });
  });

  it('authenticates a live token and refuses unknown, empty or expired ones', async () => {
    fixture.clock.set('2026-10-21T00:00:00.000Z');
    const login = await fixture.service.login({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      clientKey: 'ip-c',
    });
    if (!login.ok) throw new Error('login failed');

    const session = await fixture.service.authenticate(login.token);
    expect(session?.username).toBe(TEST_USERNAME);
    expect(session?.operatorId).toBe(fixture.operatorId);
    expect(session?.csrfToken).toBe(login.session.csrfToken);
    expect(await fixture.service.authenticate('not-a-real-token')).toBeNull();
    expect(await fixture.service.authenticate('')).toBeNull();

    fixture.clock.advance((TEST_TTL_SECONDS + 1) * 1000);
    expect(await fixture.service.authenticate(login.token)).toBeNull();
  });

  it('logout destroys the session and is idempotent', async () => {
    fixture.clock.set('2026-10-21T00:00:00.000Z');
    const login = await fixture.service.login({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      clientKey: 'ip-d',
    });
    if (!login.ok) throw new Error('login failed');
    expect(await fixture.service.authenticate(login.token)).not.toBeNull();

    await fixture.service.logout(login.token);
    expect(await fixture.service.authenticate(login.token)).toBeNull();
    await expect(fixture.service.logout(login.token)).resolves.toBeUndefined();
    await expect(fixture.service.logout('never-issued')).resolves.toBeUndefined();
  });

  it('mints a distinct session and CSRF token per login', async () => {
    fixture.clock.set('2026-10-21T00:00:00.000Z');
    const first = await fixture.service.login({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      clientKey: 'ip-e',
    });
    const second = await fixture.service.login({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      clientKey: 'ip-f',
    });
    if (!first.ok || !second.ok) throw new Error('login failed');
    expect(first.token).not.toBe(second.token);
    expect(first.session.csrfToken).not.toBe(second.session.csrfToken);
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
  });
});
