/**
 * The numbered, forward-only migration set (R-017-2, TECH_DESIGN §9.3).
 *
 * Order is the array order and each `id` is recorded in `schema_migration` with
 * a sha256 of its SQL. Migrations are additive and independently deployable;
 * the R-017-3 backward-compatibility rule binds *future* migrations (additive
 * columns/tables only — a structural change is restore-from-backup).
 *
 * The SQL lives in TypeScript modules rather than `.sql` assets so the compiled
 * `dist/` tree is self-contained: the migrate one-shot runs from the ops/worker
 * image with no asset-copy step.
 */
import { M001_FOUNDATION_SQL } from './m001-foundation.js';
import { M002_CONTENT_SQL } from './m002-content.js';
import { M006_SERIES_VERSION_GUARDS_SQL } from './m006-series-version-guards.js';
import { M003_EXECUTION_SQL } from './m003-execution.js';
import { M004_ASSETS_SQL } from './m004-assets.js';
import { M005_STATE_GATES_SEED_SQL } from './m005-state-gates-seed.js';
import { M007_OBJECT_LAYOUT_SQL } from './m007-object-layout.js';
import { M008_OPERATOR_RETRY_SQL } from './m008-operator-retry.js';
import { M009_OPERATOR_RETRY_FLAG_SQL } from './m009-operator-retry-flag.js';
import { M010_GENERATION_RUN_ATTEMPT_SQL } from './m010-generation-run-attempt.js';

export interface Migration {
  /** Stable, sortable id recorded in `schema_migration` (e.g. `M-001`). */
  readonly id: string;
  /** One line for the migration log and `migrate status`. */
  readonly description: string;
  /** One or more SQL statements; applied in a single transaction. */
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 'M-001',
    description: 'foundation: extensions, operator, session, series, series_version, reference',
    sql: M001_FOUNDATION_SQL,
  },
  {
    id: 'M-002',
    description: 'content: batch, project, topic, source, script_revision, scene, claim',
    sql: M002_CONTENT_SQL,
  },
  {
    id: 'M-003',
    description: 'execution ledger: job, job_attempt, generation_run',
    sql: M003_EXECUTION_SQL,
  },
  {
    id: 'M-004',
    description: 'assets: asset, asset_ref and the reverse circular FK edges',
    sql: M004_ASSETS_SQL,
  },
  {
    id: 'M-005',
    description:
      'state, gates, seed: video_stage, review_decision, publication_log, invalidation_rule, provider_qualification',
    sql: M005_STATE_GATES_SEED_SQL,
  },
  {
    id: 'M-006',
    description:
      'series_version guards: strictly increasing version, immutable rows, current_version_id maintenance',
    sql: M006_SERIES_VERSION_GUARDS_SQL,
  },
  {
    id: 'M-007',
    description:
      'object layout: drop the content-addressed key CHECK and hash uniqueness, unique object_key (D-F)',
    sql: M007_OBJECT_LAYOUT_SQL,
  },
  {
    id: 'M-008',
    description:
      'operator retries: lift the 3-attempt cap to the worker policy and record who triggered an attempt (D-H)',
    sql: M008_OPERATOR_RETRY_SQL,
  },
  {
    id: 'M-009',
    description: 'operator retry intent lives on the job, consumed when the attempt opens (D-H)',
    sql: M009_OPERATOR_RETRY_FLAG_SQL,
  },
  {
    id: 'M-010',
    description:
      'generation_run accepts operator attempts past the ladder, matching job_attempt (D-I)',
    sql: M010_GENERATION_RUN_ATTEMPT_SQL,
  },
];
