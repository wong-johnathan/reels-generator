import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresRenderGateway } from './postgres.js';

// Exercise the production approval checks and real recordReviewDecision writer,
// not a mock approval implementation. DB constraints/concurrency have separate
// Postgres-backed coverage.
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/client.js', () => ({
  withTransaction: async (_pool: unknown, fn: (client: typeof db) => Promise<unknown>) => fn(db),
}));

function fixture(
  options: { qc?: string; re?: string; missing?: boolean; passes?: number; stale?: boolean } = {},
) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM project')) return { rows: [{ id: 'p' }] };
    if (sql.includes('FROM review_decision')) return { rows: [] };
    if (sql.includes("stage = 'FA'")) return { rows: [{ id: 'fa', state: 'awaiting_approval' }] };
    if (sql.includes('count(*)')) return { rows: [{ count: options.passes ?? 1 }] };
    if (sql.includes("stage = 'QC'")) return { rows: [{ state: options.qc ?? 'done' }] };
    if (sql.includes('FROM video_stage'))
      return {
        rows: options.stale
          ? [{ stage: 'SC', state: 'stale' }]
          : [{ stage: 'RE', state: options.re ?? 'done' }],
      };
    if (sql.includes('FROM asset a'))
      return {
        rows: options.missing
          ? []
          : [{ id: 'video', created_at: new Date('2026-10-20T00:00:00Z') }],
      };
    if (sql.startsWith('INSERT INTO job')) return { rows: [{ id: 'export-job' }] };
    if (sql.startsWith('INSERT INTO review_decision')) return { rows: [{ id: 'decision' }] };
    return { rows: [] };
  });
  return createPostgresRenderGateway(db as unknown as Pool);
}

function expectNoApprovalWrite() {
  expect(
    db.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO review_decision')),
  ).toBe(false);
  expect(db.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE video_stage'))).toBe(
    false,
  );
}

describe('FA approval pre-write safety (automatic and manual share this path)', () => {
  it('uses the real ledger writer with audit reason/revision and queues export after validation', async () => {
    const gateway = fixture();
    await gateway.approve('p', { revision: 1, note: 'auto_approve_all' });
    const write = db.query.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO review_decision'),
    );
    expect(write?.[1]).toEqual(['p', 'FA', 'approve', null, 'auto_approve_all', 1, null, null]);
    const enqueue = db.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO job'));
    expect(enqueue?.[1]).toEqual(['p', 'EX', null, 2, null]);
  });
  it.each([
    ['failed QC', { qc: 'failed' }],
    ['stale revision', { passes: 2 }],
    ['stale render', { re: 'stale' }],
    ['stale upstream stage', { stale: true }],
    ['missing video asset', { missing: true }],
  ] as const)('refuses %s before writing any decision', async (_label, options) => {
    const gateway = fixture(options);
    await expect(gateway.approve('p', { revision: 1, note: 'auto_approve_all' })).rejects.toThrow();
    expectNoApprovalWrite();
  });
});
