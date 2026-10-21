/**
 * Row shapes for the tables B-02 owns the write path of.
 *
 * These mirror the DDL exactly (snake_case, `timestamptz` → `Date`, `numeric`
 * → string because pg does not parse numerics into JS numbers without loss).
 * Domain modules map them; nothing here depends on the domain layer.
 */

export interface GenerationRunRow {
  readonly id: string;
  readonly job_attempt_id: string;
  readonly project_id: string;
  readonly stage: string;
  readonly scene_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_hash: string;
  readonly schema_version: string | null;
  readonly provider_request_id: string | null;
  readonly idempotency_key: string | null;
  readonly idempotency_protected: boolean;
  readonly billed_units: string | null;
  readonly charge_status: string;
  readonly status: string;
  readonly error_class: string | null;
  readonly http_status: number | null;
  readonly attempt_no: number | null;
  readonly series_version_id: string | null;
  readonly asset_id: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
}

export interface JobAttemptRow {
  readonly id: string;
  readonly job_id: string;
  readonly attempt_no: number;
  readonly status: string;
  readonly worker_id: string | null;
  readonly started_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly finished_at: Date | null;
  readonly error_class: string | null;
  readonly error_message: string | null;
  readonly http_status: number | null;
  readonly backoff_s: number | null;
  readonly created_at: Date;
}
