/**
 * Migration on boot.
 *
 * The first deploy of the UI failed with `relation "operator" does not exist`
 * because `web` started before `migrate` had ever run: the schema step was a
 * separate one-shot that a pull-and-up could skip. At single-operator scale that
 * gate costs more than it protects, so web and the workers apply pending
 * migrations before they serve.
 *
 * Safe to call from every replica at once: `runMigrations` takes a
 * `pg_advisory_lock` on a dedicated connection, so concurrent booters serialise,
 * and each migration is recorded in `schema_migration` with a checksum, so the
 * second caller finds everything already applied and does nothing.
 *
 * What it deliberately does NOT do: start serving if a migration fails. A process
 * whose schema is older than its code must not take traffic — the failure is
 * thrown with the migration id so the container exits and the deploy stops.
 */
import type { Pool } from 'pg';

import { runMigrations } from '../db/runner.js';

export interface MigrateOnStartResult {
  readonly ran: boolean;
  readonly applied: readonly string[];
}

/** `MIGRATE_ON_START=false` is the only way to skip it; the default is on. */
export function migrateOnStartEnabled(env: { readonly MIGRATE_ON_START?: string }): boolean {
  return env.MIGRATE_ON_START !== 'false';
}

export async function migrateOnStart(
  pool: Pool,
  options: {
    readonly env: { readonly MIGRATE_ON_START?: string };
    readonly log?: (message: string) => void;
  },
): Promise<MigrateOnStartResult> {
  const log = options.log ?? (() => undefined);

  if (!migrateOnStartEnabled(options.env)) {
    log('migrations on boot: disabled (MIGRATE_ON_START=false)');
    return { ran: false, applied: [] };
  }

  try {
    const result = await runMigrations(pool);
    if (result.applied.length === 0) {
      log('migrations on boot: schema already current');
    } else {
      log(`migrations on boot: applied ${result.applied.join(', ')}`);
    }
    return { ran: true, applied: result.applied };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`migrations on boot: FAILED — refusing to start. ${detail}`);
    throw error;
  }
}
