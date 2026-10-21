/**
 * DeepSeek Search & Fetch - TECH_DESIGN 5.2, the DEFAULT research provider (D7).
 *
 *   POST {base}/tools/search  { query, count, need_content?, ori_question? }
 *     -> { results: [{ url, title, snippet, summary, content, date,
 *                      rerank_score, site_name, site_icon, authority }] }
 *   POST {base}/tools/fetch   { url } -> { title, content }
 *
 * Field names mirror the published API reference (api-docs.deepseek.com/api/search
 * and /api/fetch) and the PRD research section. The adapter does not retry: it
 * classifies every failure as transient/non_retryable for B-08's retry loop
 * (TECH_DESIGN 5.1), and takes one token from the per-key limiter per call
 * (R-008-2). Timeout is 30 s by default (R-008-1).
 */
import { TokenBucket, type RateLimiter } from './rate-limit.js';
import {
  RESEARCH_DEFAULT_COUNT,
  RESEARCH_RATE_LIMIT_PER_MIN,
  RESEARCH_TIMEOUT_MS,
  ResearchAdapterError,
  ResearchProviderConfigError,
  ResearchRequestError,
  ResearchResponseError,
  assertResearchRun,
  classifyHttpStatus,
  isHttpUrl,
  type FetchRequest,
  type FetchResponse,
  type ResearchAdapter,
  type ResearchRun,
  type SearchRequest,
  type SearchResponse,
  type SourceResult,
} from './research-core.js';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const MAX_QUERY_LENGTH = 128;
const MAX_FETCH_URL_LENGTH = 8192;

export interface DeepSeekResearchConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly rateLimitPerMin?: number;
  readonly fetchImpl?: typeof fetch;
  readonly limiter?: RateLimiter;
  /** Injectable clock/sleep for the limiter (tests). */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface CallContext {
  readonly operation: 'search' | 'fetch';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function fieldPath(at: string, key: string): string {
  return at === '' ? key : `${at}.${key}`;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  at: string,
  ctx: CallContext,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new ResearchResponseError(
      `deepseek ${ctx.operation} response has no string at ${fieldPath(at, key)}`,
      { provider: 'deepseek', operation: ctx.operation },
    );
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  at: string,
  ctx: CallContext,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ResearchResponseError(
      `deepseek ${ctx.operation} response has a non-string value at ${fieldPath(at, key)}`,
      { provider: 'deepseek', operation: ctx.operation },
    );
  }
  return value;
}

function parseSource(value: unknown, index: number, ctx: CallContext): SourceResult {
  const at = `results[${index}]`;
  const record = asRecord(value);
  if (record === null) {
    throw new ResearchResponseError(
      `deepseek ${ctx.operation} response item ${at} is not an object`,
      { provider: 'deepseek', operation: ctx.operation },
    );
  }

  const url = requireString(record, 'url', at, ctx);
  if (!isHttpUrl(url)) {
    throw new ResearchResponseError(
      `deepseek ${ctx.operation} response has a non-http(s) URL at ${fieldPath(at, 'url')}`,
      { provider: 'deepseek', operation: ctx.operation },
    );
  }

  const score = record.rerank_score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new ResearchResponseError(
      `deepseek ${ctx.operation} response has no finite number at ${fieldPath(at, 'rerank_score')}`,
      { provider: 'deepseek', operation: ctx.operation },
    );
  }

  const date = optionalString(record, 'date', at, ctx);
  const siteName = optionalString(record, 'site_name', at, ctx);
  const content = optionalString(record, 'content', at, ctx);
  const authority = record.authority;

  return {
    url,
    title: requireString(record, 'title', at, ctx),
    snippet: requireString(record, 'snippet', at, ctx),
    summary: requireString(record, 'summary', at, ctx),
    ...(content === null || content === '' ? {} : { content }),
    date,
    rerank_score: score,
    site_name: siteName,
    authority: typeof authority === 'number' && Number.isInteger(authority) ? authority : null,
  };
}

