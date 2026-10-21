/**
 * Forward-only migration runner (R-017-2, TECH_DESIGN §9.3).
 *
 * Contract:
 * - `schema_migration` records every applied id with the sha256 of its SQL, so
 *   an edited migration that was already applied fails closed instead of being
 *   silently skipped (a migration is immutable once applied).
 * - each migration runs inside its own transaction, so a failing migration
 *   leaves neither half of its DDL nor a ledger row behind (R-017-4).
 * - a session-level advisory lock serialises concurrent one-shots; the deploy
 *   script runs `migrate` once, but a retried container must not interleave.
 * - re-running `up` on an up-to-date database applies nothing (idempotent).
 */
import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { MIGRATIONS, type Migration } from './migrations/index.js';

/**
 * Advisory-lock key for the migration one-shot (the two-int form, so the
 * parameter types are exact). Any constant works as long as every replica uses
 * the same one; the values spell "reel" / "s-mi" in ASCII.
 */
export const MIGRATION_LOCK_KEY = [0x7265656c, 0x732d6d69] as const;

/** `schema_migration` — the ledger of applied migrations. */
export const LEDGER_TABLE_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_migration (
  id          text PRIMARY KEY,
  checksum    text NOT NULL,
  description text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms int NOT NULL CHECK (duration_ms >= 0)
);
`;

export class MigrationChecksumMismatchError extends Error {
  constructor(
    readonly migrationId: string,
    readonly recordedChecksum: string,
    readonly currentChecksum: string,
  ) {
    super(
      `${migrationId} was already applied with checksum ${recordedChecksum.slice(0, 12)}… but the ` +
        `bundled SQL hashes to ${currentChecksum.slice(0, 12)}…. An applied migration is immutable: ` +
        'add a new migration instead of editing this one (R-017-3).',
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class MigrationFailedError extends Error {
  constructor(
    readonly migrationId: string,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${migrationId} failed and was rolled back: ${detail}`);
    this.name = 'MigrationFailedError';
  }
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

export interface MigrationResult {
  /** Ids applied by this call, in order. */
  readonly applied: readonly string[];
  /** Ids that were already applied and verified, in order. */
  readonly alreadyApplied: readonly string[];
}

export interface MigrationStatusRow {
  readonly id: string;
  readonly description: string;
  readonly appliedAt: Date;
  readonly checksumMatches: boolean;
}

async function applyOne(client: PoolClient, migration: Migration, checksum: string): Promise<void> {
  const startedAt = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migration (id, checksum, description, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.id, checksum, migration.description, Date.now() - startedAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new MigrationFailedError(migration.id, error);
  }
}

/**
 * Apply every pending migration in `migrations` order.
 *
 * The whole run holds one advisory lock on one connection; each migration still
 * commits separately, so an interruption resumes at the next unapplied id.
 */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [...MIGRATION_LOCK_KEY]);
    await client.query(LEDGER_TABLE_SQL);

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const existing = await client.query<{ checksum: string }>(
        `SELECT checksum FROM schema_migration WHERE id = $1`,
        [migration.id],
      );

      if (existing.rowCount === 1) {
        const recorded = existing.rows[0]!.checksum;
        if (recorded !== checksum) {
          throw new MigrationChecksumMismatchError(migration.id, recorded, checksum);
        }
        alreadyApplied.push(migration.id);
        continue;
      }

      await applyOne(client, migration, checksum);
      applied.push(migration.id);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1, $2)', [...MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }

  return { applied, alreadyApplied };
}

/** Report the ledger against the bundled set — used by `migrate status`. */
export async function migrationStatus(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<readonly MigrationStatusRow[]> {
  const ledger = await pool.query<{
    id: string;
    checksum: string;
    description: string;
    applied_at: Date;
  }>(`SELECT id, checksum, description, applied_at FROM schema_migration ORDER BY id`);

  return ledger.rows.map((row) => {
    const bundled = migrations.find((migration) => migration.id === row.id);
    return {
      id: row.id,
      description: row.description,
      appliedAt: row.applied_at,
      checksumMatches: bundled !== undefined && migrationChecksum(bundled) === row.checksum,
    };
  });
}
