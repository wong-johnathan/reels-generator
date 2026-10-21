import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  provisionAuth,
  TEST_PASSWORD,
  TEST_USERNAME,
  type AuthFixture,
} from '../../tests/helpers/auth.js';
import { SKIP_REASON, testDatabaseUrl } from '../../tests/helpers/pg.js';
import {
  OperatorMismatchError,
  seedOperator,
  seedOperatorFromEnv,
  SeedEnvError,
} from './operator.js';
import { isArgon2idHash, PasswordPolicyError, verifyPassword } from './password.js';

/**
 * B-13 / R-015-1, R-015-3, R-015-6: one seeded operator, argon2id hash, and no
 * registration or reset path. "No reset path" is enforced structurally here:
 * seeding an existing operator never rewrites the hash.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[operator seeder tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('operator seeding (R-015-1, R-015-3)', () => {
  let fixture: AuthFixture;

  beforeAll(async () => {
    fixture = await provisionAuth();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('stores exactly one operator with a verifiable argon2id hash', async () => {
    const rows = await fixture.pool.query<{ id: string; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM operator',
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0]!;
    expect(row.username).toBe(TEST_USERNAME);
    expect(row.id).toBe(fixture.operatorId);
    expect(isArgon2idHash(row.password_hash)).toBe(true);
    await expect(verifyPassword(TEST_PASSWORD, row.password_hash)).resolves.toBe(true);
  });

  it('is idempotent and never rewrites the hash (no reset path, R-015-3)', async () => {
    const before = await fixture.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM operator WHERE id = $1',
      [fixture.operatorId],
    );

    const again = await seedOperator(fixture.pool, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    expect(again).toEqual({
      created: false,
      operatorId: fixture.operatorId,
      username: TEST_USERNAME,
    });

    const rotated = await seedOperator(fixture.pool, {
      username: TEST_USERNAME,
      password: 'a-completely-different-password',
    });
    expect(rotated.created).toBe(false);

    const after = await fixture.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM operator WHERE id = $1',
      [fixture.operatorId],
    );
    expect(after.rows[0]!.password_hash).toBe(before.rows[0]!.password_hash);
    await expect(verifyPassword(TEST_PASSWORD, after.rows[0]!.password_hash)).resolves.toBe(true);
    await expect(
      verifyPassword('a-completely-different-password', after.rows[0]!.password_hash),
    ).resolves.toBe(false);
  });

  it('refuses to seed a different username without touching the existing row', async () => {
    await expect(
      seedOperator(fixture.pool, { username: 'intruder', password: 'another-password-123' }),
    ).rejects.toBeInstanceOf(OperatorMismatchError);

    const rows = await fixture.pool.query<{ username: string }>('SELECT username FROM operator');
    expect(rows.rows).toEqual([{ username: TEST_USERNAME }]);
  });

  it('the database itself refuses a second operator row (D3 single operator)', async () => {
    await expect(
      fixture.pool.query('INSERT INTO operator (username, password_hash) VALUES ($1, $2)', [
        'second',
        'not-a-hash',
      ]),
    ).rejects.toThrow(/operator_single_row|duplicate key/);
  });

  it('refuses a password below the 12-character policy before touching the database', async () => {
    await expect(
      seedOperator(fixture.pool, { username: 'someone', password: 'short' }),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
    const rows = await fixture.pool.query<{ username: string }>('SELECT username FROM operator');
    expect(rows.rows).toEqual([{ username: TEST_USERNAME }]);
  });

  it('seeds from OPERATOR_* env and names every missing key without echoing values', async () => {
    const env = {
      OPERATOR_USERNAME: 'owner',
      OPERATOR_PASSWORD: TEST_PASSWORD,
    };
    const missing = await seedOperatorFromEnv({}, fixture.pool).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SeedEnvError);
    const message = (missing as Error).message;
    expect(message).toContain('OPERATOR_USERNAME');
    expect(message).toContain('OPERATOR_PASSWORD');
    expect(message).not.toContain(TEST_PASSWORD);

    const result = await seedOperatorFromEnv(env, fixture.pool);
    expect(result).toEqual({
      created: false,
      operatorId: fixture.operatorId,
      username: TEST_USERNAME,
    });
  });
});
