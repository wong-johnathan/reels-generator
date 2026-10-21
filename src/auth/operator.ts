/**
 * The single seeded operator — R-015-1, R-015-3, D3.
 *
 * There is no registration endpoint and no password-reset flow, so seeding is
 * the only writer of `operator.password_hash`, and it writes it **once**:
 *
 * - no row      → hash OPERATOR_PASSWORD with argon2id and insert it;
 * - row, same username → do nothing (a changed OPERATOR_PASSWORD does not
 *   reset the account — that would be the reset flow R-015-3 forbids);
 * - row, other username → refuse loudly; the operator row is the deployment's
 *   identity and a silent second identity would be a security bug.
 *
 * The hash never appears in a log line or an error message.
 */
import type { Queryable } from '../db/client.js';
import { assertPasswordPolicy, hashPassword } from './password.js';
import type { OperatorReader, OperatorRecord } from './types.js';

export interface SeedResult {
  readonly created: boolean;
  readonly operatorId: string;
  readonly username: string;
}

/** The deployment already has an operator under a different username. */
export class OperatorMismatchError extends Error {
  constructor(expected: string, found: string) {
    super(
      `operator "${found}" is already seeded; OPERATOR_USERNAME is "${expected}". ` +
        'There is no rename or reset path (R-015-3) — restore the intended username or ' +
        'provision the account deliberately.',
    );
    this.name = 'OperatorMismatchError';
  }
}

/** A required OPERATOR_* key is missing; the message names keys, never values. */
export class SeedEnvError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `operator seeding needs ${missing.join(', ')} (see .env.example). ` +
        'No operator row was written.',
    );
    this.name = 'SeedEnvError';
  }
}

export class PgOperatorStore implements OperatorReader {
  constructor(private readonly db: Queryable) {}

  async findByUsername(username: string): Promise<OperatorRecord | null> {
    const result = await this.db.query<{
      id: string;
      username: string;
      password_hash: string;
    }>('SELECT id, username, password_hash FROM operator WHERE username = $1 LIMIT 1', [username]);
    const row = result.rows[0];
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash } : null;
  }
}

async function findExisting(db: Queryable): Promise<{ id: string; username: string } | null> {
  const result = await db.query<{ id: string; username: string }>(
    'SELECT id, username FROM operator LIMIT 1',
  );
  return result.rows[0] ?? null;
}

/** Seed the single operator, idempotently and without ever resetting a hash. */
export async function seedOperator(
  db: Queryable,
  options: { readonly username: string; readonly password: string },
): Promise<SeedResult> {
  const username = options.username.trim();
  if (username.length === 0) {
    throw new SeedEnvError(['OPERATOR_USERNAME']);
  }
  // Policy first: an invalid password must not even read the operator table.
  assertPasswordPolicy(options.password);

  const existing = await findExisting(db);
  if (existing) {
    if (existing.username !== username) {
      throw new OperatorMismatchError(username, existing.username);
    }
    return { created: false, operatorId: existing.id, username: existing.username };
  }

  // Policy is enforced by hashPassword before any write.
  const passwordHash = await hashPassword(options.password);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO operator (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [username, passwordHash],
  );
  const newRow = inserted.rows[0];
  if (newRow) return { created: true, operatorId: newRow.id, username };

  // A concurrent seeder won the race: re-read and apply the same rules.
  const raced = await findExisting(db);
  if (!raced || raced.username !== username) {
    throw new OperatorMismatchError(username, raced?.username ?? 'another operator');
  }
  return { created: false, operatorId: raced.id, username: raced.username };
}

/**
 * Seed from the environment (`OPERATOR_USERNAME`, `OPERATOR_PASSWORD`). Both are
 * required for `web` by src/config/env.ts; this re-check exists because the seed
 * one-shot can run without the full web environment.
 */
export async function seedOperatorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  db: Queryable,
): Promise<SeedResult> {
  const username = env.OPERATOR_USERNAME?.trim() ?? '';
  const password = env.OPERATOR_PASSWORD ?? '';
  const missing: string[] = [];
  if (username.length === 0) missing.push('OPERATOR_USERNAME');
  if (password.length === 0) missing.push('OPERATOR_PASSWORD');
  if (missing.length > 0) throw new SeedEnvError(missing);

  return seedOperator(db, { username, password });
}
