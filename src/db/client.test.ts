import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import {
  DatabaseConfigError,
  describeTarget,
  poolConfigFromEnv,
  withTransaction,
} from './client.js';
import { runMigrations } from './runner.js';

/**
 * Connection-configuration contract (TECH_DESIGN §9.6) and the transaction
 * helper the write paths depend on. The config tests need no server; the
 * rollback test does, so it lives in the DB-gated suite.
 */
describe('poolConfigFromEnv', () => {
  const complete = {
    POSTGRES_HOST: 'postgres',
    POSTGRES_PORT: '5432',
    POSTGRES_DB: 'reels',
    POSTGRES_USER: 'reels',
    POSTGRES_PASSWORD: 'a-secret-value',
  } satisfies NodeJS.ProcessEnv;

  it('maps the documented POSTGRES_* keys onto the pool options', () => {
    const config = poolConfigFromEnv(complete);
    expect(config).toMatchObject({
      host: 'postgres',
      port: 5432,
      database: 'reels',
      user: 'reels',
      password: 'a-secret-value',
      application_name: 'reels-generator',
      max: 10,
    });
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('defaults the port and an absent password without inventing anything else', () => {
    const config = poolConfigFromEnv({
      POSTGRES_HOST: 'postgres',
      POSTGRES_DB: 'reels',
      POSTGRES_USER: 'reels',
    });
    expect(config.port).toBe(5432);
    expect(config.password).toBe('');
  });

  it('names every incomplete key instead of failing on the first one', () => {
    expect(() => poolConfigFromEnv({})).toThrow(DatabaseConfigError);
    try {
      poolConfigFromEnv({});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('POSTGRES_HOST');
      expect(message).toContain('POSTGRES_DB');
      expect(message).toContain('POSTGRES_USER');
    }
  });

  it('rejects a port outside 1-65535', () => {
    expect(() => poolConfigFromEnv({ ...complete, POSTGRES_PORT: '70000' })).toThrow(
      DatabaseConfigError,
    );
    expect(() => poolConfigFromEnv({ ...complete, POSTGRES_PORT: 'not-a-number' })).toThrow(
      DatabaseConfigError,
    );
  });

  it('describes the target without the password, for logs', () => {
    const described = describeTarget(poolConfigFromEnv(complete));
    expect(described).toBe('postgres:5432/reels');
    expect(described).not.toContain('a-secret-value');
  });
});

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[transaction tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('withTransaction', { timeout: 120_000 }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  }, 120_000);

  it('rolls back every write when the callback throws', async () => {
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query(
          `INSERT INTO operator (username, password_hash) VALUES ('owner', 'hash')`,
        );
        // D3 allows exactly one operator row, so this insert must fail …
        await client.query(
          `INSERT INTO operator (username, password_hash) VALUES ('other', 'hash')`,
        );
      }),
    ).rejects.toThrow(/operator/);

    // … and the first insert must have been rolled back with it.
    const operators = await db.pool.query(`SELECT id FROM operator`);
    expect(operators.rowCount).toBe(0);
  });

  it('commits and returns the callback value', async () => {
    const username = await withTransaction(db.pool, async (client) => {
      const row = await client.query<{ username: string }>(
        `INSERT INTO operator (username, password_hash) VALUES ('owner', 'hash') RETURNING username`,
      );
      return row.rows[0]!.username;
    });

    expect(username).toBe('owner');
    const operators = await db.pool.query(`SELECT id FROM operator`);
    expect(operators.rowCount).toBe(1);
  });
});
