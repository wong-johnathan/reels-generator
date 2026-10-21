/**
 * review_decision writes and reads — R-005, TECH_DESIGN 3.2 / 4.2.
 *
 * The operator gate and the staleness ledger share one table. The image stage
 * only reads it: the first-three checkpoint is released by an approve decision
 * for stage IM, and a reject without an edit re-opens the gate (R-005-4/OQ-3),
 * so the newest row is always the one that counts.
 */
import type { Queryable } from '../client.js';

export type ReviewDecisionKind =
  'approve' | 'reject' | 'accept_staleness' | 'acknowledge_unsourced';

export type ReviewStage = 'SC' | 'SB' | 'IM' | 'FA' | 'STALE';

export interface ReviewDecisionRow {
  readonly id: string;
  readonly project_id: string;
  readonly stage: ReviewStage;
  readonly decision: ReviewDecisionKind;
  readonly target_stage: string | null;
  readonly reason: string | null;
  readonly revision_at_decision: number | null;
  readonly decided_by: string | null;
  readonly decided_at: Date;
}

export const REVIEW_DECISION_COLUMNS =
  'id, project_id, stage, decision, target_stage, reason, revision_at_decision, ' +
  'decided_by, decided_at';

export interface NewReviewDecision {
  readonly projectId: string;
  readonly stage: ReviewStage;
  readonly decision: ReviewDecisionKind;
  /** Required when decision is 'reject' (R-005-4). */
  readonly targetStage?: string | null;
  /** Required when decision is 'reject' (R-005-4). */
  readonly reason?: string | null;
  readonly revisionAtDecision?: number | null;
  readonly decidedBy?: string | null;
  /** Defaults to the database clock; tests pin it to anchor a checkpoint. */
  readonly decidedAt?: Date;
}

export class ReviewDecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewDecisionValidationError';
  }
}

export async function recordReviewDecision(
  db: Queryable,
  input: NewReviewDecision,
): Promise<ReviewDecisionRow> {
  if (input.decision === 'reject' && (!input.targetStage || !input.reason)) {
    throw new ReviewDecisionValidationError(
      'a reject must name the return stage and its reason (R-005-4)',
    );
  }
  const result = await db.query<ReviewDecisionRow>(
    'INSERT INTO review_decision ' +
      '(project_id, stage, decision, target_stage, reason, revision_at_decision, decided_by, decided_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now())) ' +
      'RETURNING ' +
      REVIEW_DECISION_COLUMNS,
    [
      input.projectId,
      input.stage,
      input.decision,
      input.targetStage ?? null,
      input.reason ?? null,
      input.revisionAtDecision ?? null,
      input.decidedBy ?? null,
      input.decidedAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('review_decision insert returned no row');
  return row;
}

/** The newest approval for a gate, or null when the gate was never approved. */
export async function latestApproval(
  db: Queryable,
  projectId: string,
  stage: ReviewStage,
): Promise<ReviewDecisionRow | null> {
  const result = await db.query<ReviewDecisionRow>(
    'SELECT ' +
      REVIEW_DECISION_COLUMNS +
      " FROM review_decision WHERE project_id = $1 AND stage = $2 AND decision = 'approve' " +
      'ORDER BY decided_at DESC, id DESC LIMIT 1',
    [projectId, stage],
  );
  return result.rows[0] ?? null;
}
