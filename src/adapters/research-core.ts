/**
 * Research adapter contract — TECH_DESIGN §5.2 (US-011 research, US-012 research qual).
 *
 * The frozen design shape is `search()` + `fetch()` over one `SourceResult`
 * vocabulary, with the acceptance gate `rerank_score >= 1.5` applied here and
 * not in the callers (QUALIFICATION §3, UX E-2/S-09, UI source picker).
 *
 * Every call takes a persisted-run reference. The value a worker can obtain is
 * B-02's `PersistedGenerationRun` (branded, commit proven on a fresh session by
 * `executePersisted`); the adapter narrows it to `{id, stage}` so no provider
 * socket can be reached from a request-shaped object alone (R-012-1).
 */
import type { ProviderStageCode } from '../domain/generation-run.js';
import { AdapterStageMismatchError } from '../domain/generation-run.js';
import type { RateLimiter } from './rate-limit.js';

/** The stage every research call belongs to (X-5: RS research/sources). */
export const RESEARCH_STAGE: ProviderStageCode = 'RS';

/** QUALIFICATION §3: "scores of 1.5 or above are considered high quality". */
export const RESEARCH_RERANK_THRESHOLD = 1.5;

/** TECH_DESIGN §5.2: `count` default 5 (the provider default of 10 is not used). */
export const RESEARCH_DEFAULT_COUNT = 5;

/** R-008-1: 30 s per search/fetch call. */
export const RESEARCH_TIMEOUT_MS = 30_000;

/** R-008-2 default, configurable through PROVIDER_RATE_LIMIT_PER_MIN. */
export const RESEARCH_RATE_LIMIT_PER_MIN = 10;

export type ResearchOperation = 'search' | 'fetch';
export type ResearchProviderId = 'deepseek' | 'gemini';
export type ResearchAdapterId = ResearchProviderId | 'fake';

/** TECH_DESIGN §5.1 vocabulary, shared by every adapter (consumed by B-08's retry loop). */
export type RetryClass = 'transient' | 'non_retryable';

export type ResearchCauseClass =
  'http' | 'network' | 'timeout' | 'malformed_response' | 'invalid_request' | 'unsupported';

/**
 * The persisted-run reference an adapter requires (R-012-1).
 *
 * Structurally a subset of B-02's \`PersistedGenerationRun\` (which is assignable
 * to it), but without the module-private commit brand: the adapter needs the id
 * and stage only, and the commit proof stays in \`executePersisted()\`.
 */
export interface ResearchRun {
  readonly id: string;
  readonly stage: ProviderStageCode;
}

/** One captured source, mirroring the `source` table (TECH_DESIGN §3.2). */
export interface SourceResult {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  /** The provider's model-oriented summary (600-800 characters). */
  readonly summary: string;
  /** Page body, present only when `need_content` was requested and returned. */
  readonly content?: string;
  /** RFC 3339 UTC, or null when the provider has no publication date. */
  readonly date?: string | null;
  /** DeepSeek rerank score 0-3; the fallback normalises its confidence to the same scale. */
  readonly rerank_score: number;
  readonly site_name?: string | null;
  /** DeepSeek authority tier 0-4 (-1 unknown); null when the provider has no equivalent. */
  readonly authority?: number | null;
}

export interface SearchRequest {
  readonly query: string;
  readonly count?: number;
  readonly need_content?: boolean;
  /** Optional original question, passed through where the provider supports it. */
  readonly ori_question?: string;
}

export interface FetchRequest {
  readonly url: string;
}

export interface SearchResponse {
  readonly results: readonly SourceResult[];
  /** R-008-4: recorded on the generation_run by the caller when present. */
  readonly provider_request_id: string | null;
}

export interface FetchResponse {
  readonly title: string;
  readonly content_markdown: string;
  readonly provider_request_id: string | null;
}

/**
 * The single research interface. Both the DeepSeek default and the Gemini
 * grounding fallback implement it; selecting between them is configuration,
 * not code (TECH_DESIGN §5.2, D7).
 */
export interface ResearchAdapter {
  readonly provider: ResearchAdapterId;
  readonly model: string | null;
  /** R-012-2: no current provider honours a client idempotency key. */
  readonly idempotencyProtected: false;
  readonly timeoutMs: number;
  readonly rateLimitPerMin: number;
  search(req: SearchRequest, run: ResearchRun): Promise<SearchResponse>;
  fetch(req: FetchRequest, run: ResearchRun): Promise<FetchResponse>;
}

