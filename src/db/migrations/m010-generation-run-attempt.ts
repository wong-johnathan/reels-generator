/**
 * M-010 — operator retries past the ladder, for the run ledger too (D-I).
 *
 * M-008 moved R-011-2's three-attempt cap from the policy to the ledger for
 * `job_attempt`, so an operator's Regenerate could be recorded. It missed the
 * sibling table: `generation_run.attempt_no` kept `CHECK (attempt_no BETWEEN 1 AND 3)`,
 * so the fourth attempt opened its ledger row and the insert failed on the
 * constraint. From the outside that looked like a job dying two seconds after
 * Regenerate with no attempt row and no reason — the failure happened between the
 * commit-before-call write and the provider call.
 *
 * The two tables describe the same attempt and must agree. The cap is policy
 * (MAX_ATTEMPTS_PER_JOB, enforced by planRetry), not schema.
 *
 * No backfill: every existing row already satisfies `attempt_no >= 1`.
 */

export const M010_GENERATION_RUN_ATTEMPT_SQL = /* sql */ `
ALTER TABLE generation_run
  DROP CONSTRAINT IF EXISTS generation_run_attempt_no_check;

ALTER TABLE generation_run
  ADD CONSTRAINT generation_run_attempt_no_check CHECK (attempt_no >= 1);
`;
