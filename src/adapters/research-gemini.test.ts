import { describe, expect, it, vi } from 'vitest';

import { GeminiGroundingAdapter } from './research-gemini.js';
import { ResearchUnsupportedError } from './research.js';
import type { ResearchAdapterError } from './research.js';

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

const GROUNDED = {
  responseId: 'gemini-response-1',
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'Singapore banned chewing gum in 1992.' }] },
      groundingMetadata: {
        webSearchQueries: ['singapore chewing gum ban 1992'],
        groundingChunks: [
          { web: { uri: 'https://authority.example/gum-ban', title: 'Gum ban - Authority' } },
          { web: { uri: 'https://blog.example/gum', title: 'A blog about gum' } },
          { web: { uri: 'https://unsupported.example/gum', title: 'No confidence chunk' } },
        ],
        groundingSupports: [
          {
            segment: { startIndex: 0, endIndex: 38, text: 'Singapore banned chewing gum in 1992.' },
            groundingChunkIndices: [0],
            confidenceScore: 0.6,
          },
          {
            segment: { startIndex: 0, endIndex: 10, text: 'Gum ban.' },
            groundingChunkIndices: [1],
            confidenceScore: 0.5,
          },
        ],
      },
    },
  ],
};

function adapter(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new GeminiGroundingAdapter({
    apiKey: 'fixture-gemini-key',
    model: 'fixture-grounding-model',
    fetchImpl,
    ...overrides,
  });
}

describe('Gemini grounding fallback adapter (TECH_DESIGN 5.2, D7)', () => {
  it('is an opt-in ResearchAdapter with the same search/fetch surface', () => {
    const research = adapter(vi.fn() as unknown as typeof fetch);
    expect(research.provider).toBe('gemini');
    expect(research.model).toBe('fixture-grounding-model');
    expect(typeof research.search).toBe('function');
    expect(typeof research.fetch).toBe('function');
  });

  it('calls generateContent with the google_search tool and the key in a header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(GROUNDED));
    await adapter(fetchImpl as unknown as typeof fetch).search(
      { query: 'singapore chewing gum ban', count: 2 },
      run,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/fixture-grounding-model:generateContent',
    );
    expect(url).not.toContain('fixture-gemini-key');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'fixture-gemini-key' });
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'singapore chewing gum ban' }] }],
      tools: [{ google_search: {} }],
    });
  });

  it('maps grounding chunks onto SourceResult with confidence normalised to the 0-3 scale', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(GROUNDED));
    const result = await adapter(fetchImpl as unknown as typeof fetch).search({ query: 'q' }, run);

    expect(result.provider_request_id).toBe('gemini-response-1');
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({
      url: 'https://authority.example/gum-ban',
      title: 'Gum ban - Authority',
      snippet: 'Singapore banned chewing gum in 1992.',
      summary: 'Singapore banned chewing gum in 1992.',
      date: null,
      rerank_score: 1.8,
      site_name: 'authority.example',
      authority: null,
    });
    // 0.5 confidence normalises to exactly the 1.5 acceptance threshold.
    expect(result.results[1]?.rerank_score).toBe(1.5);
    // No support for this chunk: score 0, so it can never pass the gate.
    expect(result.results[2]?.rerank_score).toBe(0);
  });

  it('honours count and keeps provider order', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(GROUNDED));
    const result = await adapter(fetchImpl as unknown as typeof fetch).search(
      { query: 'q', count: 2 },
      run,
    );
    expect(result.results.map((r) => r.url)).toEqual([
      'https://authority.example/gum-ban',
      'https://blog.example/gum',
    ]);
  });

  it('returns no sources when grounding produced no chunks', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        responseId: 'r-1',
        candidates: [{ content: { parts: [{ text: 'no sources' }] } }],
      }),
    );
    const result = await adapter(fetchImpl as unknown as typeof fetch).search({ query: 'q' }, run);
    expect(result.results).toEqual([]);
    expect(result.provider_request_id).toBe('r-1');
  });

  it('declares fetch unsupported instead of pretending grounding can fetch a URL', async () => {
    const fetchImpl = vi.fn();
    const error = await adapter(fetchImpl as unknown as typeof fetch)
      .fetch({ url: 'https://authority.example/gum-ban' }, run)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ResearchUnsupportedError);
    expect((error as ResearchAdapterError).errorClass).toBe('non_retryable');
    expect((error as Error).message).toMatch(/grounding/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies HTTP failures with the same retry vocabulary as the primary adapter', async () => {
    const transient = vi.fn(async () => jsonResponse({ error: 'busy' }, { status: 503 }));
    const retryable = await adapter(transient as unknown as typeof fetch)
      .search({ query: 'q' }, run)
      .catch((err: unknown) => err);
    expect((retryable as ResearchAdapterError).errorClass).toBe('transient');

    const auth = vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 }));
    const nonRetryable = await adapter(auth as unknown as typeof fetch)
      .search({ query: 'q' }, run)
      .catch((err: unknown) => err);
    expect((nonRetryable as ResearchAdapterError).errorClass).toBe('non_retryable');
  });
});
