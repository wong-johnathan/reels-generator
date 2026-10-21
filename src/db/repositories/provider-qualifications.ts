/**
 * `provider_qualification` — the recorded adapter qualification (R-008-3, §5.6).
 *
 * Written by each adapter's `qualify()`; read by the gate before a billable call.
 * The newest row per (provider, adapter) is the verdict: a failed row and an
 * absent row both refuse the call, so a regression cannot be "forgotten" by
 * simply not re-running qualification.
 *
 * `run_at` is set to `clock_timestamp()` rather than the column's `now()`
 * default: `now()` is the transaction-start time, so two qualifications started
 * in quick succession could share a timestamp and make "latest" ambiguous.
 */
import type { Queryable } from '../client.js';

export interface ProviderQualificationRow {
  readonly id: string;
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  /** `jsonb` as the driver returns it: an object, not a string. */
  readonly details: unknown;
  readonly run_at: Date;
}

export interface NewProviderQualification {
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  /** Serialised into `jsonb`. Must never contain a credential (R-015-5). */
  readonly details: unknown;
}

const COLUMNS = /* sql */ `id, provider, adapter, passed, details, run_at`;

/** Record one qualification verdict. Returns the committed row. */
export async function insertQualification(
  db: Queryable,
  input: NewProviderQualification,
): Promise<ProviderQualificationRow> {
  const result = await db.query<ProviderQualificationRow>(
    `INSERT INTO provider_qualification (provider, adapter, passed, details, run_at)
     VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
     RETURNING ${COLUMNS}`,
    [input.provider, input.adapter, input.passed, JSON.stringify(input.details)],
  );
  const row = result.rows[0];
  if (!row) throw new Error('provider_qualification insert returned no row');
  return row;
}

/** The verdict the gate reads: newest row for this provider+adapter, or null. */
export async function latestQualification(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<ProviderQualificationRow | null> {
  const result = await db.query<ProviderQualificationRow>(
    `SELECT ${COLUMNS}
       FROM provider_qualification
      WHERE provider = $1 AND adapter = $2
      ORDER BY run_at DESC, id DESC
      LIMIT 1`,
    [provider, adapter],
  );
  return result.rows[0] ?? null;
}

export class ProviderNotQualifiedError extends Error {
  constructor(
    readonly provider: string,
    readonly adapter: string,
    readonly detail: string,
  ) {
    super(
      `adapter ${adapter} for provider ${provider} is not qualified: ${detail} ` +
        '(R-008-3: a billable call requires the latest provider_qualification row to pass)',
    );
    this.name = 'ProviderNotQualifiedError';
  }
}

/**
 * The gate. The worker calls this before issuing a billable call; it throws
 * rather than returning false so a forgotten check cannot be defaulted to "allow".
 */
export async function assertLatestQualificationPassed(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<ProviderQualificationRow> {
  const row = await latestQualification(db, provider, adapter);
  if (row === null) {
    throw new ProviderNotQualifiedError(provider, adapter, 'no qualification has been recorded');
  }
  if (!row.passed) {
    throw new ProviderNotQualifiedError(
      provider,
      adapter,
      `the newest record (${row.id}, ${row.run_at.toISOString()}) failed`,
    );
  }
  return row;
}
