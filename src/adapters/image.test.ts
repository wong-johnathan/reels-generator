import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { PersistedGenerationRun } from '../domain/generation-run.js';
import { ProviderRequestError, classifyHttpStatus } from './errors.js';
import { encodePng } from './image-bytes.js';
import {
  GeminiImageAdapter,
  geminiImageAdapterFromEnv,
  ImageConfigError,
  ImageRequestValidationError,
  MAX_REFERENCE_IMAGES,
  type ImageCallContext,
  type ImageGenerateRequest,
  type InlineImageData,
} from './image.js';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function callContext(prompt: string): ImageCallContext {
  return { id: `run-${sha256(prompt).slice(0, 8)}`, stage: 'IM', promptHash: sha256(prompt) };
}

/** The branded run the B-08 worker hands to `execute()`; the cast is the test's. */
function persistedRun(prompt: string): PersistedGenerationRun {
  return {
    id: callContext(prompt).id,
    jobAttemptId: 'attempt-1',
    projectId: 'project-1',
    stage: 'IM',
    sceneId: 'scene-1',
    provider: 'gemini',
    model: 'gemini-nano-banana-2.1',
    promptHash: sha256(prompt),
    attemptNo: 1,
    seriesVersionId: 'version-1',
    status: 'pending',
    chargeStatus: 'pending',
    idempotencyProtected: false,
    committedAt: new Date(0),
    committedByBackendPid: 1,
  } as unknown as PersistedGenerationRun;
}

function reference(id: number): InlineImageData {
  return {
    mime_type: 'image/png',
    data: Buffer.from(`reference-${id}`).toString('base64'),
  };
}

function request(overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest {
  return {
    prompt: 'wide shot, rain, blue streetlamp',
    reference_images: [reference(1), reference(2)],
    ...overrides,
  };
}

function jpegBytes(width = 768, height = 1376): Uint8Array {
  const high = (value: number) => Math.floor(value / 256) % 256;
  const low = (value: number) => value % 256;
  return new Uint8Array(
    Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      high(height),
      low(height),
      high(width),
      low(width),
      0x03,
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
      0xff,
      0xd9,
    ]),
  );
}

function geminiBody(options: {
  image?: Uint8Array;
  mimeType?: string;
  responseId?: string;
  parts?: unknown[];
}): string {
  const image = options.image ?? jpegBytes();
  const parts = options.parts ?? [
    {
      inlineData: {
        mimeType: options.mimeType ?? 'image/jpeg',
        data: Buffer.from(image).toString('base64'),
      },
    },
  ];
  return JSON.stringify({
    ...(options.responseId === undefined ? {} : { responseId: options.responseId }),
    candidates: [{ content: { parts } }],
  });
}

interface HttpCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(handler: (call: HttpCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: HttpCall[];
} {
  const calls: HttpCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function adapterWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new GeminiImageAdapter({
    apiKey: 'test-key-not-a-secret',
    model: 'gemini-nano-banana-2.1',
    imageSize: '1K',
    fetchImpl,
    ...overrides,
  });
}

describe('GeminiImageAdapter request construction (US-011, R-008-1)', () => {
  it('sends the prompt then each reference as inlineData, 9:16 at the configured size', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    const adapter = adapterWith(fetchImpl);

    await adapter.generate(request(), callContext(request().prompt));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent',
    );
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('test-key-not-a-secret');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      contents: { role: string; parts: Record<string, unknown>[] }[];
      generationConfig: { responseModalities: string[]; imageConfig: Record<string, string> };
    };
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]!.role).toBe('user');
    expect(body.contents[0]!.parts).toHaveLength(3);
    expect(body.contents[0]!.parts[0]).toEqual({ text: request().prompt });
    expect(body.contents[0]!.parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: reference(1).data },
    });
    expect(body.contents[0]!.parts[2]).toEqual({
      inlineData: { mimeType: 'image/png', data: reference(2).data },
    });
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '9:16', imageSize: '1K' });
  });

  it('accepts exactly 14 references (the D4 ceiling) and rejects the 15th before any HTTP call', async () => {
    const accepted = fakeFetch(() => jsonResponse(geminiBody({ responseId: 'resp-1' })));
    const adapter = adapterWith(accepted.fetchImpl);
    const fourteen = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => reference(index));

    await adapter.generate(request({ reference_images: fourteen }), callContext('fourteen'));
    const body = JSON.parse(String(accepted.calls[0]!.init.body)) as {
      contents: { parts: unknown[] }[];
    };
    expect(body.contents[0]!.parts).toHaveLength(1 + MAX_REFERENCE_IMAGES);

    const rejected = fakeFetch(() => jsonResponse(geminiBody({ responseId: 'resp-1' })));
    const tooMany = adapterWith(rejected.fetchImpl);
    await expect(
      tooMany.generate(
        request({ reference_images: [...fourteen, reference(99)] }),
        callContext('fifteen'),
      ),
    ).rejects.toBeInstanceOf(ImageRequestValidationError);
    expect(rejected.calls).toHaveLength(0);
  });

  it('rejects malformed requests before any HTTP call', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    const adapter = adapterWith(fetchImpl);

    const cases: ImageGenerateRequest[] = [
      request({ prompt: '   ' }),
      request({ reference_images: [{ mime_type: 'image/png', data: '' }] }),
      request({ reference_images: [{ mime_type: 'image/png', data: 'not base64 !!' }] }),
      request({
        reference_images: [
          { mime_type: 'application/pdf' as InlineImageData['mime_type'], data: 'AAAA' },
        ],
      }),
      request({ aspect_ratio: '4:5' as ImageGenerateRequest['aspect_ratio'] }),
      request({ image_size: '3K' as ImageGenerateRequest['image_size'] }),
    ];

    for (const bad of cases) {
      await expect(adapter.generate(bad, callContext('bad'))).rejects.toBeInstanceOf(
        ImageRequestValidationError,
      );
    }
    expect(calls).toHaveLength(0);
  });
});

