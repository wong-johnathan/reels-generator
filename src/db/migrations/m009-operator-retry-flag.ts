/**
 * M-009 — the retry *intent* lives on the job, not in a pre-made attempt row.
 *
 * The first cut of D-H had `regenerate` insert the next `job_attempt` itself, then
 * queue the job. That produced two failures at once:
 *
 *   1. the orchestrator allocates `max(attempt_no) + 1`, so it read one past the row
 *      regenerate had just written (4 became 5) and refused the dispatch as
 *      "attempt budget exhausted" — every Regenerate after the third automatic
 *      attempt was a silent no-op;
 *   2. the row it wrote stayed `pending` with no run attached, which is exactly the
 *      state `refuseReissueOfPendingRuns` treats as "another worker may be billing".
 *
 * So the operator's intent is recorded on the job and consumed when the attempt is
 * actually opened. The marker is the audit trail for who asked, and `triggered_kind`
 * on the attempt is derived from it in the same statement that clears it.
 *
 * No backfill: no job carries a pending operator retry at migration time.
 */

export const M009_OPERATOR_RETRY_FLAG_SQL = /* sql */ `
ALTER TABLE job
  ADD COLUMN IF NOT EXISTS operator_retry_at timestamptz;

ALTER TABLE job
  ADD COLUMN IF NOT EXISTS operator_retry_by uuid REFERENCES operator (id);
`;
