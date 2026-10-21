/**
 * M-003 — execution ledger: the structural home of R-012-1 (TECH_DESIGN §3.5).
 *
 * Tables: job, job_attempt, generation_run.
 *
 * `generation_run` is the cost/debug row for exactly one provider call. It is
 * written *before* the call, in the same transaction as its `job_attempt`, so
 * the id exists and is committed before any adapter can open a socket. The
 * guard that enforces the ordering is `src/domain/generation-run.ts`.
 *
 * `asset_id` is added in M-004 (circular FK with `asset.generation_run_id`).
 */
export const M003_EXECUTION_SQL = /* sql */ `
-- ── job: the queue's durable mirror (TECH_DESIGN §3.2, §7.1) ─────────────────
CREATE TABLE job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  stage       text NOT NULL CHECK (stage IN ('T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX')),
  scene_id    uuid REFERENCES scene (id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority    int NOT NULL DEFAULT 0,
  retry_scope jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_project_stage ON job (project_id, stage);
CREATE INDEX idx_job_status ON job (status);

-- ── job_attempt: one queue execution of a job (R-011-2 retry ledger) ─────────
CREATE TABLE job_attempt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES job (id) ON DELETE CASCADE,
  attempt_no    int NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'timed_out', 'unknown_charge', 'cancelled')),
  worker_id     text,
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  error_class   text CHECK (error_class IN ('transient', 'non_retryable')),
  error_message text,
  http_status   int,
  backoff_s     int CHECK (backoff_s IS NULL OR backoff_s IN (1, 4, 16)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_attempt_job_attempt_no_key UNIQUE (job_id, attempt_no)
);
CREATE INDEX idx_ja_job ON job_attempt (job_id);

-- ── generation_run: one provider call (R-012, D2) ───────────────────────────
CREATE TABLE generation_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_attempt_id        uuid NOT NULL REFERENCES job_attempt (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  stage                 text NOT NULL CHECK (stage IN ('T', 'RS', 'SC', 'SB', 'IM', 'NA')),
  scene_id              uuid REFERENCES scene (id) ON DELETE CASCADE,
  provider              text,
  model                 text,
  prompt_hash           text NOT NULL,
  schema_version        text,
  provider_request_id   text,
  idempotency_key       text,
  idempotency_protected bool NOT NULL DEFAULT false,
  billed_units          numeric(14, 4),
  charge_status         text NOT NULL DEFAULT 'pending'
                          CHECK (charge_status IN ('pending', 'billed', 'unbilled', 'unknown')),
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'succeeded', 'failed', 'timed_out', 'unknown')),
  error_class           text CHECK (error_class IN ('transient', 'non_retryable')),
  http_status           int,
  attempt_no            int CHECK (attempt_no BETWEEN 1 AND 3),
  series_version_id     uuid REFERENCES series_version (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  ended_at              timestamptz,
  -- R-012-4: units are only ever charged against a 'billed' row.
  CONSTRAINT generation_run_billed_units_check
    CHECK (billed_units IS NULL OR billed_units <= 0 OR charge_status = 'billed'),
  -- R-012-4: a timeout that may have billed is 'unknown', never 'unbilled'.
  CONSTRAINT generation_run_timeout_charge_check
    CHECK (status <> 'timed_out' OR charge_status <> 'unbilled')
);
CREATE INDEX idx_gr_project ON generation_run (project_id);
CREATE INDEX idx_gr_job_attempt ON generation_run (job_attempt_id);
CREATE INDEX idx_gr_charge ON generation_run (charge_status);
`;
