/**
 * `generation_run` writes — one row per provider call (R-012-1, D2).
 *
 * Only `src/domain/generation-run.ts` should insert here: the row must be
 * committed before an adapter executes, and that ordering is the domain
 * module's job. These helpers are transaction-agnostic on purpose.
 */
import type { Queryable } from '../client.js';
import type { GenerationRunRow } from './types.js';

export interface NewGenerationRun {
  readonly jobAttemptId: string;
  readonly projectId: string;
  readonly stage: string;
  readonly sceneId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly promptHash: string;
  readonly schemaVersion?: string | null;
  readonly idempotencyKey?: string | null;
  readonly attemptNo?: number | null;
  readonly seriesVersionId?: string | null;
}

const COLUMNS = /* sql */ `
  id, job_attempt_id, project_id, stage, scene_id, provider, model, prompt_hash,
  schema_version, provider_request_id, idempotency_key, idempotency_protected,
  billed_units, charge_status, status, error_class, http_status, attempt_no,
  series_version_id, asset_id, created_at, started_at, ended_at
`;

/**
 * Insert the `pending`/`pending` cost row. `idempotency_protected` stays at its
 * column default `false`: none of the three providers honours a key (R-012-2,
 * TECH_DESIGN §5.5), so the ≤1-billable guarantee is the commit-before-call
 * rule rather than provider-side idempotency.
 */
export async function insertPendingRun(
  db: Queryable,
  input: NewGenerationRun,
): Promise<GenerationRunRow> {
  const result = await db.query<GenerationRunRow>(
    `INSERT INTO generation_run
       (job_attempt_id, project_id, stage, scene_id, provider, model, prompt_hash,
        schema_version, idempotency_key, attempt_no, series_version_id,
        status, charge_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 'pending')
     RETURNING ${COLUMNS}`,
    [
      input.jobAttemptId,
      input.projectId,
      input.stage,
      input.sceneId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.promptHash,
      input.schemaVersion ?? null,
      input.idempotencyKey ?? null,
      input.attemptNo ?? null,
      input.seriesVersionId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('generation_run insert returned no row');
  return row;
}

export async function findGenerationRunById(
  db: Queryable,
  id: string,
): Promise<GenerationRunRow | null> {
  const result = await db.query<GenerationRunRow>(
    `SELECT ${COLUMNS} FROM generation_run WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
