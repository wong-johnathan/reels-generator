/**
 * Versioned schema validation and the R-004 retry ceiling — US-014, and the gate
 * US-017/US-018 rely on.
 *
 * R-004-1: topic/script/storyboard outputs validate against versioned schemas.
 * R-004-2: invalid output is retried **at most 3 times**; on the 3rd consecutive
 * failure the job stops before any billable stage and the UI is given the failing
 * field name, the schema version and the retry count.
 *
 * Two decisions are deliberate:
 *
 * - **The version authority is B-04's registry, not a copy.** `DOCUMENT_SCHEMAS`
 *   is `TEXT_SCHEMAS` from `src/adapters/text-schemas.ts`, the module that also
 *   declares the schemas to the provider and fingerprints them for
 *   qualification. Two registries would let the worker and the qualification gate
 *   disagree about what "script.v1" means.
 * - **Success is the only way to obtain a document.** The failure branch carries
 *   no document and `billable_downstream_calls: 0`, so no caller can enqueue
 *   IM/NA/… from a malformed payload. That is what "stops before any billable
 *   stage" is made of here; the three failed text attempts are themselves billed
 *   calls recorded as separate `generation_run` rows (TECH_DESIGN §5.5, R-012-4),
 *   which is why the surfaced copy says *downstream*.
 *
 * Ceiling reading: R-004-2 says "retried at most 3 times", while UI_SPEC §6 (S-10
 * states) renders "schema attempt 2 of 3" and "3 of 3" and §8 gives the copy
 * "could not be generated in the required schema after 3 attempts". Three total
 * attempts is the reading that satisfies both, and it matches B-08's three-attempt
 * ceiling for transport retries, so one job never exceeds three failed calls of
 * either kind.
 */
import { ZodError } from 'zod';

import { TEXT_SCHEMAS } from '../adapters/text-schemas.js';
import {
  PRODUCING_STAGE_CODES,
  STAGE_LABELS,
  STAGE_ORDER,
  type StageCode,
} from '../shared/stages.js';

/** R-004-2's ceiling: three attempts, and it cannot be raised by a caller. */
export const MAX_SCHEMA_ATTEMPTS = 3;

/**
 * What the harness needs from a schema. Structurally satisfied by B-04's
 * `TextSchema`, so the registry needs no adapter.
 */
export interface VersionedDocumentSchema<Out = unknown> {
  readonly name: string;
  readonly version: string;
  readonly stage: StageCode;
  parse(value: unknown): Out;
}

/** The three versioned text-stage schemas, keyed by document name. */
export const DOCUMENT_SCHEMAS = TEXT_SCHEMAS;

export interface SchemaFieldIssue {
  /** Dotted path, e.g. `ending` or `scenes[2].image_prompt`. */
  readonly field: string;
  /** zod issue code (`invalid_type`, `too_small`, `invalid_format`, …). */
  readonly code: string;
  readonly message: string;
}

/** The record R-004-2 asks the UI to show. `retry_count` is attempts made. */
export interface ValidationFailure {
  readonly code: 'schema_invalid';
  readonly stage: StageCode;
  readonly schema_name: string;
  readonly schema_version: string;
  readonly attempt_no: number;
  /** Attempts made so far, 1-based; equals `attempt_no` (every prior attempt failed). */
  readonly retry_count: number;
  readonly consecutive_failures: number;
  readonly max_attempts: number;
  /** First failing field, or `(document)` for a whole-document rejection. */
  readonly failing_field: string;
  readonly field_errors: readonly SchemaFieldIssue[];
  /** Producing stages after the failed one that will not run. Gates are excluded. */
  readonly blocked_stages: readonly StageCode[];
  /** Structural: a failure branch never runs a downstream billable stage. */
  readonly billable_downstream_calls: 0;
}

export interface SchemaFailureSurface {
  readonly failing_field: string;
  readonly schema_version: string;
  readonly retry_count: number;
  readonly max_attempts: number;
  /** Sentence for the blocking panel (UI_SPEC §8, R-004-2). */
  readonly message: string;
}

export type AttemptValidation<Out> =
  | {
      readonly ok: true;
      readonly document: Out;
      readonly attempt_no: number;
      readonly schema_name: string;
      readonly schema_version: string;
    }
  | { readonly ok: false; readonly failure: ValidationFailure };

export type ValidationOutcome<Out> =
  | {
      readonly ok: true;
      readonly document: Out;
      readonly schema_version: string;
      readonly attempts: number;
      readonly failures: readonly ValidationFailure[];
    }
  | {
      readonly ok: false;
      readonly failure: ValidationFailure;
      readonly failures: readonly ValidationFailure[];
    };

