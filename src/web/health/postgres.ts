/**
 * Postgres-backed `OpsGateway`.
 *
 * Health and settings report only what a `pg` Pool can actually see: the
 * migration ledger, the queue's durable `job` mirror, and the provider
 * qualification ledger. Redis, MinIO and disk are worker-owned and are reported
 * `unknown` (not guessed). Provider keys are environment facts, not columns, so
 * `key_present` is read from the process environment — it is an environment fact,
 * not a database column, and reporting it as false when the key is configured
 * turns a healthy stack into an alarming one. R-012-2 means `idempotency_protected` is
 * false — the adapter states this instead of inventing a key or a default
 * model name.
 *
 * Attempt rows are one row per provider call: `generation_run` (the R-012-1
 * cost/debug row) joined to its `job_attempt` for the retry number and status.
 * `max_attempts` is the R-011-2 cap of three; there is no per-job column.
 */
import type { Pool } from 'pg';

import { MIGRATIONS } from '../../db/migrations/index.js';
import { PROVIDER_NAMES } from '../../shared/states.js';

/**
 * Provider → environment variable holding its credential.
 *
 * The settings page exists to answer one question: can this stack call its
 * vendors? The answer lives in the environment, not in Postgres, so it is read
 * here. A missing entry means the provider has no single-key credential.
 */
const PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
};

export interface OpsGatewayOptions {
  /** Injected for tests; production reads the process environment. */
  readonly keyPresent?: (envKey: string) => boolean;
}

/**
 * Does this provider have a credential in the environment?
 *
 * Exported as a pure function so the mapping is testable without a database:
 * the settings page is the only thing that reports this, and getting it wrong
 * either alarms a healthy stack or hides a broken one.
 */
export function providerKeyConfigured(
  provider: string,
  keyPresent: (envKey: string) => boolean,
): boolean {
  const envKey = PROVIDER_ENV_KEYS[provider];
  return envKey === undefined ? false : keyPresent(envKey);
}

function readProcessKey(envKey: string): boolean {
  const value = process.env[envKey];
  return value !== undefined && value.trim().length > 0;
}
import type {
  AttemptRow,
  AttemptsQuery,
  HealthReport,
  OpsGateway,
  ProviderSettingsView,
} from './gateway.js';

const MAX_ATTEMPTS = 3;

interface AttemptRowResult {
  readonly id: string;
  readonly stage: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly provider_request_id: string | null;
  readonly prompt_hash: string;
  readonly idempotency_protected: boolean;
  readonly charge_status: string;
  readonly attempt_status: string;
  readonly error_class: string | null;
  readonly http_status: number | null;
  readonly attempt_no: number;
  readonly backoff_s: number | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
}

export interface PostgresOpsOptions {
  /** Test hook for `health().checked_at`. Defaults to the wall clock. */
  readonly now?: () => number;
}

