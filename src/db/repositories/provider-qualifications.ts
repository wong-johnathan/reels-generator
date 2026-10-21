/**
 * `provider_qualification` — the recorded adapter qualification of R-008-3 /
 * TECH_DESIGN §5.6.
 *
 * "Each adapter has a recorded qualification check with a pass/fail result and
 * date, run before integration ... The worker refuses a billable call when the
 * adapter's latest record is not `passed`."
 *
 * "Latest" is the whole point of this repository: a pass is not a permanent
 * property of an adapter. A newer failing record must revoke the qualification,
 * so the read path orders by `run_at` and never asks "was there ever a pass?".
 */
import type { TtsQualificationEntry, TtsQualificationStore } from '../../adapters/tts.js';
import type { Queryable } from '../client.js';

export interface NewProviderQualification {
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
  /** Measurement time; defaults to the database clock. Set explicitly in tests/backfills. */
  readonly runAt?: Date;
}

export interface ProviderQualificationRow {
  readonly id: string;
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
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
  return row;
}

/** The newest measurement for a provider+adapter pair, or `null` if it never ran. */
export async function latestQualification(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<ProviderQualificationRow | null> {
  const result = await db.query<ProviderQualificationRow>(
    `SELECT ${COLUMNS} FROM provider_qualification
      WHERE provider = $1 AND adapter = $2
      ORDER BY run_at DESC, id DESC
      LIMIT 1`,
    [provider, adapter],
  );
  return result.rows[0] ?? null;
}

/**
 * The billable-call gate. Fails closed: no record, or a newest record that did
 * not pass, means "not qualified" (R-008-3). The worker calls this before any
 * TTS/image call; a refusal is surfaced, never silently downgraded.
 */
export async function isAdapterQualified(
  db: Queryable,
  provider: string,
  adapter: string,
): Promise<boolean> {
  const latest = await latestQualification(db, provider, adapter);
  return latest?.passed === true;
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
