import { describe, expect, it, vi } from 'vitest';

import { DeepSeekResearchAdapter } from './research-deepseek.js';
import { ResearchAdapterError, ResearchRequestError, ResearchResponseError } from './research.js';
import { RESEARCH_QUALIFICATION_CLAIMS, qualifyResearch } from './research.js';

const run = { id: 'run-fixture-1', stage: 'RS' } as const;

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const SEARCH_PAYLOAD = {
  results: [
    {
      url: 'https://nus.example/chewing-gum',
      title: 'Chewing Gum: More than a Nuisance',
      snippet: 'A short summary related to the query.',
      summary: 's'.repeat(640),
      content: '',
      site_name: 'NUS',
      site_icon: null,
      date: '2019-01-02T00:00:00Z',
      rerank_score: 1.52,
      authority: 3,
    },
    {
      url: 'https://noise.example/turkish-gum',
      title: 'Sakiz',
      snippet: 'Off-topic.',
      summary: 's'.repeat(640),
      content: '',
      site_name: null,
      site_icon: null,
      date: null,
      rerank_score: 0.95,
      authority: -1,
    },
  ],
};

function adapter(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof DeepSeekResearchAdapter>[0]> = {},
) {
  return new DeepSeekResearchAdapter({ apiKey: 'fixture-deepseek-key', fetchImpl, ...overrides });
}

describe('DeepSeek research adapter - search (TECH_DESIGN 5.2)', () => {
  it('posts the documented body to /v1/tools/search with bearer auth and no key in the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const result = await adapter(fetchImpl as unknown as typeof fetch).search(
      { query: 'singapore chewing gum ban' },
      run,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer fixture-deepseek-key',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'singapore chewing gum ban',
      count: 5,
    });
    expect(result.results).toHaveLength(2);
  });

  it('passes count, need_content and ori_question only when supplied', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    await adapter(fetchImpl as unknown as typeof fetch).search(
      { query: 'q', count: 12, need_content: true, ori_question: 'what happened?' },
      run,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'q',
      count: 12,
      need_content: true,
      ori_question: 'what happened?',
    });
  });

  it('maps every documented result field and drops an empty page body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const { results, provider_request_id } = await adapter(
      fetchImpl as unknown as typeof fetch,
    ).search({ query: 'q' }, run);

    expect(results[0]).toEqual({
      url: 'https://nus.example/chewing-gum',
      title: 'Chewing Gum: More than a Nuisance',
      snippet: 'A short summary related to the query.',
      summary: 's'.repeat(640),
      date: '2019-01-02T00:00:00Z',
      rerank_score: 1.52,
      site_name: 'NUS',
      authority: 3,
    });
    expect(results[1]?.date).toBeNull();
    expect(provider_request_id).toBeNull();
  });

  it('keeps the page body when need_content returned one', async () => {
    const payload = {
      results: [{ ...SEARCH_PAYLOAD.results[0], content: '# Page body' }],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    const { results } = await adapter(fetchImpl as unknown as typeof fetch).search(
      { query: 'q', need_content: true },
      run,
    );
    expect(results[0]?.content).toBe('# Page body');
  });

  it('surfaces the provider request id from the response headers (R-008-4)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(SEARCH_PAYLOAD, { headers: { 'x-request-id': 'req_abc123' } }),
    );
    const result = await adapter(fetchImpl as unknown as typeof fetch).search({ query: 'q' }, run);
    expect(result.provider_request_id).toBe('req_abc123');
  });

  it('accepts an empty results array as a valid, unbilled response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const result = await adapter(fetchImpl as unknown as typeof fetch).search({ query: 'q' }, run);
    expect(result.results).toEqual([]);
  });

  it('rejects a malformed result instead of admitting a source without a URL or score', async () => {
    for (const bad of [
      { ...SEARCH_PAYLOAD.results[0], url: '' },
      { ...SEARCH_PAYLOAD.results[0], rerank_score: undefined },
      { ...SEARCH_PAYLOAD.results[0], rerank_score: '1.52' },
      { ...SEARCH_PAYLOAD.results[0], title: undefined },
    ]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ results: [bad] }));
      const error = await adapter(fetchImpl as unknown as typeof fetch)
        .search({ query: 'q' }, run)
        .catch((err: unknown) => err);
      expect(error, JSON.stringify(bad).slice(0, 40)).toBeInstanceOf(ResearchResponseError);
      expect((error as ResearchAdapterError).errorClass).toBe('non_retryable');
      expect((error as Error).message).toMatch(/results\[0\]/);
    }
  });

  it('rejects a non-JSON success body', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }));
    const error = await adapter(fetchImpl as unknown as typeof fetch)
      .search({ query: 'q' }, run)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ResearchResponseError);
    expect((error as ResearchAdapterError).errorClass).toBe('non_retryable');
  });
});

