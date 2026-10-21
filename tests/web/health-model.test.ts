import { describe, expect, it } from 'vitest';

import { AttemptRowSchema, HealthReportSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  ATTEMPT_PAGE_SIZE,
  attemptRowModel,
  attemptsView,
  chargeFor,
  diskView,
  healthSummary,
  migrationView,
  providerRows,
  qualificationRows,
  queueView,
  sortAttempts,
  type AttemptRow,
  type HealthReport,
} from '../../src/web/health/model.js';
import { STAGE_CODES } from '../../src/shared/stages.js';

/**
 * S-19/S-21 view model — US-011/012/013, R-008-3, R-012-2, R-012-4, R-018.
 * R-012-4 is the sharpest rule here: a timeout may still have billed, so it
 * must never be summarised as `unbilled`.
 */

const report: HealthReport = HealthReportSchema.parse(FIXTURES['health.report']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);
const baseAttempt: AttemptRow = AttemptRowSchema.parse(
  (FIXTURES['attempts.list'] as { attempts: unknown[] }).attempts[0],
);
const NOW = Date.parse('2026-10-20T10:00:00.000Z');

function attempt(overrides: Partial<AttemptRow>): AttemptRow {
  return { ...baseAttempt, ...overrides };
}

describe('provider states (R-015-5, R-018-3)', () => {
  it('maps key presence and qualification to one structural state each', () => {
    const rows = providerRows(report.providers);
    expect(rows.map((row) => row.provider)).toEqual(['deepseek', 'gemini', 'elevenlabs']);
    expect(rows.map((row) => row.state)).toEqual(['ok', 'ok', 'not_qualified']);
    expect(rows.map((row) => row.envKey)).toEqual([
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'ELEVENLABS_API_KEY',
    ]);
  });

  it('never renders a key value, only presence and the variable name', () => {
    const text = JSON.stringify(providerRows(report.providers));
    expect(text).toContain('keyPresent');
    expect(text).not.toMatch(/sk-[a-z0-9]{8,}/i);
  });

  it('reports an absent key before qualification', () => {
    const rows = providerRows([{ ...report.providers[0]!, key_present: false, qualified: true }]);
    expect(rows[0]?.state).toBe('key_absent');
    expect(rows[0]?.stateWord).toBe('key absent');
    expect(rows[0]?.qualifiedLine).toBe('PASS 2026-10-20T09:00:00Z');
  });

  it('names each qualification with its timestamp or NOT RUN', () => {
    const rows = qualificationRows(report.providers);
    expect(rows.map((row) => row.line)).toEqual([
      'PASS 2026-10-20T09:00:00Z',
      'PASS 2026-10-20T09:00:00Z',
      'NOT RUN',
    ]);
    expect(rows.filter((row) => row.passed)).toHaveLength(2);
  });
});

describe('queue, disk and migration', () => {
  it('keeps the queue as an attention reason, with three exact counts', () => {
    const queue = queueView(report)!;
    expect(queue.line).toBe('waiting 2 · active 1 · failed 0');
    expect(queue.note).toContain('attention reason');
  });

  it('says the queue was not reported rather than showing zeros', () => {
    expect(queueView({ ...report, queue: null })).toBeNull();
  });

  it('computes used percent from the two byte counts and one-decimal sizes', () => {
    const disk = diskView(report)!;
    expect(disk.usedPercent).toBe(83);
    expect(disk.line).toBe('83% full · 38.0 GB free of 220.0 GB');
    expect(disk.warning).toContain('below the safety margin');
  });

  it('warns only when the reported headroom is below the margin', () => {
    const healthy = diskView({
      ...report,
      disk: { free_bytes: 128_849_018_880, total_bytes: 236_223_283_200, headroom_ok: true },
    })!;
    expect(healthy.warning).toBeNull();
    expect(healthy.usedPercent).toBe(45);
  });

  it('gives a zero-byte volume a defined percent, not NaN', () => {
    const disk = diskView({
      ...report,
      disk: { free_bytes: 0, total_bytes: 0, headroom_ok: false },
    })!;
    expect(disk.usedPercent).toBe(0);
    expect(disk.line).toBe('0% full · 0 B free of 0 B');
  });

  it('states the migration status and version', () => {
    expect(migrationView(report).line).toBe('Migration up to date · M-005');
    expect(migrationView({ ...report, migration: { status: 'pending', version: null } }).line).toBe(
      'Migration pending',
    );
    expect(
      migrationView({ ...report, migration: { status: 'failed', version: 'M-006' } }).failed,
    ).toBe(true);
  });

  it('summarises readiness, the checker and every provider', () => {
    const summary = healthSummary(report);
    expect(summary.readyWord).toBe('Service ready');
    expect(summary.checkedLine).toBe('Checked 2026-10-20T09:41:12Z');
    expect(summary.serviceLine).toBe('Reported by the web process');
    expect(summary.providers).toHaveLength(3);
    expect(summary.degradedReasons).toEqual(['disk headroom below 20 %']);
  });
});

