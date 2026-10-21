/**
 * Auth fixture: a throwaway database with the migrations applied and the single
 * operator seeded, plus the real Postgres-backed stores and service.
 *
 * Every auth test drives the production code paths (`PgOperatorStore`,
 * `PgSessionStore`, `AuthService`, the argon2id hasher) against a real Postgres,
 * because the things under test — the token hash uniqueness, the argon2id PHC
 * string, session expiry, the exactly-one-operator index — are database and
 * crypto properties, not in-memory conveniences.
 */
import type { Pool } from 'pg';

import { LoginBackoff } from '../../src/auth/backoff.js';
import { PgOperatorStore, seedOperator } from '../../src/auth/operator.js';
import { AuthService } from '../../src/auth/service.js';
import { PgSessionStore } from '../../src/auth/sessions.js';
import { runMigrations } from '../../src/db/runner.js';
import { createTestDatabase, type TestDatabase } from './pg.js';

export const TEST_USERNAME = 'owner';
/** Synthetic, obviously-not-a-credential value (R-015-5). */
export const TEST_PASSWORD = 'test-operator-password-1';
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789';
export const TEST_TTL_SECONDS = 3600;

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function createClock(startIso = '2026-10-21T00:00:00.000Z'): TestClock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (iso: string) => {
      current = new Date(iso).getTime();
    },
  };
}

export interface AuthFixture {
  readonly db: TestDatabase;
  readonly pool: Pool;
  readonly operatorId: string;
  readonly sessions: PgSessionStore;
  readonly operators: PgOperatorStore;
  readonly service: AuthService;
  readonly clock: TestClock;
  readonly backoff: LoginBackoff;
  close(): Promise<void>;
}

export async function provisionAuth(options: { ttlSeconds?: number } = {}): Promise<AuthFixture> {
  const db = await createTestDatabase();
  const pool = db.pool;
  await runMigrations(pool);

  const seeded = await seedOperator(pool, {
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
  });

  const clock = createClock();
  const sessions = new PgSessionStore(pool);
  const operators = new PgOperatorStore(pool);
  const backoff = new LoginBackoff({ now: clock.now });
  const service = new AuthService({
    operators,
    sessions,
    backoff,
    config: {
      sessionSecret: TEST_SESSION_SECRET,
      sessionTtlSeconds: options.ttlSeconds ?? TEST_TTL_SECONDS,
      now: clock.now,
    },
  });

  return {
    db,
    pool,
    operatorId: seeded.operatorId,
    sessions,
    operators,
    service,
    clock,
    backoff,
    close: () => db.close(),
  };
}
