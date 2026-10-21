/**
 * Provider error taxonomy — TECH_DESIGN §5.1, R-011-2, R-012-4.
 *
 * The adapter classifies; it never retries. Backoff (1 s / 4 s / 16 s, three
 * attempts) and the `job_attempt` bookkeeping live in `src/workers/attempt.ts`
 * (B-08), so the same classification is reused by every adapter in
 * `src/adapters/**` rather than re-derived per provider.
 *
 * Cost safety drives two of the choices below:
 * - a timeout is `transient` but `mayHaveBilled` (R-012-4: record 'unknown',
 *   never reissue automatically — TECH_DESIGN §5.5);
 * - a schema-invalid or malformed response is `non_retryable` at the provider
 *   layer, because the call succeeded and billed. R-004-2's 3-attempt ceiling
 *   re-generates as a *new* `generation_run` (B-09), which is correct cost
 *   accounting, not an in-place HTTP retry.
 */

/** The only two values `generation_run.error_class` / `job_attempt.error_class` admit. */
export type ProviderErrorClass = 'transient' | 'non_retryable';

/** R-011-2: 429 and 5xx are worth retrying; every other 4xx (including auth) is not. */
export function classifyHttpStatus(status: number): ProviderErrorClass {
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'non_retryable';
}

export interface ProviderErrorOptions {
  readonly provider: string;
  readonly errorClass: ProviderErrorClass;
  readonly code: string;
  readonly httpStatus?: number | null;
  readonly providerRequestId?: string | null;
  readonly mayHaveBilled?: boolean;
  readonly cause?: unknown;
}

/** Base class: everything a caller needs to record an attempt row, and nothing secret. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly errorClass: ProviderErrorClass;
  readonly code: string;
  readonly httpStatus: number | null;
  readonly providerRequestId: string | null;
  /** True when the request may have reached (and billed at) the provider. */
  readonly mayHaveBilled: boolean;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.errorClass = options.errorClass;
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? null;
    this.providerRequestId = options.providerRequestId ?? null;
    this.mayHaveBilled = options.mayHaveBilled ?? false;
  }
}

export interface ProviderHttpErrorInput {
  readonly provider: string;
  readonly httpStatus: number;
  readonly providerRequestId?: string | null;
  readonly detail?: string;
}

/** A non-2xx provider response. The body is summarised, never echoed wholesale. */
export class ProviderHttpError extends ProviderError {
  constructor(input: ProviderHttpErrorInput) {
    const detail = input.detail ? `: ${input.detail}` : '';
    super(
      `${input.provider} answered HTTP ${input.httpStatus}${detail} (${classifyHttpStatus(input.httpStatus)})`,
      {
        provider: input.provider,
        errorClass: classifyHttpStatus(input.httpStatus),
        code: 'http_error',
        httpStatus: input.httpStatus,
        providerRequestId: input.providerRequestId ?? null,
        // A non-2xx response is a completed exchange that was not billed by any
        // of the three providers (they bill on 200 only, TECH_DESIGN §5.2).
        mayHaveBilled: false,
      },
    );
    this.name = 'ProviderHttpError';
  }
}

/**
 * The request was aborted at the configured timeout (R-008-1).
 *
 * `mayHaveBilled` is true: the worker must mark the run's charge `unknown`
 * (R-012-4) and surface it for an operator decision rather than reissuing.
 */
export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, timeoutMs: number, cause?: unknown) {
    super(`${provider} did not answer within ${timeoutMs} ms`, {
      provider,
      errorClass: 'transient',
      code: 'timeout',
      mayHaveBilled: true,
      cause,
    });
    this.name = 'ProviderTimeoutError';
  }
}

/** A transport failure before a response was received. */
export class ProviderNetworkError extends ProviderError {
  constructor(provider: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`${provider} request failed in transport: ${causeMessage}`, {
      provider,
      errorClass: 'transient',
      code: 'network',
      mayHaveBilled: false,
      cause,
    });
    this.name = 'ProviderNetworkError';
  }
}

/** The envelope was not the documented chat-completion shape (no id, no content, …). */
export class ProviderResponseError extends ProviderError {
  constructor(provider: string, detail: string) {
    super(`${provider} returned a response the adapter cannot use: ${detail}`, {
      provider,
      errorClass: 'non_retryable',
      code: 'response_invalid',
      mayHaveBilled: true,
    });
    this.name = 'ProviderResponseError';
  }
}

/**
 * The returned document did not validate against its versioned schema (R-004-1).
 *
 * Field paths and codes only: R-004-2 needs the failing field name, the schema
 * version and the retry count, and the model's content must not leak into logs.
 */
export class ProviderSchemaError extends ProviderError {
  readonly schemaVersion: string;
  readonly fieldErrors: readonly string[];

  constructor(provider: string, schemaVersion: string, fieldErrors: readonly string[]) {
    super(
      `${provider} output does not match ${schemaVersion}: ${fieldErrors.join('; ') || 'no detail'}`,
      {
        provider,
        errorClass: 'non_retryable',
        code: 'schema_invalid',
        mayHaveBilled: true,
      },
    );
    this.name = 'ProviderSchemaError';
    this.schemaVersion = schemaVersion;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * B-06 image-adapter failure vocabulary. B-04 (text/TTS) ships the richer
 * ProviderError hierarchy above; B-05/B-06 independently shipped
 * ProviderRequestError for the same facts. Both batches are merged here so one
 * module is the single error surface (INT-01 converges the duplicate).
 * ProviderFailureClass is an alias of B-04's ProviderErrorClass: identical
 * values, and a second spelling must not become a second vocabulary.
 */
export type ProviderFailureClass = ProviderErrorClass;

export interface ProviderRequestErrorOptions {
  readonly failureClass: ProviderFailureClass;
  readonly httpStatus?: number;
  readonly billedUnknown: boolean;
  /** From Retry-After, when present. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ProviderRequestError extends Error {
  readonly failureClass: ProviderFailureClass;
  readonly httpStatus: number | undefined;
  readonly billedUnknown: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ProviderRequestErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderRequestError';
    this.failureClass = options.failureClass;
    this.httpStatus = options.httpStatus;
    this.billedUnknown = options.billedUnknown;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Retry-After is delta-seconds or an HTTP-date (RFC 9110 10.2.3). Returns
 * milliseconds, or undefined when the header is absent or unusable.
 */
export function parseRetryAfter(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  if (/^[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1_000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}
