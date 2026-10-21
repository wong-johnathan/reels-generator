#!/usr/bin/env node
/**
 * `migrate` one-shot — R-017-2, TECH_DESIGN §9.3.
 *
 * Runs exactly once per deployment (`deploy/up.sh` → `docker compose --profile
 * migrate run --rm migrate`), never in every worker. Forward-only, idempotent,
 * and fail-closed: a failing migration rolls back its own DDL, leaves the
 * ledger untouched, exits non-zero, and the previous image keeps running on the
 * unchanged schema (R-017-4).
 *
 *   node dist/src/db/migrate.js          # default: `up`
 *   node dist/src/db/migrate.js up
 *   node dist/src/db/migrate.js status
 *
 * Nothing here prints a connection value: `describeTarget()` names host/database
 * only, and the password never leaves the environment (R-015-5).
 */
import { pathToFileURL } from 'node:url';

import { createPool, describeTarget, poolConfigFromEnv } from './client.js';
import { MIGRATIONS } from './migrations/index.js';
import { migrationStatus, runMigrations } from './runner.js';

export type MigrateCommand = 'up' | 'status';

export const USAGE = 'usage: migrate [up|status]  (default: up)';

/** Parse the CLI tail. Returns `null` for an unknown command. */
export function parseCommand(argv: readonly string[]): MigrateCommand | null {
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (command === undefined) return 'up';
  if (command === 'up' || command === 'status') return command;
  return null;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const command = parseCommand(argv);
  if (command === null) {
    err(`migrate: unknown command "${argv.join(' ')}"\n${USAGE}`);
    return 2;
  }

  let target: string;
  let pool;
  try {
    target = describeTarget(poolConfigFromEnv());
    pool = createPool();
  } catch (error) {
    err(`migrate: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  try {
    if (command === 'status') {
      const rows = await migrationStatus(pool);
      if (rows.length === 0) {
        log(`migrate: ${target} — no migrations applied yet (${MIGRATIONS.length} bundled)`);
        return 0;
      }
      for (const row of rows) {
        const state = row.checksumMatches ? 'applied' : 'applied (CHECKSUM MISMATCH)';
        log(`migrate: ${row.id} ${state} at ${row.appliedAt.toISOString()} — ${row.description}`);
      }
      const pending = MIGRATIONS.filter((m) => !rows.some((row) => row.id === m.id)).map(
        (m) => m.id,
      );
      log(
        `migrate: ${target} — ${rows.length} applied, ${pending.length} pending` +
          (pending.length > 0 ? ` (${pending.join(', ')})` : ''),
      );
      return 0;
    }

    log(`migrate: ${target} — ${MIGRATIONS.length} bundled migrations`);
    const result = await runMigrations(pool);
    if (result.applied.length === 0) {
      log(`migrate: up to date (${result.alreadyApplied.length} already applied); nothing to do`);
    } else {
      log(`migrate: applied ${result.applied.join(', ')}`);
    }
    return 0;
  } catch (error) {
    err(`migrate: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main();
}
