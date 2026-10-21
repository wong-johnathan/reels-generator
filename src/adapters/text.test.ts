import { describe, expect, it, vi } from 'vitest';

import { AdapterStageMismatchError } from '../domain/generation-run.js';
import { fakePersistedRun } from '../../tests/helpers/runs.js';
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
  ProviderSchemaError,
  ProviderTimeoutError,
} from './errors.js';
import type { RateLimiter } from './rate-limit.js';
import { QUIET_MACHINES_FIXTURES } from './text-fixtures.js';
import { TEXT_SCHEMAS } from './text-schemas.js';
import {
  buildChatRequestBody,
  DeepSeekTextAdapter,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  TEXT_TIMEOUT_MS,
  type ChatMessage,
} from './text.js';

/**
 * B-04: the DeepSeek text adapter, exercised with an injected `fetch`.
 *
 * No test reaches a provider: `fetchImpl` is a local function, so a socket is
 * never opened. These tests assert the wire contract (body, headers, timeout),
 * the response→content mapping, and the R-011-2 error classification.
 */
const API_KEY = 'test-key-not-a-real-credential';

const MESSAGES: readonly ChatMessage[] = [
  { role: 'system', content: 'Return JSON only.' },
  { role: 'user', content: 'Write the script.' },
];

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function capturingFetch(respond: (captured: Captured) => Response | Promise<Response>): {
  readonly fetchImpl: typeof fetch;
  readonly calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const captured: Captured = {
      url: String(input),
      init,
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function providerResponse(name: string, content: unknown): Response {
  return new Response(
    JSON.stringify({
      id: `req_${name}`,
      object: 'chat.completion',
      model: DEEPSEEK_DEFAULT_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function adapterWith(
  fetchImpl: typeof fetch,
  overrides: { timeoutMs?: number; rateLimiter?: RateLimiter } = {},
): DeepSeekTextAdapter {
  return new DeepSeekTextAdapter({
    apiKey: API_KEY,
    fetchImpl,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.rateLimiter === undefined ? {} : { rateLimiter: overrides.rateLimiter }),
  });
}

describe('DeepSeekTextAdapter.generate (R-008-1, R-008-4, R-012-2)', () => {
  it('sends an OpenAI-compatible chat body with a JSON response format and no idempotency key', async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      providerResponse('script', QUIET_MACHINES_FIXTURES.script),
    );
    const adapter = adapterWith(fetchImpl);

    await adapter.generate(
      {
        stage: 'SC',
        schema: TEXT_SCHEMAS.script,
        messages: MESSAGES,
        temperature: 0.2,
        max_tokens: 1200,
      },
      fakePersistedRun({ stage: 'SC' }),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${DEEPSEEK_DEFAULT_BASE_URL}/chat/completions`);
    expect(call.body).toEqual({
      model: DEEPSEEK_DEFAULT_MODEL,
      messages: MESSAGES,
      temperature: 0.2,
      max_tokens: 1200,
      stream: false,
      // DeepSeek honours `json_object`, not a caller-supplied JSON Schema; the
      // versioned zod schema is the authority and is enforced locally.
      response_format: { type: 'json_object' },
    });

    const headers = new Headers(call.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    // R-012-2: no provider honours a key, so none may be claimed or sent.
    expect(headers.get('idempotency-key')).toBeNull();

    // R-015-5: the key travels in the header only, never in the URL or the body.
    expect(call.url).not.toContain(API_KEY);
    expect(JSON.stringify(call.body)).not.toContain(API_KEY);

    expect(adapter.idempotencyProtected).toBe(false);
    expect(adapter.provider).toBe('deepseek');
  });

  it('omits optional sampling fields the caller did not set', () => {
    const body = buildChatRequestBody(
      { stage: 'T', schema: TEXT_SCHEMAS.topic, messages: MESSAGES },
      DEEPSEEK_DEFAULT_MODEL,
    );
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).toMatchObject({ model: DEEPSEEK_DEFAULT_MODEL, stream: false });
  });

  it('returns validated content plus the provider request id and usage', async () => {
    const { fetchImpl } = capturingFetch(() =>
      providerResponse('topic', QUIET_MACHINES_FIXTURES.topic),
    );
    const result = await adapterWith(fetchImpl).generate(
      { stage: 'T', schema: TEXT_SCHEMAS.topic, messages: MESSAGES },
      fakePersistedRun({ stage: 'T' }),
    );

    expect(result.content).toEqual(QUIET_MACHINES_FIXTURES.topic);
    expect(result.provider_request_id).toBe('req_topic');
    expect(result.model).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(result.http_status).toBe(200);
    expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 340 });
    expect(result.raw).toMatchObject({ id: 'req_topic' });
  });

  it('honours a configurable base URL and model (R-008-1)', async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      providerResponse('script', QUIET_MACHINES_FIXTURES.script),
    );
    const adapter = new DeepSeekTextAdapter({
      apiKey: API_KEY,
      baseUrl: 'https://deepseek.internal.example/v1/',
      model: 'deepseek-reasoner',
      fetchImpl,
    });

    const result = await adapter.generate(
      { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES, model: 'deepseek-chat' },
      fakePersistedRun({ stage: 'SC' }),
    );

    expect(calls[0]!.url).toBe('https://deepseek.internal.example/v1/chat/completions');
    // The per-request model wins over the adapter default.
    expect(calls[0]!.body.model).toBe('deepseek-chat');
    expect(result.model).toBe(DEEPSEEK_DEFAULT_MODEL);
  });

  it('defaults the timeout to the 60 s contract value (TECH_DESIGN §5.1)', () => {
    expect(TEXT_TIMEOUT_MS).toBe(60_000);
  });

  it('acquires the rate limiter before the request is issued (R-008-2)', async () => {
    const order: string[] = [];
    const rateLimiter: RateLimiter = {
      acquire: async () => {
        order.push('acquire');
      },
    };
    const { fetchImpl } = capturingFetch(() => {
      order.push('fetch');
      return providerResponse('script', QUIET_MACHINES_FIXTURES.script);
    });

    await adapterWith(fetchImpl, { rateLimiter }).generate(
      { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
      fakePersistedRun({ stage: 'SC' }),
    );

    expect(order).toEqual(['acquire', 'fetch']);
  });

  it('refuses a run whose stage does not match the request schema, before any socket', async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      providerResponse('script', QUIET_MACHINES_FIXTURES.script),
    );

    await expect(
      adapterWith(fetchImpl).generate(
        { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
        fakePersistedRun({ stage: 'SB' }),
      ),
    ).rejects.toBeInstanceOf(AdapterStageMismatchError);
    expect(calls).toHaveLength(0);
  });
});

describe('DeepSeekTextAdapter error classification (R-011-2, R-012-4)', () => {
  it.each([
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
    [400, 'non_retryable'],
    [401, 'non_retryable'],
    [422, 'non_retryable'],
  ])('classifies HTTP %i as %s', async (status, errorClass) => {
    const { fetchImpl } = capturingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'provider said no' } }), {
          status,
          headers: { 'x-request-id': 'req_failed' },
        }),
    );

    const error = await adapterWith(fetchImpl)
      .generate(
        { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
        fakePersistedRun({ stage: 'SC' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderHttpError);
    const httpError = error as ProviderHttpError;
    expect(httpError.errorClass).toBe(errorClass);
    expect(httpError.httpStatus).toBe(status);
    expect(httpError.providerRequestId).toBe('req_failed');
    expect(httpError.message).not.toContain(API_KEY);
  });

  it('turns a transport failure into a transient network error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const error = await adapterWith(fetchImpl)
      .generate(
        { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
        fakePersistedRun({ stage: 'SC' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderNetworkError);
    expect((error as ProviderNetworkError).errorClass).toBe('transient');
  });

  it('aborts at the timeout and records that the call may have billed', async () => {
    const fetchImpl = ((_input: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;

    const error = await adapterWith(fetchImpl, { timeoutMs: 5 })
      .generate(
        { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
        fakePersistedRun({ stage: 'SC' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect((error as ProviderTimeoutError).mayHaveBilled).toBe(true);
    expect((error as ProviderTimeoutError).errorClass).toBe('transient');
  });

  it('rejects content that does not parse as JSON', async () => {
    const { fetchImpl } = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'req_bad',
            choices: [{ message: { content: 'not json at all' } }],
            model: DEEPSEEK_DEFAULT_MODEL,
          }),
          { status: 200 },
        ),
    );

    const error = await adapterWith(fetchImpl)
      .generate(
        { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
        fakePersistedRun({ stage: 'SC' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderSchemaError);
    expect((error as ProviderSchemaError).errorClass).toBe('non_retryable');
    expect((error as ProviderSchemaError).schemaVersion).toBe('script.v1');
  });

  it('rejects a schema violation and names the failing field (R-004-2 hand-off data)', async () => {
    const broken = { ...QUIET_MACHINES_FIXTURES.script, hashtags: 'not-an-array' };
    const { fetchImpl } = capturingFetch(() => providerResponse('broken', broken));

    const error = await adapterWith(fetchImpl)
      .generate(
        { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
        fakePersistedRun({ stage: 'SC' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderSchemaError);
    const schemaError = error as ProviderSchemaError;
    expect(schemaError.fieldErrors.join(' ')).toContain('hashtags');
    expect(schemaError.message).toContain('script.v1');
    // A wrong shape is never retried in place: the provider call already billed.
    expect(schemaError.errorClass).toBe('non_retryable');
  });

  it('rejects a provider envelope with no request id', async () => {
    const { fetchImpl } = capturingFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
        }),
    );

    const error = await adapterWith(fetchImpl)
      .generate(
        { stage: 'T', schema: TEXT_SCHEMAS.topic, messages: MESSAGES },
        fakePersistedRun({ stage: 'T' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).errorClass).toBe('non_retryable');
  });
});

describe('DeepSeekTextAdapter.forRequest (TECH_DESIGN §3.5)', () => {
  it('returns the B-02 ProviderAdapter surface bound to the request', async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      providerResponse('storyboard', QUIET_MACHINES_FIXTURES.storyboard),
    );
    const adapter = adapterWith(fetchImpl);
    const request = {
      stage: 'SB',
      schema: TEXT_SCHEMAS.storyboard,
      messages: MESSAGES,
    } as const;

    const bound = adapter.forRequest(request);
    expect(bound.provider).toBe('deepseek');
    expect(bound.stage).toBe('SB');

    const run = fakePersistedRun({ stage: 'SB' });
    const result = await bound.execute(run);

    expect(result.content).toEqual(QUIET_MACHINES_FIXTURES.storyboard);
    expect(calls).toHaveLength(1);

    const spy = vi.spyOn(adapter, 'generate');
    await bound.execute(run);
    expect(spy).toHaveBeenCalledWith(request, run);
  });
});