describe('GeminiImageAdapter response handling', () => {
  it('returns the image bytes, actual geometry, mime, seed-less result and provider request id', async () => {
    const image = jpegBytes();
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(geminiBody({ image, responseId: 'resp-42' })),
    );
    const adapter = adapterWith(fetchImpl);

    const result = await adapter.generate(request(), callContext(request().prompt));

    expect(Buffer.from(result.image_bytes).equals(Buffer.from(image))).toBe(true);
    expect(result.mime_type).toBe('image/jpeg');
    expect(result.width).toBe(768);
    expect(result.height).toBe(1376);
    expect(result.provider_request_id).toBe('resp-42');
    expect(result.model).toBe('gemini-nano-banana-2.1');
    expect(result.idempotency_protected).toBe(false);
    expect(result.seed).toBeUndefined();
    expect(result.run_id).toBe(callContext(request().prompt).id);
  });

  it('falls back to the response header for the provider request id', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(geminiBody({}), 200, { 'x-goog-request-id': 'header-request-id' }),
    );
    const result = await adapterWith(fetchImpl).generate(request(), callContext('header'));
    expect(result.provider_request_id).toBe('header-request-id');
  });

  it('refuses a billed 200 that carries no provider request id (R-013 provenance)', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(geminiBody({})));
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('no-id'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.failureClass).toBe('non_retryable');
    expect(error.billedUnknown).toBe(true);
    expect(error.message).toContain('request id');
  });

  it('treats a 200 without an image part as a non-retryable billed refusal', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        geminiBody({ parts: [{ text: 'I cannot create that image.' }], responseId: 'r-1' }),
      ),
    );
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('refusal'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('non_retryable');
    expect(error.billedUnknown).toBe(true);
    expect(error.message).toContain('no image');
  });

  it('treats an unparseable 200 as a non-retryable billed contract failure', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse('not json', 200));
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('garbled'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('non_retryable');
    expect(error.billedUnknown).toBe(true);
  });

  it('rejects an image container it cannot measure instead of reporting a guessed geometry', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        geminiBody({
          image: encodePng({ width: 2, height: 2, pixel: () => [0, 0, 0] }),
          mimeType: 'image/webp',
        }),
      ),
    );
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('webp'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('non_retryable');
    expect(error.billedUnknown).toBe(true);
  });
});

describe('GeminiImageAdapter failure classification (R-011-2, R-012-4)', () => {
  it('classifies 429 as transient, unbilled and honours Retry-After', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse('{"error":"rate limited"}', 429, { 'retry-after': '7' }),
    );
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('429'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('transient');
    expect(error.httpStatus).toBe(429);
    expect(error.billedUnknown).toBe(false);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it('classifies 500 as transient with an unknown charge', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse('{"error":"boom"}', 500));
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('500'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('transient');
    expect(error.httpStatus).toBe(500);
    expect(error.billedUnknown).toBe(true);
  });

  it('classifies 401 as non-retryable and unbilled', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse('{"error":"bad key"}', 401));
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('401'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('non_retryable');
    expect(error.httpStatus).toBe(401);
    expect(error.billedUnknown).toBe(false);
  });

  it('classifies 400 as non-retryable and unbilled', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse('{"error":"bad request"}', 400));
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('400'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('non_retryable');
    expect(error.billedUnknown).toBe(false);
  });

  it('classifies a network failure as transient with an unknown charge', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const error = (await adapterWith(fetchImpl)
      .generate(request(), callContext('network'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('transient');
    expect(error.billedUnknown).toBe(true);
  });

  it('aborts at the configured timeout and marks the charge unknown (R-012-4)', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abort = new Error('The operation was aborted.');
          abort.name = 'AbortError';
          reject(abort);
        });
      })) as typeof fetch;

    const error = (await adapterWith(fetchImpl, { timeoutMs: 5 })
      .generate(request(), callContext('timeout'))
      .catch((caught: unknown) => caught)) as ProviderRequestError;

    expect(error.failureClass).toBe('transient');
    expect(error.billedUnknown).toBe(true);
    expect(error.message).toContain('timed out');
  });
});

