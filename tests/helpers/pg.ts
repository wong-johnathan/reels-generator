/**
 * Throwaway-database helper for the schema tests.
 *
 * The migration set and the attempt-row guard are only meaningful against a
 * real Postgres: CHECK constraints, circular FKs, `pg_advisory_lock` and
 * commit visibility across sessions are the things under test. A stub or an
 * in-memory surrogate would assert nothing, so the tests provision a unique
 * database on `TEST_DATABASE_URL`.
 *
 * The database is deliberately *not* removed by the suite: the test user needs
 * CREATEDB for provisioning, but the suite never issues destructive statements.
 * CI runs against a service container that is discarded with the job; locally,
 * point `TEST_DATABASE_URL` at a scratch cluster (evidence/B-02.md records the
 * one used for this task's evidence run) and delete that cluster when done.
 *
 * `TEST_DATABASE_URL` must name a database containing `test` — a mistyped value
 * cannot provision next to a real database.
 */
import { randomBytes } from 'node:crypto';

import { Client, Pool } from 'pg';

export const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL';

/** The configured test server URL, or `null` when the suite must skip. */
export function testDatabaseUrl(): string | null {
  const url = process.env[TEST_DATABASE_URL_ENV];
  return url && url.length > 0 ? url : null;
}

/** Why the DB-backed tests skipped — printed by the suite so a skip is never silent. */
export const SKIP_REASON =
  `${TEST_DATABASE_URL_ENV} is not set: the schema tests need a throwaway Postgres 16 ` +
  'with pgcrypto + pgvector available (evidence/B-02.md records the evidence run)';

export interface TestDatabase {
  readonly url: string;
  readonly pool: Pool;
  /** Close every connection this helper opened. */
  close(): Promise<void>;
}

function databaseNameOf(url: string): string {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Create a uniquely named database on the test server and return a pool for it.
 * `template1` is copied, so the database arrives empty.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const baseUrl = testDatabaseUrl();
  if (!baseUrl) throw new Error(SKIP_REASON);

  const baseName = databaseNameOf(baseUrl);
  if (!baseName.includes('test')) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} names database "${baseName}", which does not look like a test ` +
        'database; refusing to provision anything there',
    );
  }

  const name = `reels_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString: withDatabase(baseUrl, name),
    max: 4,
    application_name: 'reels-test',
  });

  return { url: withDatabase(baseUrl, name), pool, close: () => pool.end() };
}

/**
 * Run `fn` on a brand-new session that was never part of the pool.
 *
 * "Visible to a second connection" is the claim these tests make, and a pooled
 * client can be handed back the connection that wrote the row. A fresh Client
 * cannot: its backend pid is provably a different process session.
 */
export async function withSecondConnection<T>(
  pool: Pool,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(pool.options);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
