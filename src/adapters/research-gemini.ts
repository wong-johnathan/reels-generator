/**
 * Gemini grounding fallback - a documented, config-selectable ResearchAdapter
 * (TECH_DESIGN 5.2, D7). It is NOT the default and requires the Gemini key.
 *
 *   POST {base}/models/{model}:generateContent
 *     { contents: [{ role: 'user', parts: [{ text: query }] }],
 *       tools: [{ google_search: {} }] }
 *     -> candidates[0].groundingMetadata.groundingChunks[].web.{uri,title}
 *        candidates[0].groundingMetadata.groundingSupports[] (confidenceScore,
 *        groundingChunkIndices, segment.text)
 *
 * Boundary, stated rather than hidden: grounding is a *search* citation source.
 * It has no fetch-a-URL operation, so `fetch()` fails closed with
 * ResearchUnsupportedError; the resolvable-URL qualification check uses the
 * adapter's search results plus the HTTP resolver, not this fetch.
 *
 * Grounding returns a confidence in [0,1], not a 0-3 rerank score. The adapter
 * normalises it onto the same scale (confidence x 3) so the single
 * `rerank_score >= 1.5` gate applies unchanged; a chunk with no support scores 0.
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
  ResearchUnsupportedError,
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

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_QUERY_LENGTH = 128;

export interface GeminiGroundingConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly rateLimitPerMin?: number;
  readonly fetchImpl?: typeof fetch;
  readonly limiter?: RateLimiter;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class GeminiGroundingAdapter implements ResearchAdapter {
  readonly provider = 'gemini' as const;
  readonly model: string;
  readonly idempotencyProtected = false as const;
  readonly timeoutMs: number;
  readonly rateLimitPerMin: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(config: GeminiGroundingConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
      throw new ResearchProviderConfigError(
        'research provider "gemini" requires an API key (GEMINI_API_KEY)',
      );
    }
    if (typeof config.model !== 'string' || config.model.trim() === '') {
      throw new ResearchProviderConfigError(
        'research provider "gemini" requires a model (GEMINI_GROUNDING_MODEL); selecting the fallback is a config change, not a code change',
      );
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
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
      throw new ResearchRequestError(`search query must be 1-${MAX_QUERY_LENGTH} characters`, {
        provider: this.provider,
        operation: 'search',
      });
    }
    const count = req.count ?? RESEARCH_DEFAULT_COUNT;
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ResearchRequestError('search count must be an integer 1-50', {
        provider: this.provider,
        operation: 'search',
      });
    }

    const { json, providerRequestId } = await this.post(
      {
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      },
      'search',
    );

    const payload = asRecord(json);
    const candidates = asArray(payload?.candidates);
    const grounding = asRecord(asRecord(candidates[0])?.groundingMetadata);
    const chunks = asArray(grounding?.groundingChunks);
    const supports = asArray(grounding?.groundingSupports);

    const confidenceByChunk = new Map<number, number>();
    const textByChunk = new Map<number, string>();
    for (const support of supports) {
      const record = asRecord(support);
      if (record === null) continue;
      const confidence = typeof record.confidenceScore === 'number' ? record.confidenceScore : 0;
      const segment = asRecord(record.segment);
      const text = typeof segment?.text === 'string' ? segment.text : '';
      for (const index of asArray(record.groundingChunkIndices)) {
        if (typeof index !== 'number' || !Number.isInteger(index)) continue;
        confidenceByChunk.set(index, Math.max(confidenceByChunk.get(index) ?? 0, confidence));
        if (text !== '' && !textByChunk.has(index)) textByChunk.set(index, text);
      }
    }

    const results: SourceResult[] = chunks.slice(0, count).map((chunk, index) => {
      const web = asRecord(asRecord(chunk)?.web);
      const uri = typeof web?.uri === 'string' ? web.uri : '';
      if (!isHttpUrl(uri)) {
        throw new ResearchResponseError(
          `gemini grounding chunk ${index} has no absolute http(s) web.uri`,
          { provider: this.provider, operation: 'search', providerRequestId },
        );
      }
      const title = typeof web?.title === 'string' ? web.title : '';
      const supportingText = textByChunk.get(index) ?? '';
      const confidence = confidenceByChunk.get(index) ?? 0;
      return {
        url: uri,
        title,
        snippet: supportingText,
        summary: supportingText,
        date: null,
        rerank_score: round2(confidence * 3),
        site_name: new URL(uri).hostname,
        authority: null,
      } satisfies SourceResult;
    });

    return { results, provider_request_id: providerRequestId };
  }

  async fetch(_req: FetchRequest, run: ResearchRun): Promise<FetchResponse> {
    assertResearchRun(run);
    throw new ResearchUnsupportedError(
      'Gemini grounding cannot fetch a URL: grounding returns search citations only (TECH_DESIGN 5.2 fallback boundary)',
      { provider: this.provider, operation: 'fetch' },
    );
  }

  private async post(
    body: Record<string, unknown>,
    operation: 'search',
  ): Promise<{ json: unknown; providerRequestId: string | null }> {
    await this.limiter.acquire();

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const causeClass = isAbortError(error) ? 'timeout' : 'network';
      throw new ResearchAdapterError(
        `gemini ${operation} request failed before a response (${causeClass})`,
        {
          provider: this.provider,
          operation,
          errorClass: 'transient',
          causeClass,
          cause: error,
        },
      );
    }

    const providerRequestId = response.headers.get('x-request-id');
    if (!response.ok) {
      const errorClass = classifyHttpStatus(response.status) ?? 'non_retryable';
      throw new ResearchAdapterError(`gemini ${operation} returned HTTP ${response.status}`, {
        provider: this.provider,
        operation,
        errorClass,
        causeClass: 'http',
        httpStatus: response.status,
        providerRequestId,
      });
    }

    try {
      const json = (await response.json()) as unknown;
      const responseId = asRecord(json)?.responseId;
      return {
        json,
        providerRequestId:
          providerRequestId ?? (typeof responseId === 'string' ? responseId : null),
      };
    } catch (error) {
      throw new ResearchResponseError(
        `gemini ${operation} returned a non-JSON body (HTTP ${response.status})`,
        { provider: this.provider, operation, providerRequestId, cause: error },
      );
    }
  }
}