describe('GeminiImageAdapter integration with the adapter contract', () => {
  it('consults the rate limiter before issuing the request', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    const limiter = {
      acquired: 0,
      async acquire() {
        this.acquired += 1;
      },
    };
    const adapter = adapterWith(fetchImpl, { rateLimiter: limiter });

    await adapter.generate(request(), callContext('rate'));

    expect(limiter.acquired).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('sends nothing when the rate limiter rejects', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    const limiter = {
      async acquire() {
        throw new Error('rate limit wait failed');
      },
    };
    const adapter = adapterWith(fetchImpl, { rateLimiter: limiter });

    await expect(adapter.generate(request(), callContext('limiter'))).rejects.toThrow(
      'rate limit wait failed',
    );
    expect(calls).toHaveLength(0);
  });
  it('exports the B-02 ProviderAdapter shape through bind(), with stage IM', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    const adapter = adapterWith(fetchImpl);
    const bound = adapter.bind(request());

    expect(bound.provider).toBe('gemini');
    expect(bound.stage).toBe('IM');
    const result = await bound.execute(persistedRun(request().prompt));

    expect(result.provider_request_id).toBe('resp-1');
    expect(calls).toHaveLength(1);
  });

  it('ignores an injected global fetch when a fetch implementation was configured', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    await adapterWith(fetchImpl).generate(request(), callContext('no-global'));
    expect(globalFetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe('geminiImageAdapterFromEnv (R-008-1 configurable model/size/timeout/rate)', () => {
  it('reads the model, image size, timeout and rate limit from the validated config', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(geminiBody({ responseId: 'resp-1' })),
    );
    const adapter = geminiImageAdapterFromEnv(
      {
        GEMINI_API_KEY: 'env-key-not-a-secret',
        GEMINI_IMAGE_MODEL: 'gemini-3-pro-image',
        GEMINI_IMAGE_SIZE: '2K',
        PROVIDER_TIMEOUT_IMAGE_S: '45',
        PROVIDER_RATE_LIMIT_PER_MIN: '22',
      },
      { fetchImpl },
    );

    expect(adapter.model).toBe('gemini-3-pro-image');
    expect(adapter.imageSize).toBe('2K');
    expect(adapter.timeoutMs).toBe(45_000);
    expect(adapter.rateLimitPerMinute).toBe(22);

    await adapter.generate(request(), callContext('env'));
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      generationConfig: { imageConfig: Record<string, string> };
    };
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '9:16', imageSize: '2K' });
    expect(calls[0]!.url).toContain('/models/gemini-3-pro-image:generateContent');
  });

  it('rejects a missing key or an invalid configured value with a named config error', () => {
    expect(() => geminiImageAdapterFromEnv({})).toThrow(ImageConfigError);
    expect(() =>
      geminiImageAdapterFromEnv({ GEMINI_API_KEY: 'k', GEMINI_IMAGE_SIZE: '3K' }),
    ).toThrow(ImageConfigError);
    expect(() =>
      geminiImageAdapterFromEnv({ GEMINI_API_KEY: 'k', PROVIDER_TIMEOUT_IMAGE_S: '0' }),
    ).toThrow(ImageConfigError);
    expect(() =>
      geminiImageAdapterFromEnv({ GEMINI_API_KEY: 'k', PROVIDER_RATE_LIMIT_PER_MIN: '0' }),
    ).toThrow(ImageConfigError);
  });
});

describe('classifyHttpStatus', () => {
  it('treats 429 and 5xx as transient and every other status as non-retryable', () => {
    expect(classifyHttpStatus(429)).toBe('transient');
    expect(classifyHttpStatus(500)).toBe('transient');
    expect(classifyHttpStatus(503)).toBe('transient');
    expect(classifyHttpStatus(400)).toBe('non_retryable');
    expect(classifyHttpStatus(401)).toBe('non_retryable');
    expect(classifyHttpStatus(404)).toBe('non_retryable');
  });
});