describe('DeepSeek research adapter - fetch (TECH_DESIGN 5.2)', () => {
  it('posts the URL to /v1/tools/fetch and returns Markdown under content_markdown', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ title: 'Example article', content: '# Example article\n\nBody.' }),
    );
    const result = await adapter(fetchImpl as unknown as typeof fetch).fetch(
      { url: 'https://fixture.test/article' },
      run,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://fixture.test/article' });
    expect(result).toEqual({
      title: 'Example article',
      content_markdown: '# Example article\n\nBody.',
      provider_request_id: null,
    });
  });

  it('rejects an unusable URL locally without spending a provider call', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['javascript:alert(1)', 'ftp://fixture.test/a', 'not-a-url']) {
      const error = await adapter(fetchImpl as unknown as typeof fetch)
        .fetch({ url }, run)
        .catch((err: unknown) => err);
      expect(error, url).toBeInstanceOf(ResearchRequestError);
      expect((error as ResearchAdapterError).errorClass).toBe('non_retryable');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('DeepSeek research adapter - failures (R-011-2 classification)', () => {
  it('classifies 429 and 5xx as transient without retrying inside the adapter', async () => {
    for (const status of [429, 500, 502, 503]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, { status }));
      const error = await adapter(fetchImpl as unknown as typeof fetch)
        .search({ query: 'q' }, run)
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ResearchAdapterError);
      expect((error as ResearchAdapterError).errorClass).toBe('transient');
      expect((error as ResearchAdapterError).httpStatus).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((error as Error).message).not.toContain('fixture-deepseek-key');
    }
  });

  it('classifies auth and other 4xx as non-retryable', async () => {
    for (const status of [400, 401, 403, 422]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, { status }));
      const error = await adapter(fetchImpl as unknown as typeof fetch)
        .search({ query: 'q' }, run)
        .catch((err: unknown) => err);
      expect((error as ResearchAdapterError).errorClass, String(status)).toBe('non_retryable');
    }
  });

  it('classifies a network failure as transient', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await adapter(fetchImpl as unknown as typeof fetch)
      .search({ query: 'q' }, run)
      .catch((err: unknown) => err);
    expect((error as ResearchAdapterError).errorClass).toBe('transient');
    expect((error as ResearchAdapterError).causeClass).toBe('network');
  });

  it('classifies an aborted request as a transient timeout with the configured budget', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const error = await adapter(fetchImpl as unknown as typeof fetch, { timeoutMs: 5 })
      .search({ query: 'q' }, run)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ResearchAdapterError);
    expect((error as ResearchAdapterError).errorClass).toBe('transient');
    expect((error as ResearchAdapterError).causeClass).toBe('timeout');
  });

  it('takes a token from the injected rate limiter before every provider request', async () => {
    const acquire = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const research = adapter(fetchImpl as unknown as typeof fetch, {
      limiter: { acquire },
    });
    await research.search({ query: 'one' }, run);
    await research.search({ query: 'two' }, run);
    expect(acquire).toHaveBeenCalledTimes(2);
  });
});

describe('research qualification through the real adapter (recorded API shapes)', () => {
  function source(url: string, rerank_score: number) {
    return {
      ...SEARCH_PAYLOAD.results[0],
      url,
      rerank_score,
    };
  }

  function adapterServing(byQuery: Record<string, unknown>) {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      return jsonResponse(byQuery[body.query] ?? { results: [] });
    });
    return {
      fetchImpl,
      adapter: new DeepSeekResearchAdapter({
        apiKey: 'fixture-deepseek-key',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        limiter: { acquire: async () => {} },
      }),
    };
  }

  it('passes when 3 of the 5 enumerated claims resolve through the mapped source rows', async () => {
    const [first, second, third, fourth, fifth] = RESEARCH_QUALIFICATION_CLAIMS;
    const { adapter: research, fetchImpl } = adapterServing({
      [String(first)]: { results: [source('https://authority.example/one', 1.52)] },
      [String(second)]: { results: [source('https://authority.example/two', 1.8)] },
      [String(third)]: { results: [source('https://authority.example/three', 1.6)] },
      [String(fourth)]: { results: [source('https://noise.example/four', 0.95)] },
      [String(fifth)]: { results: [source('https://noise.example/five', 1.2)] },
    });

    const result = await qualifyResearch(research, {
      run: (_operation, index) => ({ id: `qual-run-${index}`, stage: 'RS' }),
      resolveUrl: async () => true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result.passed).toBe(true);
    expect(result.details.claims_resolved).toBe(3);
    expect(result.details.claims.map((claim) => claim.accepted_urls)).toEqual([
      ['https://authority.example/one'],
      ['https://authority.example/two'],
      ['https://authority.example/three'],
      [],
      [],
    ]);
  });

  it('fails closed when an accepted URL does not resolve, even though the search found it', async () => {
    const [first, second, third, fourth, fifth] = RESEARCH_QUALIFICATION_CLAIMS;
    const { adapter: research } = adapterServing({
      [String(first)]: { results: [source('https://authority.example/one', 1.52)] },
      [String(second)]: { results: [source('https://authority.example/two', 1.8)] },
      [String(third)]: { results: [source('https://dead.example/three', 1.9)] },
      [String(fourth)]: { results: [source('https://noise.example/four', 0.95)] },
      [String(fifth)]: { results: [source('https://noise.example/five', 1.2)] },
    });

    const result = await qualifyResearch(research, {
      run: (_operation, index) => ({ id: `qual-run-${index}`, stage: 'RS' }),
      resolveUrl: async (url) => !url.includes('dead.example'),
    });

    expect(result.passed).toBe(false);
    expect(result.details.claims_resolved).toBe(2);
    expect(result.details.claims[2]?.accepted_urls).toEqual(['https://dead.example/three']);
    expect(result.details.claims[2]?.resolved_urls).toEqual([]);
  });
});
