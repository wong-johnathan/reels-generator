/**
 * Research adapter entry point - US-011 (research) and US-012 (research qualification).
 *
 * This module owns:
 *  - the provider selection (DeepSeek default, Gemini grounding fallback) that
 *    makes TECH_DESIGN 5.2's fallback a *configuration* choice;
 *  - `qualifyResearch()`, the R-008-3 check that >= 3 of 5 enumerated factual
 *    claims receive a resolvable citation URL, recorded as a
 *    `provider_qualification` row;
 *  - the HTTP reachability resolver used by that check (R-027-2 semantics:
 *    2xx or 3xx counts, redirects are not followed).
 *
 * The contract, the acceptance gate and the implementations live in
 * research-core.ts / research-deepseek.ts / research-gemini.ts / research-fake.ts
 * and are re-exported here so callers have one import.
 */
import type { Queryable } from '../db/client.js';
import { recordQualification, type QualificationRow } from './qualification.js';
import {
  RESEARCH_DEFAULT_COUNT,
  RESEARCH_RATE_LIMIT_PER_MIN,
  RESEARCH_RERANK_THRESHOLD,
  RESEARCH_TIMEOUT_MS,
  ResearchProviderConfigError,
  isHttpUrl,
  partitionSources,
  type ResearchAdapter,
  type ResearchOperation,
  type ResearchProviderId,
  type ResearchRun,
} from './research-core.js';
import { DeepSeekResearchAdapter } from './research-deepseek.js';
import { GeminiGroundingAdapter } from './research-gemini.js';
import type { RateLimiter } from './rate-limit.js';

export * from './research-core.js';
export { FakeResearchAdapter, fakeSource } from './research-fake.js';
export { DeepSeekResearchAdapter, DEEPSEEK_DEFAULT_BASE_URL } from './research-deepseek.js';
export { GeminiGroundingAdapter, GEMINI_DEFAULT_BASE_URL } from './research-gemini.js';
export {
  QualificationGateError,
  assertLatestQualificationPassed,
  latestQualification,
  recordQualification,
} from './qualification.js';

/**
 * The fixed factual sample for the research qualification (R-008-3: ">= 3 of 5
 * enumerated factual claims"). They are search queries, not generated content;
 * the pass criterion is a resolvable URL, not the truth of the statement.
 * `QualifyResearchOptions.claims` exists so the operator can re-run the check on
 * a different sample without changing code.
 */
export const RESEARCH_QUALIFICATION_CLAIMS: readonly string[] = [
  'Singapore banned the import and sale of chewing gum in 1992.',
  'Singapore allows therapeutic chewing gum to be sold by pharmacists.',
  'Chewing gum caused MRT door sensor faults in Singapore.',
  'Singapore enforces its chewing gum ban with fines.',
  'Importing chewing gum into Singapore requires a licence from the health authority.',
];

/** R-008-3: at least 3 of the 5 enumerated claims must resolve to a citation URL. */
export const RESEARCH_QUALIFICATION_MIN_RESOLVED = 3;

