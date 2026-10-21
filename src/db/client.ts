/**
 * Postgres connection factory — TECH_DESIGN §3, §9.6.
 *
 * Connection parameters come from the validated `POSTGRES_*` environment keys
 * (src/config/env.ts). The password is read from the environment and never
 * logged: `describeTarget()` exists so logs can name host/database without it.
 *
 * Repositories take a `Queryable` (pool or transaction client) rather than a
 * pool, so a caller decides the transaction boundary once, at the top.
 */
import {
  Client,
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

/** Anything that can run a query: a pool or an open transaction. */
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

const REQUIRED_KEYS = ['POSTGRES_HOST', 'POSTGRES_DB', 'POSTGRES_USER'] as const;

/** Build pool options from `POSTGRES_*`; throws a named, value-free error if incomplete. */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new DatabaseConfigError(
      `database configuration is incomplete: ${missing.join(', ')} (see .env.example)`,
    );
  }

  const port = Number(env.POSTGRES_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigError('POSTGRES_PORT must be an integer between 1 and 65535');
  }

  return {
    host: env.POSTGRES_HOST,
    port,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD ?? '',
    application_name: 'reels-generator',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/** A pool for the configured database. The caller owns `pool.end()`. */
export function createPool(env: NodeJS.ProcessEnv = process.env): Pool {
  return new Pool(poolConfigFromEnv(env));
}

/** A pool from a connection string (scripts and tests only). */
export function createPoolFromUrl(url: string, options: PoolConfig = {}): Pool {
  return new Pool({ connectionString: url, application_name: 'reels-generator', ...options });
}

/** Loggable target description — never includes the password. */
export function describeTarget(config: PoolConfig): string {
  return `${config.host ?? 'localhost'}:${config.port ?? 5432}/${config.database ?? '?'}`;
}

/**
 * Run `fn` inside one transaction. Rolls back on any thrown error and always
 * returns the client to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Run `fn` with a pooled client that is not in a transaction. */
export async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Open a *new* session that has never been part of the pool.
 *
 * This is what "visible to a second connection" means structurally: the caller
 * gets a backend pid that cannot be the session that wrote the row, so a
 * successful read proves a commit rather than read-your-own-writes.
 */
export async function withFreshSession<T>(
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

/** Cheap liveness probe for `/readyz` (R-018). */
export async function ping(pool: Pool): Promise<{ serverVersion: string; backendPid: number }> {
  const result = await pool.query<{ server_version: string; pid: number }>(
    `SELECT current_setting('server_version') AS server_version, pg_backend_pid() AS pid`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('postgres answered the probe without a row');
  return { serverVersion: row.server_version, backendPid: row.pid };
}