export interface ResearchAdapterErrorOptions {
  readonly provider: string;
  readonly operation: ResearchOperation;
  readonly errorClass: RetryClass;
  readonly causeClass?: ResearchCauseClass;
  readonly httpStatus?: number | null;
  readonly providerRequestId?: string | null;
  readonly cause?: unknown;
}

/**
 * The only error type adapters throw for provider failures. It carries the
 * retry classification B-08 acts on, so no caller parses HTTP statuses again.
 */
export class ResearchAdapterError extends Error {
  readonly provider: string;
  readonly operation: ResearchOperation;
  readonly errorClass: RetryClass;
  readonly causeClass: ResearchCauseClass;
  readonly httpStatus: number | null;
  readonly providerRequestId: string | null;

  constructor(message: string, options: ResearchAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ResearchAdapterError';
    this.provider = options.provider;
    this.operation = options.operation;
    this.errorClass = options.errorClass;
    this.causeClass = options.causeClass ?? 'http';
    this.httpStatus = options.httpStatus ?? null;
    this.providerRequestId = options.providerRequestId ?? null;
  }
}

/** A request we refuse to send: bad query, bad count, unusable URL. */
export class ResearchRequestError extends ResearchAdapterError {
  constructor(
    message: string,
    options: Omit<ResearchAdapterErrorOptions, 'errorClass' | 'causeClass'>,
  ) {
    super(message, { ...options, errorClass: 'non_retryable', causeClass: 'invalid_request' });
    this.name = 'ResearchRequestError';
  }
}

/** A 2xx body that does not satisfy the documented schema. Fail closed. */
export class ResearchResponseError extends ResearchAdapterError {
  constructor(
    message: string,
    options: Omit<ResearchAdapterErrorOptions, 'errorClass' | 'causeClass'>,
  ) {
    super(message, { ...options, errorClass: 'non_retryable', causeClass: 'malformed_response' });
    this.name = 'ResearchResponseError';
  }
}

/** An operation the configured provider cannot perform at all. */
export class ResearchUnsupportedError extends ResearchAdapterError {
  constructor(
    message: string,
    options: Omit<ResearchAdapterErrorOptions, 'errorClass' | 'causeClass'>,
  ) {
    super(message, { ...options, errorClass: 'non_retryable', causeClass: 'unsupported' });
    this.name = 'ResearchUnsupportedError';
  }
}

/** A call attempted without a persisted `generation_run` (R-012-1). */
export class ResearchRunRequiredError extends Error {
  constructor(
    message = 'a research call requires a persisted generation_run: pass the run returned by openAttempt() (R-012-1)',
  ) {
    super(message);
    this.name = 'ResearchRunRequiredError';
  }
}

/** Misconfigured adapter selection; names the key, never a value. */
export class ResearchProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchProviderConfigError';
  }
}

/** TECH_DESIGN §5.1 classification: 429/5xx transient, other 4xx non-retryable. */
export function classifyHttpStatus(status: number): RetryClass | null {
  if (!Number.isInteger(status) || status < 100) return null;
  if (status >= 200 && status < 400) return null;
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'non_retryable';
}

/** True only for an absolute http(s) URL with a host. */
export function isHttpUrl(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The acceptance gate of TECH_DESIGN §3.2/§5.2: an accepted source has
 * `rerank_score >= 1.5` AND a non-empty resolvable-shaped URL. A NaN score is
 * rejected rather than allowed to slip through a comparison.
 */
export function isAcceptedSource(source: SourceResult): boolean {
  return (
    typeof source.rerank_score === 'number' &&
    Number.isFinite(source.rerank_score) &&
    source.rerank_score >= RESEARCH_RERANK_THRESHOLD &&
    isHttpUrl(source.url)
  );
}

/** Split provider order-preservingly: accepted are offered, rejected stay visible but greyed. */
export function partitionSources(results: readonly SourceResult[]): {
  readonly accepted: readonly SourceResult[];
  readonly rejected: readonly SourceResult[];
} {
  const accepted: SourceResult[] = [];
  const rejected: SourceResult[] = [];
  for (const result of results) (isAcceptedSource(result) ? accepted : rejected).push(result);
  return { accepted, rejected };
}

/** Validate the run reference before any work; wrong stage fails like B-02's guard. */
export function assertResearchRun(run: ResearchRun | undefined | null): asserts run is ResearchRun {
  if (!run || typeof run.id !== 'string' || run.id.trim() === '') {
    throw new ResearchRunRequiredError();
  }
  if (run.stage !== RESEARCH_STAGE) {
    throw new AdapterStageMismatchError(RESEARCH_STAGE, run.stage, run.id);
  }
}

/** Convenience: the adapter's limiter is always defined, tests may inject a recorder. */
export type ResearchRateLimiter = RateLimiter;
