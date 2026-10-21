import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { migrateOnStart, migrateOnStartEnabled } from './migrate-on-start.js';

/** A pool that must not be touched: proves the skip path never opens a connection. */
function untouchablePool(): Pool {
  return new Proxy({} as Pool, {
    get() {
      throw new Error('pool must not be used when MIGRATE_ON_START=false');
    },
  });
}

describe('migrateOnStartEnabled', () => {
  it('defaults to on, so a pull-and-up cannot leave the schema behind', () => {
    expect(migrateOnStartEnabled({})).toBe(true);
    expect(migrateOnStartEnabled({ MIGRATE_ON_START: 'true' })).toBe(true);
  });

  it('is off only for the exact string false', () => {
    expect(migrateOnStartEnabled({ MIGRATE_ON_START: 'false' })).toBe(false);
    // Anything else stays on: a typo must not silently disable migrations.
    expect(migrateOnStartEnabled({ MIGRATE_ON_START: 'False' })).toBe(true);
    expect(migrateOnStartEnabled({ MIGRATE_ON_START: '0' })).toBe(true);
  });
});

describe('migrateOnStart', () => {
  it('skips without touching the database when disabled', async () => {
    const log = vi.fn();
    const result = await migrateOnStart(untouchablePool(), {
      env: { MIGRATE_ON_START: 'false' },
      log,
    });
    expect(result).toEqual({ ran: false, applied: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('rethrows a failed migration instead of starting on a stale schema', async () => {
    const pool = {
      connect: async () => {
        throw new Error('relation "operator" does not exist');
      },
    } as unknown as Pool;

    const log = vi.fn();
    await expect(migrateOnStart(pool, { env: {}, log })).rejects.toThrow(/does not exist/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing to start'));
  });
});