export class DeepSeekResearchAdapter implements ResearchAdapter {
  readonly provider = 'deepseek' as const;
  readonly model = null;
  readonly idempotencyProtected = false as const;
  readonly timeoutMs: number;
  readonly rateLimitPerMin: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(config: DeepSeekResearchConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
      throw new ResearchProviderConfigError(
        'research provider "deepseek" requires an API key (DEEPSEEK_API_KEY)',
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? RESEARCH_TIMEOUT_MS;
    this.rateLimitPerMin = config.rateLimitPerMin ?? RESEARCH_RATE_LIMIT_PER_MIN;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.limiter =
      config.limiter ??
      new TokenBucket({
        perMinute: this.rateLimitPerMin,
        ...(config.now === undefined ? {} : { now: config.now }),
        ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
      });
  }

  async search(req: SearchRequest, run: ResearchRun): Promise<SearchResponse> {
    assertResearchRun(run);

    const query = typeof req.query === 'string' ? req.query.trim() : '';
    if (query === '' || query.length > MAX_QUERY_LENGTH) {
      throw new ResearchRequestError(
        `search query must be 1-${MAX_QUERY_LENGTH} characters (PRD research API)`,
        { provider: this.provider, operation: 'search' },
      );
    }

    const count = req.count ?? RESEARCH_DEFAULT_COUNT;
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ResearchRequestError('search count must be an integer 1-50', {
        provider: this.provider,
        operation: 'search',
      });
    }

    const body: Record<string, unknown> = { query, count };
    if (req.need_content === true) body.need_content = true;
    if (req.ori_question !== undefined) {
      const original = req.ori_question.trim();
      if (original === '' || original.length > MAX_QUERY_LENGTH) {
        throw new ResearchRequestError(`ori_question must be 1-${MAX_QUERY_LENGTH} characters`, {
          provider: this.provider,
          operation: 'search',
        });
      }
      body.ori_question = original;
    }

    const { json, providerRequestId } = await this.post('/tools/search', body, {
      operation: 'search',
    });
    const payload = asRecord(json);
    if (payload === null || !Array.isArray(payload.results)) {
      throw new ResearchResponseError('deepseek search response is missing the results array', {
        provider: this.provider,
        operation: 'search',
        providerRequestId,
      });
    }

    const results = payload.results.map((item, index) =>
      parseSource(item, index, { operation: 'search' }),
    );
    return { results, provider_request_id: providerRequestId };
  }

  async fetch(req: FetchRequest, run: ResearchRun): Promise<FetchResponse> {
    assertResearchRun(run);

    const url = typeof req.url === 'string' ? req.url.trim() : '';
    if (!isHttpUrl(url) || url.length > MAX_FETCH_URL_LENGTH) {
      throw new ResearchRequestError(
        `fetch URL must be an absolute http(s) URL of at most ${MAX_FETCH_URL_LENGTH} characters`,
        { provider: this.provider, operation: 'fetch' },
      );
    }
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') {
      throw new ResearchRequestError('fetch URL must not contain credentials', {
        provider: this.provider,
        operation: 'fetch',
      });
    }

    const { json, providerRequestId } = await this.post(
      '/tools/fetch',
      { url },
      {
        operation: 'fetch',
      },
    );
    const payload = asRecord(json);
    if (payload === null) {
      throw new ResearchResponseError('deepseek fetch response must be an object', {
        provider: this.provider,
        operation: 'fetch',
        providerRequestId,
      });
    }
    const context: CallContext = { operation: 'fetch' };
    return {
      title: requireString(payload, 'title', '', context),
      content_markdown: requireString(payload, 'content', '', context),
      provider_request_id: providerRequestId,
    };
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<{ json: unknown; providerRequestId: string | null }> {
    await this.limiter.acquire();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const causeClass = isAbortError(error) ? 'timeout' : 'network';
      throw new ResearchAdapterError(
        `deepseek ${ctx.operation} request failed before a response (${causeClass})`,
        {
          provider: this.provider,
          operation: ctx.operation,
          errorClass: 'transient',
          causeClass,
          cause: error,
        },
      );
    }

    const providerRequestId = response.headers.get('x-request-id');
    if (!response.ok) {
      const errorClass = classifyHttpStatus(response.status) ?? 'non_retryable';
      throw new ResearchAdapterError(`deepseek ${ctx.operation} returned HTTP ${response.status}`, {
        provider: this.provider,
        operation: ctx.operation,
        errorClass,
        causeClass: 'http',
        httpStatus: response.status,
        providerRequestId,
      });
    }

    try {
      return { json: (await response.json()) as unknown, providerRequestId };
    } catch (error) {
      throw new ResearchResponseError(
        `deepseek ${ctx.operation} returned a non-JSON body (HTTP ${response.status})`,
        { provider: this.provider, operation: ctx.operation, providerRequestId, cause: error },
      );
    }
  }
}