export interface ResearchAdapterConfig {
  /** Defaults to `deepseek`; `gemini` is the documented fallback (D7). */
  readonly provider?: ResearchProviderId;
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Required for the Gemini grounding fallback; DeepSeek search/fetch take no model. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly rateLimitPerMin?: number;
  readonly fetchImpl?: typeof fetch;
  readonly limiter?: RateLimiter;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the configured research adapter. Selecting the fallback is this one
 * value; no call site changes (TECH_DESIGN 5.2).
 */
export function createResearchAdapter(config: ResearchAdapterConfig): ResearchAdapter {
  const provider = config.provider ?? 'deepseek';
  switch (provider) {
    case 'deepseek':
      return new DeepSeekResearchAdapter({
        apiKey: config.apiKey,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.rateLimitPerMin === undefined
          ? {}
          : { rateLimitPerMin: config.rateLimitPerMin }),
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        ...(config.limiter === undefined ? {} : { limiter: config.limiter }),
        ...(config.now === undefined ? {} : { now: config.now }),
        ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
      });
    case 'gemini':
      return new GeminiGroundingAdapter({
        apiKey: config.apiKey,
        model: config.model ?? '',
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.rateLimitPerMin === undefined
          ? {}
          : { rateLimitPerMin: config.rateLimitPerMin }),
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        ...(config.limiter === undefined ? {} : { limiter: config.limiter }),
        ...(config.now === undefined ? {} : { now: config.now }),
        ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
      });
    default:
      throw new ResearchProviderConfigError(
        `unknown research provider "${String(provider)}" (RESEARCH_PROVIDER must be deepseek or gemini)`,
      );
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

function secondsEnv(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed * 1000 : fallbackMs;
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `RESEARCH_PROVIDER`: unset/empty means the DeepSeek default, never the fallback. */
export function resolveResearchProvider(env: EnvSource): ResearchProviderId {
  const raw = (env.RESEARCH_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '') return 'deepseek';
  if (raw === 'deepseek' || raw === 'gemini') return raw;
  throw new ResearchProviderConfigError(
    `unknown research provider "${raw}" (RESEARCH_PROVIDER must be deepseek or gemini)`,
  );
}

/**
 * Build the adapter from the validated environment. A missing key is named
 * ("GEMINI_API_KEY"), never echoed: keys are secrets (R-015-5).
 */
export function createResearchAdapterFromEnv(
  env: EnvSource,
  overrides: Partial<Omit<ResearchAdapterConfig, 'provider'>> & {
    readonly provider?: ResearchProviderId;
  } = {},
): ResearchAdapter {
  const provider = overrides.provider ?? resolveResearchProvider(env);
  const timeoutMs =
    overrides.timeoutMs ?? secondsEnv(env.PROVIDER_TIMEOUT_SEARCH_S, RESEARCH_TIMEOUT_MS);
  const rateLimitPerMin =
    overrides.rateLimitPerMin ??
    intEnv(env.PROVIDER_RATE_LIMIT_PER_MIN, RESEARCH_RATE_LIMIT_PER_MIN);

  if (provider === 'gemini') {
    const apiKey = overrides.apiKey ?? nonEmpty(env.GEMINI_API_KEY);
    if (apiKey === null) {
      throw new ResearchProviderConfigError(
        'research provider "gemini" requires GEMINI_API_KEY (the grounding fallback needs the Gemini key)',
      );
    }
    const model = overrides.model ?? nonEmpty(env.GEMINI_GROUNDING_MODEL);
    if (model === null) {
      throw new ResearchProviderConfigError(
        'research provider "gemini" requires GEMINI_GROUNDING_MODEL (selecting the fallback is a config change, not a code change)',
      );
    }
    return createResearchAdapter({
      ...overrides,
      provider,
      apiKey,
      model,
      timeoutMs,
      rateLimitPerMin,
    });
  }

  const apiKey = overrides.apiKey ?? nonEmpty(env.DEEPSEEK_API_KEY);
  if (apiKey === null) {
    throw new ResearchProviderConfigError('research provider "deepseek" requires DEEPSEEK_API_KEY');
  }
  const baseUrl = overrides.baseUrl ?? nonEmpty(env.DEEPSEEK_BASE_URL);
  return createResearchAdapter({
    ...overrides,
    provider: 'deepseek',
    apiKey,
    ...(baseUrl === null ? {} : { baseUrl }),
    timeoutMs,
    rateLimitPerMin,
  });
}

/** Resolves true when a URL answers with 2xx or 3xx (R-027-2 wording). */
export type UrlResolver = (url: string) => Promise<boolean>;

export interface HttpUrlResolverOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The default reachability check for the research qualification. It never
 * throws (an unresolvable URL is data, not an error), never follows redirects
 * (a 3xx is itself acceptable), sends no credentials, and refuses anything that
 * is not absolute http(s) before opening a socket.
 */
export function createHttpUrlResolver(options: HttpUrlResolverOptions = {}): UrlResolver {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    accept: '*/*',
    'user-agent': 'reels-generator-qualification/1.0',
  };

  const probe = async (url: string, method: 'HEAD' | 'GET'): Promise<Response> =>
    fetchImpl(url, { method, redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutMs) });

  return async (url: string): Promise<boolean> => {
    if (!isHttpUrl(url)) return false;
    try {
      const response = await probe(url, 'HEAD');
      // Some servers refuse HEAD; the body is still not read, only the status.
      if (response.status === 405 || response.status === 501) {
        const fallback = await probe(url, 'GET');
        return fallback.status >= 200 && fallback.status < 400;
      }
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    }
  };
}