describe('attempt charge words (R-012-4, AX-26)', () => {
  it('says unknown charge for a timeout, whatever the charge status', () => {
    expect(chargeFor(attempt({ status: 'timed_out', charge_status: 'unbilled' }))).toEqual({
      tone: 'unknown',
      word: 'unknown charge',
    });
    expect(chargeFor(attempt({ status: 'timed_out' })).word).toBe('unknown charge');
    expect(chargeFor(attempt({ status: 'unknown_charge' })).tone).toBe('unknown');
    expect(chargeFor(attempt({ charge_status: 'unknown' })).tone).toBe('unknown');
  });

  it('keeps billed, pending and unbilled as reported for settled statuses', () => {
    expect(chargeFor(attempt({ status: 'succeeded', charge_status: 'billed' })).word).toBe(
      'billed',
    );
    expect(chargeFor(attempt({ status: 'running', charge_status: 'pending' })).word).toBe(
      'pending',
    );
    expect(chargeFor(attempt({ status: 'failed', charge_status: 'unbilled' })).word).toBe(
      'unbilled',
    );
  });
});

describe('attempt rows', () => {
  it('renders attempt n of m, the error class and the backoff', () => {
    const row = attemptRowModel(
      attempt({
        attempt_no: 2,
        max_attempts: 3,
        error_class: 'transient',
        http_status: 503,
        backoff_s: 4,
        idempotency_protected: false,
      }),
      NOW,
    );
    expect(row.attempt).toBe('2 of 3');
    expect(row.errorLine).toBe('transient · HTTP 503');
    expect(row.backoff).toBe('4 s');
    expect(row.idempotency).toBe('unprotected');
    expect(row.stageLabel).toBe('Narration');
  });

  it('does not call a successful 200 an error', () => {
    const success = attemptRowModel(
      attempt({ status: 'succeeded', error_class: null, http_status: 200 }),
      NOW,
    );
    expect(success.errorLine).toBeNull();
    expect(attemptRowModel(attempt({ error_class: null, http_status: 500 }), NOW).errorLine).toBe(
      'error · HTTP 500',
    );
  });

  it('shows an em dash for a missing request id rather than a blank', () => {
    expect(attemptRowModel(attempt({ provider_request_id: null }), NOW).requestId).toBe('—');
  });

  it('marks an idempotency-protected row as protected', () => {
    expect(attemptRowModel(attempt({ idempotency_protected: true }), NOW).idempotency).toBe(
      'protected',
    );
  });

  it('orders newest first and keeps server order for equal timestamps', () => {
    const older = attempt({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      created_at: '2026-10-20T08:00:00.000Z',
    });
    const newer = attempt({
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      created_at: '2026-10-20T09:30:00.000Z',
    });
    const sameA = attempt({
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      created_at: '2026-10-20T09:30:00.000Z',
    });
    expect(sortAttempts([older, newer, sameA]).map((row) => row.id)).toEqual([
      newer.id,
      sameA.id,
      older.id,
    ]);
  });

  it('filters by stage before applying the 50-row page', () => {
    const rows = diagnosticRows(120);
    const view = attemptsView({
      videoId: detail.id,
      videoLabel: 'Video 18',
      stage: 'NA',
      rows,
      now: NOW,
      error: false,
    });
    expect(view.rows).toHaveLength(ATTEMPT_PAGE_SIZE);
    expect(view.rows.every((row) => row.stage === 'NA')).toBe(true);
    expect(view.truncated).toBe(true);
    expect(view.limitLine).toContain('no offset');
    expect(view.videoLabel).toBe('Video 18');
  });

  it('offers every stage plus an all-stages choice', () => {
    const view = attemptsView({
      videoId: null,
      videoLabel: null,
      stage: null,
      rows: null,
      now: NOW,
      error: false,
    });
    expect(view.stageOptions.map((option) => option.code)).toEqual([...STAGE_CODES]);
    expect(view.stageOptions).toHaveLength(11);
    expect(view.rows).toHaveLength(0);
  });

  it('asks for a video instead of showing an empty table', () => {
    const view = attemptsView({
      videoId: null,
      videoLabel: null,
      stage: null,
      rows: null,
      now: NOW,
      error: false,
    });
    expect(view.emptyLine).toContain('Choose a video');
    expect(view.disabledLine).toBeNull();
  });

  it('names the stage that has no rows', () => {
    const view = attemptsView({
      videoId: detail.id,
      videoLabel: 'Video 18',
      stage: 'NA',
      rows: [attempt({ stage: 'IM' })],
      now: NOW,
      error: false,
    });
    expect(view.emptyLine).toBe('No attempt rows for this video at NA (Narration).');
  });

  it('reports a load failure without pretending there are no rows', () => {
    const view = attemptsView({
      videoId: detail.id,
      videoLabel: null,
      stage: null,
      rows: null,
      now: NOW,
      error: true,
    });
    expect(view.errorLine).toBe('The attempt rows could not be loaded. Nothing was changed.');
    expect(view.emptyLine).toBeNull();
  });
});

function diagnosticRows(count: number): AttemptRow[] {
  return Array.from({ length: count }, (_value, index) =>
    attempt({
      id: 'bbbbbbbb-0000-4000-8000-' + String(index).padStart(12, '0'),
      stage: index % 2 === 0 ? 'NA' : 'IM',
      created_at: new Date(Date.parse('2026-10-20T09:00:00.000Z') + index * 60_000).toISOString(),
    }),
  );
}