export function createPostgresOpsGateway(
  pool: Pool,
  options: PostgresOpsOptions & OpsGatewayOptions = {},
): OpsGateway {
  const now = options.now ?? ((): number => Date.now());
  const keyPresent = options.keyPresent ?? readProcessKey;
  const keyConfigured = (provider: string): boolean => providerKeyConfigured(provider, keyPresent);

  async function providerRows(): Promise<Map<string, { passed: boolean; run_at: Date }>> {
    const result = await pool.query<{ provider: string; passed: boolean; run_at: Date }>(
      `SELECT DISTINCT ON (provider) provider, passed, run_at
         FROM provider_qualification
        WHERE provider = ANY($1::text[])
        ORDER BY provider, run_at DESC, id DESC`,
      [[...PROVIDER_NAMES]],
    );
    return new Map(result.rows.map((row) => [row.provider, row]));
  }

  async function migrationSummary(): Promise<{
    status: 'up_to_date' | 'pending';
    version: string | null;
  }> {
    const ledger = await pool.query<{ id: string }>('SELECT id FROM schema_migration ORDER BY id');
    const applied = new Set(ledger.rows.map((row) => row.id));
    let version: string | null = null;
    let pending = false;
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) version = migration.id;
      else pending = true;
    }
    return { status: pending ? 'pending' : 'up_to_date', version };
  }

  async function queueCounts(): Promise<{ waiting: number; active: number; failed: number }> {
    const result = await pool.query<{ waiting: number; active: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS waiting,
              count(*) FILTER (WHERE status = 'running')::int AS active,
              count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM job`,
    );
    const row = result.rows[0];
    return {
      waiting: row?.waiting ?? 0,
      active: row?.active ?? 0,
      failed: row?.failed ?? 0,
    };
  }

  return {
    async health(): Promise<HealthReport> {
      const [migration, providers, queue] = await Promise.all([
        migrationSummary(),
        providerRows(),
        queueCounts(),
      ]);

      const providerViews = PROVIDER_NAMES.map((provider) => {
        const qualification = providers.get(provider);
        return {
          provider,
          key_present: keyConfigured(provider),
          qualified: qualification?.passed ?? false,
          qualified_at: qualification?.run_at.toISOString() ?? null,
          idempotency_protected: false,
          note: null,
        };
      });

      return {
        ready: true,
        service: 'web',
        checked_at: new Date(now()).toISOString(),
        migration,
        components: [
          { name: 'postgres', status: 'ok', detail: 'connected' },
          {
            name: 'migration',
            status: migration.status === 'up_to_date' ? 'ok' : 'degraded',
            detail:
              migration.status === 'up_to_date' ? (migration.version ?? 'up to date') : 'pending',
          },
          {
            name: 'queue',
            status: queue.failed > 0 ? 'degraded' : 'ok',
            detail:
              'waiting ' +
              queue.waiting +
              ' · active ' +
              queue.active +
              ' · failed ' +
              queue.failed,
          },
          {
            name: 'redis',
            status: 'unknown',
            detail: 'not queryable from the page gateway (no Redis client)',
          },
          {
            name: 'minio',
            status: 'unknown',
            detail: 'not queryable from the page gateway (no object-store client)',
          },
          {
            name: 'disk',
            status: 'unknown',
            detail: 'worker-owned; not queryable from the page gateway',
          },
        ],
        providers: providerViews,
        queue,
        disk: null,
        degraded_reasons:
          migration.status === 'pending'
            ? ['migrations pending — the schema is not up to date']
            : [],
      };
    },

    async settings(): Promise<ProviderSettingsView> {
      const providers = await providerRows();
      return {
        read_only: true,
        key_values_exposed: false,
        providers: PROVIDER_NAMES.map((provider) => {
          const qualification = providers.get(provider);
          return {
            provider,
            key_present: keyConfigured(provider),
            qualified: qualification?.passed ?? false,
            qualified_at: qualification?.run_at.toISOString() ?? null,
            idempotency_protected: false,
            note: null,
          };
        }),
      };
    },

    async attempts(videoId: string, query: AttemptsQuery): Promise<AttemptRow[]> {
      const result = await pool.query<AttemptRowResult>(
        `SELECT gr.id, gr.stage, gr.provider, gr.model, gr.provider_request_id, gr.prompt_hash,
                gr.idempotency_protected, gr.charge_status, gr.error_class, gr.http_status,
                gr.created_at, gr.started_at, gr.ended_at,
                ja.attempt_no, ja.status AS attempt_status, ja.backoff_s
           FROM generation_run gr
           JOIN job_attempt ja ON ja.id = gr.job_attempt_id
          WHERE gr.project_id = $1 AND ($2::text IS NULL OR gr.stage = $2)
          ORDER BY gr.created_at DESC, gr.id DESC
          LIMIT $3`,
        [videoId, query.stage, query.limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        stage: row.stage as AttemptRow['stage'],
        provider: row.provider ?? '',
        model: row.model ?? '',
        provider_request_id: row.provider_request_id,
        prompt_hash: row.prompt_hash,
        idempotency_protected: row.idempotency_protected,
        charge_status: row.charge_status as AttemptRow['charge_status'],
        status: row.attempt_status as AttemptRow['status'],
        error_class: row.error_class as AttemptRow['error_class'],
        http_status: row.http_status,
        attempt_no: row.attempt_no,
        max_attempts: MAX_ATTEMPTS,
        backoff_s: row.backoff_s,
        created_at: row.created_at.toISOString(),
        started_at: row.started_at?.toISOString() ?? null,
        ended_at: row.ended_at?.toISOString() ?? null,
      }));
    },
  };
}
