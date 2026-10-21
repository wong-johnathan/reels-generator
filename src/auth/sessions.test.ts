import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionAuth, type AuthFixture } from '../../tests/helpers/auth.js';
import { SKIP_REASON, testDatabaseUrl } from '../../tests/helpers/pg.js';
import { hashSessionToken, newSessionToken } from './tokens.js';

/**
 * B-13 / R-015-2: the session cookie is httpOnly and the server stores only the
 * hash of its value (TECH_DESIGN §3.2 `session.token_hash`). These tests read the
 * row back and assert the raw token is nowhere in it.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[session store tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('Postgres session store (R-015-2)', () => {
  let fixture: AuthFixture;

  beforeAll(async () => {
    fixture = await provisionAuth();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('stores the sha256 of the token, never the token', async () => {
    const token = newSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 60_000);
    const created = await fixture.sessions.create({
      operatorId: fixture.operatorId,
      tokenHash,
      expiresAt,
    });

    const row = await fixture.pool.query('SELECT * FROM session WHERE id = $1', [created.id]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.token_hash).toBe(tokenHash);
    expect(JSON.stringify(row.rows[0])).not.toContain(token);
  });

  it('finds a live session and joins the operator username', async () => {
    const token = newSessionToken();
    const created = await fixture.sessions.create({
      operatorId: fixture.operatorId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const found = await fixture.sessions.findByTokenHash(hashSessionToken(token), new Date());
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.username).toBe('owner');
    expect(found!.operatorId).toBe(fixture.operatorId);
    expect(found!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('never returns an expired session, and purges it by expiry', async () => {
    const expiredToken = newSessionToken();
    const expired = await fixture.sessions.create({
      operatorId: fixture.operatorId,
      tokenHash: hashSessionToken(expiredToken),
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(
      await fixture.sessions.findByTokenHash(hashSessionToken(expiredToken), new Date()),
    ).toBeNull();

    const purged = await fixture.sessions.deleteExpired(new Date());
    expect(purged).toBeGreaterThanOrEqual(1);
    const rows = await fixture.pool.query('SELECT id FROM session WHERE id = $1', [expired.id]);
    expect(rows.rowCount).toBe(0);
  });

  it('deletes one session by id and leaves the others alone', async () => {
    const keepToken = newSessionToken();
    const keep = await fixture.sessions.create({
      operatorId: fixture.operatorId,
      tokenHash: hashSessionToken(keepToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const dropToken = newSessionToken();
    const drop = await fixture.sessions.create({
      operatorId: fixture.operatorId,
      tokenHash: hashSessionToken(dropToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await fixture.sessions.deleteById(drop.id);
    expect(
      await fixture.sessions.findByTokenHash(hashSessionToken(dropToken), new Date()),
    ).toBeNull();
    expect(
      await fixture.sessions.findByTokenHash(hashSessionToken(keepToken), new Date()),
    ).not.toBeNull();
    await fixture.sessions.deleteById(keep.id);
  });

  it('refuses a duplicate token hash (a token identifies exactly one session)', async () => {
    const tokenHash = hashSessionToken(newSessionToken());
    await fixture.sessions.create({
      operatorId: fixture.operatorId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      fixture.sessions.create({
        operatorId: fixture.operatorId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/duplicate key/);
  });
});
