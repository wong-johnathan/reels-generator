import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresSceneGateway } from './postgres.js';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/client.js', () => ({
  withTransaction: async (_pool: unknown, fn: (client: typeof db) => Promise<unknown>) => fn(db),
}));

describe('SB approval pre-write safety', () => {
  it.each([
    ['stale revision', { revision: 2, state: 'awaiting_approval', scenes: true }],
    ['stale stage', { revision: 1, state: 'stale', scenes: true }],
    ['failed stage', { revision: 1, state: 'failed', scenes: true }],
    ['missing scenes', { revision: 1, state: 'awaiting_approval', scenes: false }],
  ])('blocks %s without a decision', async (_label, options) => {
    const config = options as { revision: number; state: string; scenes: boolean };
    db.query.mockReset();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM project'))
        return { rows: [{ id: 'p', storyboard_revision: config.revision }] };
      if (sql.includes('FROM review_decision')) return { rows: [] };
      if (sql.includes('FROM video_stage'))
        return { rows: [{ id: 'sb', stage: 'SB', state: config.state }] };
      if (sql.includes('FROM scene')) return { rows: config.scenes ? [{ id: 'scene' }] : [] };
      return { rows: [] };
    });
    const gateway = createPostgresSceneGateway(db as unknown as Pool);
    await expect(
      gateway.approveStoryboard('p', { revision: 1, note: 'auto_approve_all' }),
    ).rejects.toThrow();
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO review_decision')),
    ).toBe(false);
  });
});
