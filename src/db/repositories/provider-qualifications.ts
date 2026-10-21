/**
 * `provider_qualification` — the recorded adapter qualification of R-008-3 /
 * TECH_DESIGN §5.6.
 *
 * Written by each adapter's `qualify()`; read by the gate before a billable call.
 * The newest row per (provider, adapter) is the verdict: a failed row and an
 * absent row both refuse the call, so a regression cannot be "forgotten" by
 * simply not re-running qualification.
 *
 * `run_at` defaults to `clock_timestamp()` rather than the column's `now()`
 * default: `now()` is the transaction-start time, so two qualifications started
 * in quick succession could share a timestamp and make "latest" ambiguous.
 *
 * B-09 merge note: B-04 and B-07 each landed a module at this path (flagged as an
 * INT-01 hotspot). This is the union of both, with the read/write semantics
 * unchanged for each caller. One home for the qualification rows, not two.
 */
import type { TtsQualificationEntry, TtsQualificationStore } from '../../adapters/tts.js';
import type { Queryable } from '../client.js';

export interface NewProviderQualification {
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  /** Serialised into `jsonb`. Must never contain a credential (R-015-5). */
  readonly details: Record<string, unknown>;
  /** Measurement time; defaults to the database clock. Set explicitly in tests/backfills. */
  readonly runAt?: Date;
}

export interface ProviderQualificationRow {
  readonly id: string;
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  /** `jsonb` as the driver returns it: an object, not a string. */
  readonly details: unknown;
  readonly run_at: Date;
}

const COLUMNS = /* sql */ `id, provider, adapter, passed, details, run_at`;

/** Append one measurement. Rows are never updated: the history is the audit trail. */
export async function insertQualification(
  db: Queryable,
  input: NewProviderQualification,
): Promise<ProviderQualificationRow> {
  const result = await db.query<ProviderQualificationRow>(
    `INSERT INTO provider_qualification (provider, adapter, passed, details, run_at)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, clock_timestamp()))
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

/** Boolean form of the gate, for callers that need a value rather than a throw. */
export async function isAdapterQualified(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<boolean> {
  const latest = await latestQualification(db, provider, adapter);
  return latest?.passed === true;
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

/** `TtsQualificationStore` over Postgres — what `qualify()` writes through. */
export class PostgresQualificationStore implements TtsQualificationStore {
  constructor(private readonly db: Queryable) {}

  async record(entry: TtsQualificationEntry): Promise<void> {
    await insertQualification(this.db, {
      provider: entry.provider,
      adapter: entry.adapter,
      passed: entry.passed,
      details: entry.details,
    });
  }
}
