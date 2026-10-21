/**
 * The recorded provider-qualification gate - R-008-3 / TECH_DESIGN 5.6.
 *
 * Each adapter runs `qualify()` once before it is trusted, and the result is
 * written to `provider_qualification` (M-005) as a pass/fail row with details
 * and a timestamp. The content worker then refuses to issue a billable call
 * while the *latest* record for that provider/adapter is not `passed`.
 *
 * The gate is deliberately per (provider, adapter): a passing fake run does not
 * qualify DeepSeek, and a passing research run does not qualify image/TTS.
 */
import type { Queryable } from '../db/client.js';

export interface QualificationRow {
  readonly id: string;
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
  readonly run_at: Date;
}

export interface RecordQualificationInput {
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  readonly details: object;
  /** Defaults to the database clock; explicit only for backfills and tests. */
  readonly runAt?: Date;
}

const COLUMNS = /* sql */ `id, provider, adapter, passed, details, run_at`;

function toRow(row: QualificationRow): QualificationRow {
  return {
    ...row,
    run_at: row.run_at instanceof Date ? row.run_at : new Date(row.run_at),
    details: (row.details ?? {}) as Record<string, unknown>,
  };
}

export async function recordQualification(
  db: Queryable,
  input: RecordQualificationInput,
): Promise<QualificationRow> {
  const result = await db.query<QualificationRow>(
    `INSERT INTO provider_qualification (provider, adapter, passed, details, run_at)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, now()))
     RETURNING ${COLUMNS}`,
    [
      input.provider,
      input.adapter,
      input.passed,
      JSON.stringify(input.details),
      input.runAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('provider_qualification insert returned no row');
  return toRow(row);
}

/** The newest qualification run for one provider/adapter pair, or null. */
export async function latestQualification(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<QualificationRow | null> {
  const result = await db.query<QualificationRow>(
    `SELECT ${COLUMNS}
       FROM provider_qualification
      WHERE provider = $1 AND adapter = $2
      ORDER BY run_at DESC
      LIMIT 1`,
    [provider, adapter],
  );
  const row = result.rows[0];
  return row ? toRow(row) : null;
}

/** Raised when a billable call is attempted before a passing qualification. */
export class QualificationGateError extends Error {
  readonly provider: string;
  readonly adapter: string;
  readonly latest: QualificationRow | null;

  constructor(provider: string, adapter: string, latest: QualificationRow | null) {
    super(
      latest === null
        ? `provider qualification for ${provider}/${adapter} is not passed: no qualification run is recorded (R-008-3)`
        : `provider qualification for ${provider}/${adapter} is not passed: latest run ${latest.id} at ${latest.run_at.toISOString()} failed (R-008-3)`,
    );
    this.name = 'QualificationGateError';
    this.provider = provider;
    this.adapter = adapter;
    this.latest = latest;
  }
}

/**
 * The check the content worker performs before a billable provider call.
 * Resolves only when the latest recorded run for this pair passed.
 */
export async function assertLatestQualificationPassed(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<void> {
  const latest = await latestQualification(db, provider, adapter);
  if (latest === null || latest.passed !== true) {
    throw new QualificationGateError(provider, adapter, latest);
  }
}