export interface ValidateWithRetryDeps<Out> {
  readonly schema: VersionedDocumentSchema<Out>;
  /**
   * One generation call. Each invocation is a new committed run (B-08): a schema
   * failure is never an in-place HTTP retry, so the attempt number is passed for
   * `generation_run.attempt_no` and the adapter's own `attempt` bookkeeping.
   */
  generate(attemptNo: number): Promise<unknown>;
  /** Called after each invalid payload (persist `schema_version`, drive the counter). */
  onInvalid?(failure: ValidationFailure): void | Promise<void>;
  /** May lower the ceiling; values above `MAX_SCHEMA_ATTEMPTS` are rejected. */
  readonly maxAttempts?: number;
}

/** Transport/contract errors from `generate` propagate untouched — that is B-08's policy. */
function fieldPathOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(document)';
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else if (result === '') {
      result = String(segment);
    } else {
      result += `.${String(segment)}`;
    }
  }
  return result;
}

/** The producing stages strictly after `stage`, in pipeline order. */
export function blockedStagesAfter(stage: StageCode): readonly StageCode[] {
  return PRODUCING_STAGE_CODES.filter((code) => STAGE_ORDER[code] > STAGE_ORDER[stage]);
}

function failureFor(
  schema: VersionedDocumentSchema<unknown>,
  issues: readonly SchemaFieldIssue[],
  attemptNo: number,
): ValidationFailure {
  return {
    code: 'schema_invalid',
    stage: schema.stage,
    schema_name: schema.name,
    schema_version: schema.version,
    attempt_no: attemptNo,
    retry_count: attemptNo,
    consecutive_failures: attemptNo,
    max_attempts: MAX_SCHEMA_ATTEMPTS,
    failing_field: issues[0]?.field ?? '(document)',
    field_errors: issues,
    blocked_stages: blockedStagesAfter(schema.stage),
    billable_downstream_calls: 0,
  };
}

/**
 * Validate one payload against one versioned schema. A non-zod throw (a bug or a
 * provider error) is rethrown rather than reported as a schema failure.
 */
export function validateAttempt<Out>(
  schema: VersionedDocumentSchema<Out>,
  payload: unknown,
  attemptNo = 1,
): AttemptValidation<Out> {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new RangeError(`attempt number must be a positive integer, got ${String(attemptNo)}`);
  }

  try {
    return {
      ok: true,
      document: schema.parse(payload),
      attempt_no: attemptNo,
      schema_name: schema.name,
      schema_version: schema.version,
    };
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issues: SchemaFieldIssue[] = error.issues.map((issue) => ({
      field: fieldPathOf(issue.path),
      code: issue.code,
      message: issue.message,
    }));
    return { ok: false, failure: failureFor(schema, issues, attemptNo) };
  }
}

/**
 * Drive schema generation up to the ceiling. Returns the first valid document, or
 * the third consecutive failure — never a partial document.
 */
export async function validateWithRetry<Out>(
  deps: ValidateWithRetryDeps<Out>,
): Promise<ValidationOutcome<Out>> {
  const maxAttempts = deps.maxAttempts ?? MAX_SCHEMA_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_SCHEMA_ATTEMPTS) {
    throw new RangeError(
      `maxAttempts must be an integer 1..${MAX_SCHEMA_ATTEMPTS} (R-004-2), got ${String(maxAttempts)}`,
    );
  }

  const failures: ValidationFailure[] = [];
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
    const payload = await deps.generate(attemptNo);
    const outcome = validateAttempt(deps.schema, payload, attemptNo);
    if (outcome.ok) {
      return {
        ok: true,
        document: outcome.document,
        schema_version: outcome.schema_version,
        attempts: attemptNo,
        failures,
      };
    }
    failures.push(outcome.failure);
    await deps.onInvalid?.(outcome.failure);
  }

  const failure = failures[failures.length - 1];
  if (failure === undefined) {
    // Unreachable: the loop runs at least once and every iteration either returns
    // a document or appends a failure.
    throw new Error('validateWithRetry produced neither a document nor a failure');
  }
  return { ok: false, failure, failures };
}

/** The exact strings R-004-2 requires: failing field, schema version, retry count. */
export function surfacingFor(failure: ValidationFailure): SchemaFailureSurface {
  const subject = STAGE_LABELS[failure.stage].toLowerCase();
  const attemptWord = failure.max_attempts === 1 ? 'attempt' : 'attempts';
  return {
    failing_field: failure.failing_field,
    schema_version: failure.schema_version,
    retry_count: failure.retry_count,
    max_attempts: failure.max_attempts,
    message:
      `The ${subject} could not be generated in the required schema after ` +
      `${failure.max_attempts} ${attemptWord}. ` +
      `Failing field: ${failure.failing_field}. ` +
      `Schema version: ${failure.schema_version}. ` +
      `Retry ${failure.retry_count} of ${failure.max_attempts}. ` +
      'No downstream billable stage ran.',
  };
}

/** For callers that prefer an exception to a discriminated result. */
export class SchemaRetryExhaustedError extends Error {
  constructor(readonly failure: ValidationFailure) {
    super(surfacingFor(failure).message);
    this.name = 'SchemaRetryExhaustedError';
  }
}
