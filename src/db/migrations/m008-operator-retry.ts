/**
 * M-008 — operator-initiated regeneration (D-H).
 *
 * R-011-2 gave a stage three automatic attempts: `job_attempt.attempt_no` was
 * CHECKed to 1..3, so a fourth execution could not be recorded at all. That is
 * right for the worker, which must never retry forever, but wrong for the
 * operator: pressing Regenerate on a failed batch is a deliberate human decision,
 * not another automatic attempt.
 *
 * The cap moves from the column to the policy. The worker still stops after three
 * automatic attempts; an operator-triggered attempt is recorded and distinguished
 * by `triggered_kind`, so the retry ledger stays honest about who asked.
 *
 * No backfill: every existing row is an automatic attempt, which is what the
 * DEFAULT says.
 */

export const M008_OPERATOR_RETRY_SQL = /* sql */ `
ALTER TABLE job_attempt
  DROP CONSTRAINT IF EXISTS job_attempt_attempt_no_check;

ALTER TABLE job_attempt
  ADD CONSTRAINT job_attempt_attempt_no_check CHECK (attempt_no >= 1);

ALTER TABLE job_attempt
  ADD COLUMN IF NOT EXISTS triggered_kind text NOT NULL DEFAULT 'automatic'
    CHECK (triggered_kind IN ('automatic', 'operator'));

ALTER TABLE job_attempt
  ADD COLUMN IF NOT EXISTS triggered_by uuid REFERENCES operator (id);
`;