export interface ResearchQualificationClaimResult {
  readonly claim: string;
  /** Accepted sources only (rerank_score >= 1.5, non-empty URL), in provider order. */
  readonly accepted_urls: readonly string[];
  readonly resolved_urls: readonly string[];
  readonly passed: boolean;
}

export interface ResearchQualificationDetails {
  readonly claims_total: number;
  readonly claims_resolved: number;
  readonly threshold: number;
  readonly acceptance_threshold: number;
  readonly claims: readonly ResearchQualificationClaimResult[];
  readonly checked_at: string;
  readonly duration_ms: number;
}

export interface ResearchQualificationResult {
  readonly passed: boolean;
  readonly details: ResearchQualificationDetails;
  /** True when a `provider_qualification` row was written. */
  readonly recorded: boolean;
}

export interface QualificationRecordInput {
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  readonly details: object;
  readonly runAt: Date;
}

export type QualificationRecorder = (input: QualificationRecordInput) => Promise<unknown>;

export interface QualifyResearchOptions {
  /**
   * A persisted run per provider call (R-012-1). The production caller opens
   * one with `openAttempt()`; a test may return a fixture reference.
   */
  readonly run: (operation: ResearchOperation, index: number) => ResearchRun | Promise<ResearchRun>;
  /** Defaults to the HTTP resolver; tests inject a deterministic resolver. */
  readonly resolveUrl?: UrlResolver;
  /** Defaults to the five enumerated claims above. */
  readonly claims?: readonly string[];
  readonly count?: number;
  /** Written through `recordQualification` when present. */
  readonly db?: Queryable;
  /** Seam for tests; takes precedence over `db`. */
  readonly record?: QualificationRecorder;
  readonly now?: () => Date;
}

/**
 * Run the research qualification: search every enumerated claim, keep only
 * sources that pass the 1.5 gate, check each accepted URL for reachability, and
 * pass when at least 3 claims resolve. The result is written to
 * `provider_qualification` when a sink is provided (R-008-3).
 */
export async function qualifyResearch(
  adapter: ResearchAdapter,
  options: QualifyResearchOptions,
): Promise<ResearchQualificationResult> {
  const now = options.now ?? (() => new Date());
  const claims = options.claims ?? RESEARCH_QUALIFICATION_CLAIMS;
  const resolveUrl = options.resolveUrl ?? createHttpUrlResolver();
  const count = options.count ?? RESEARCH_DEFAULT_COUNT;
  const startedAtMs = now().getTime();

  const results: ResearchQualificationClaimResult[] = [];
  for (const [index, claim] of claims.entries()) {
    const run = await options.run('search', index);
    const { results: sources } = await adapter.search({ query: claim, count }, run);
    const { accepted } = partitionSources(sources);
    const acceptedUrls = accepted.map((source) => source.url);

    const resolvedUrls: string[] = [];
    for (const url of acceptedUrls) {
      if (await resolveUrl(url)) resolvedUrls.push(url);
    }

    results.push({
      claim,
      accepted_urls: acceptedUrls,
      resolved_urls: resolvedUrls,
      passed: resolvedUrls.length > 0,
    });
  }

  const claimsResolved = results.filter((result) => result.passed).length;
  const finishedAt = now();
  const details: ResearchQualificationDetails = {
    claims_total: results.length,
    claims_resolved: claimsResolved,
    threshold: RESEARCH_QUALIFICATION_MIN_RESOLVED,
    acceptance_threshold: RESEARCH_RERANK_THRESHOLD,
    claims: results,
    checked_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAtMs),
  };
  const passed = claimsResolved >= RESEARCH_QUALIFICATION_MIN_RESOLVED;

  let recorded = false;
  if (options.record !== undefined) {
    await options.record({
      provider: adapter.provider,
      adapter: 'research',
      passed,
      details,
      runAt: finishedAt,
    });
    recorded = true;
  } else if (options.db !== undefined) {
    const row: QualificationRow = await recordQualification(options.db, {
      provider: adapter.provider,
      adapter: 'research',
      passed,
      details,
      runAt: finishedAt,
    });
    recorded = row.id.length > 0;
  }

  return { passed, details, recorded };
}
