import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdapterStageMismatchError,
  type PersistedGenerationRun,
} from '../domain/generation-run.js';
import { deriveWordTimings, validateWordTimings } from '../domain/word-timing.js';
import { alignmentFromWords } from '../../tests/helpers/alignment.js';
import {
  asProviderAdapter,
  buildSilentWav,
  classifyTtsHttpStatus,
  ElevenLabsTtsAdapter,
  FakeTtsAdapter,
  TokenBucketRateLimiter,
  TtsProviderError,
  TtsResponseShapeError,
  TtsTimeoutError,
  ttsPromptHash,
  type TtsConvertRequest,
  type TtsQualificationEntry,
  type TtsQualificationStore,
  type TtsRunRef,
} from './tts.js';
import { TTS_QUALIFICATION_SAMPLE } from './tts-qualification-sample.js';

/**
 * B-07 / US-011 (TTS adapter) + US-012 (TTS qualification).
 *
 * No test in this file may touch the network: the ElevenLabs adapter takes an
 * injected `fetch`, and the fake is deterministic. The one test that proves the
 * fake makes no call stubs `globalThis.fetch` and asserts it is never invoked.
 */

const REQUEST: TtsConvertRequest = {
  text: 'The hum was gone.',
  voice_id: 'voice_george',
  model_id: 'eleven_multilingual_v2',
};

function runRef(overrides: Partial<TtsRunRef> = {}): TtsRunRef {
  return {
    id: 'run-0001',
    projectId: 'project-0001',
    stage: 'NA',
    promptHash: 'a'.repeat(64),
    ...overrides,
  };
}

class RecordingStore implements TtsQualificationStore {
  readonly entries: TtsQualificationEntry[] = [];
  async record(entry: TtsQualificationEntry): Promise<void> {
    this.entries.push(entry);
  }
}

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_el_123' },
    ...init,
  });
}

function elevenLabsBody(alignment = alignmentFromWords(['The', 'hum', 'was', 'gone'])): unknown {
  return {
    audio_base64: Buffer.from('ID3-fake-mp3').toString('base64'),
    alignment,
  };
}

describe('FakeTtsAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is deterministic: the same text yields the same alignment, audio and request id', async () => {
    const adapter = new FakeTtsAdapter();

    const first = await adapter.convert(REQUEST, runRef());
    const second = await adapter.convert(REQUEST, runRef());

    expect(second.alignment).toEqual(first.alignment);
    expect(Array.from(second.audio)).toEqual(Array.from(first.audio));
    expect(second.provider_request_id).toBe(first.provider_request_id);
    expect(second.duration_s).toBe(first.duration_s);
  });

  it('derives monotonic word timings with 100% coverage from its own alignment', async () => {
    const adapter = new FakeTtsAdapter();

    const result = await adapter.convert(
      { ...REQUEST, text: TTS_QUALIFICATION_SAMPLE.text },
      runRef(),
    );
    const timings = deriveWordTimings(result.alignment, { script: TTS_QUALIFICATION_SAMPLE.text });

    expect(timings.coverage.word_coverage).toBe(1);
    expect(timings.coverage.character_coverage).toBe(1);
    expect(timings.monotonic).toBe(true);
    expect(validateWordTimings(timings).ok).toBe(true);
    expect(timings.words).toHaveLength(TTS_QUALIFICATION_SAMPLE.text.trim().split(/\s+/).length);
  });

  it('reports the measured pace: duration = words / 3.035 s', async () => {
    const adapter = new FakeTtsAdapter();

    const result = await adapter.convert({ ...REQUEST, text: 'one two three four five' }, runRef());

    expect(result.duration_s).toBeCloseTo(5 / 3.035, 6);
  });

  it('returns real playable-shaped WAV bytes whose declared length matches duration_s', async () => {
    const adapter = new FakeTtsAdapter();

    const result = await adapter.convert({ ...REQUEST, text: 'one two three' }, runRef());

    const header = new DataView(
      result.audio.buffer,
      result.audio.byteOffset,
      result.audio.byteLength,
    );
    const ascii = (offset: number, length: number): string =>
      Array.from({ length }, (_, index) =>
        String.fromCharCode(header.getUint8(offset + index)),
      ).join('');

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(header.getUint32(4, true)).toBe(result.audio.byteLength - 8);
    expect(header.getUint32(24, true)).toBe(8000);
    const dataBytes = header.getUint32(40, true);
    expect(dataBytes).toBe(Math.round(result.duration_s * 8000));
  });

  it('makes no network call at all', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new FakeTtsAdapter();

    await adapter.convert(REQUEST, runRef());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never echoes the narration text in the provider request id', async () => {
    const adapter = new FakeTtsAdapter();

    const result = await adapter.convert(REQUEST, runRef());

    expect(result.provider_request_id).not.toContain('hum');
    expect(result.provider_request_id).toMatch(/^fake-tts-[0-9a-f]{16}$/);
  });

  it('replays a configured failure series so a retry test can assert exactly 3 attempts', async () => {
    const adapter = new FakeTtsAdapter({ failures: [503, 503, 503] });

    for (const expected of [503, 503, 503]) {
      await expect(adapter.convert(REQUEST, runRef())).rejects.toMatchObject({
        errorClass: 'transient',
        httpStatus: expected,
        retryable: true,
      });
    }
    expect(adapter.callCount).toBe(3);
  });

  it('classifies a 401 as non-retryable so the attempt loop fails fast', async () => {
    const adapter = new FakeTtsAdapter({ failures: [401] });

    await expect(adapter.convert(REQUEST, runRef())).rejects.toMatchObject({
      errorClass: 'non_retryable',
      retryable: false,
    });
  });

  it('declares the provider idempotency contract (R-012-2): unprotected', () => {
    const adapter = new FakeTtsAdapter();

    expect(adapter.idempotencyProtected).toBe(false);
    expect(adapter.stage).toBe('NA');
    expect(adapter.provider).toBe('fake');
    expect(adapter.adapterName).toBe('tts.fake');
  });
});

describe('ElevenLabsTtsAdapter', () => {
  it('posts convert-with-timestamps with the voice id, model id and xi-api-key', async () => {
    const captured: CapturedRequest[] = [];
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'test-key-not-a-real-secret',
      voiceId: 'voice_george',
      fetch: async (input, init) => {
        captured.push({ url: String(input), init: init ?? {} });
        return jsonResponse(elevenLabsBody());
      },
    });

    await adapter.convert(REQUEST, runRef());

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice_george/with-timestamps',
    );
    expect(captured[0]?.init.method).toBe('POST');
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('test-key-not-a-real-secret');
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({
      text: REQUEST.text,
      model_id: 'eleven_multilingual_v2',
    });
    expect(captured[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('decodes audio_base64 and returns the alignment, request id and derived duration', async () => {
    const alignment = alignmentFromWords(['The', 'hum', 'was', 'gone']);
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'k',
      voiceId: 'voice_george',
      fetch: async () => jsonResponse(elevenLabsBody(alignment)),
    });

    const result = await adapter.convert(REQUEST, runRef());

    expect(Buffer.from(result.audio).toString()).toBe('ID3-fake-mp3');
    expect(result.alignment).toEqual(alignment);
    expect(result.provider_request_id).toBe('req_el_123');
    expect(result.duration_s).toBeCloseTo(3.5, 10);
  });

  it('loads the documented defaults: 120 s timeout and 10 requests/minute (R-008-1/2)', () => {
    const adapter = new ElevenLabsTtsAdapter({ apiKey: 'k', voiceId: 'v' });

    expect(adapter.timeoutMs).toBe(120_000);
    expect(adapter.rateLimitPerMinute).toBe(10);
    expect(adapter.modelId).toBe('eleven_multilingual_v2');
    expect(adapter.idempotencyProtected).toBe(false);
  });

  it('maps a 429 to a transient error carrying the status', async () => {
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'k',
      voiceId: 'v',
      fetch: async () => new Response('rate limited', { status: 429 }),
    });

    const error = await adapter.convert(REQUEST, runRef()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TtsProviderError);
    expect(error).toMatchObject({ errorClass: 'transient', httpStatus: 429, retryable: true });
  });

  it('never puts the api key in an error message (R-015-5)', async () => {
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'sk-super-secret-value',
      voiceId: 'v',
      fetch: async () => new Response('invalid api key', { status: 401 }),
    });

    const error = (await adapter
      .convert(REQUEST, runRef())
      .catch((caught: unknown) => caught)) as Error;

    expect(error).toMatchObject({ errorClass: 'non_retryable', httpStatus: 401 });
    expect(error.message).not.toContain('sk-super-secret-value');
  });

  it('rejects a response whose alignment is missing a required field', async () => {
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'k',
      voiceId: 'v',
      fetch: async () => jsonResponse({ audio_base64: 'AAA', alignment: { characters: ['a'] } }),
    });

    const error = (await adapter
      .convert(REQUEST, runRef())
      .catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(TtsResponseShapeError);
    expect(error.message).toContain('character_start_times_seconds');
  });

  it('aborts at the configured timeout and marks that the call may have billed', async () => {
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'k',
      voiceId: 'v',
      timeoutMs: 25,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            reject(error);
          });
        }),
    });

    const startedAt = Date.now();
    const error = (await adapter
      .convert(REQUEST, runRef())
      .catch((caught: unknown) => caught)) as TtsTimeoutError;
    const elapsedMs = Date.now() - startedAt;

    expect(error).toBeInstanceOf(TtsTimeoutError);
    expect(error.mayHaveBilled).toBe(true);
    expect(error.errorClass).toBe('transient');
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('acquires the rate-limit bucket before issuing the request (R-008-2)', async () => {
    const order: string[] = [];
    const adapter = new ElevenLabsTtsAdapter({
      apiKey: 'k',
      voiceId: 'v',
      limiter: {
        async acquire() {
          order.push('acquire');
        },
      },
      fetch: async () => {
        order.push('fetch');
        return jsonResponse(elevenLabsBody());
      },
    });

    await adapter.convert(REQUEST, runRef());

    expect(order).toEqual(['acquire', 'fetch']);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('allows a burst up to the per-minute capacity, then paces at the refill rate', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const limiter = new TokenBucketRateLimiter({
      perMinute: 2,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([]);

    await limiter.acquire();
    await limiter.acquire();

    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(29_000);
    expect(sleeps[0]).toBeLessThanOrEqual(30_000);
  });

  it('refuses a non-positive rate instead of silently disabling itself', () => {
    expect(() => new TokenBucketRateLimiter({ perMinute: 0 })).toThrow(/perMinute/);
  });
});

describe('classifyTtsHttpStatus', () => {
  it('treats 429, 408 and 5xx as transient (R-011-2)', () => {
    expect(classifyTtsHttpStatus(429)).toBe('transient');
    expect(classifyTtsHttpStatus(408)).toBe('transient');
    expect(classifyTtsHttpStatus(500)).toBe('transient');
    expect(classifyTtsHttpStatus(503)).toBe('transient');
  });

  it('treats every other 4xx, including 401, as non-retryable', () => {
    expect(classifyTtsHttpStatus(400)).toBe('non_retryable');
    expect(classifyTtsHttpStatus(401)).toBe('non_retryable');
    expect(classifyTtsHttpStatus(422)).toBe('non_retryable');
  });
});

describe('ttsPromptHash', () => {
  it('is a stable 64-hex digest of the exact request', () => {
    const hash = ttsPromptHash(REQUEST);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ttsPromptHash({ ...REQUEST })).toBe(hash);
  });

  it('changes when the text, voice or model changes', () => {
    const hash = ttsPromptHash(REQUEST);

    expect(ttsPromptHash({ ...REQUEST, text: 'different' })).not.toBe(hash);
    expect(ttsPromptHash({ ...REQUEST, voice_id: 'other' })).not.toBe(hash);
    expect(ttsPromptHash({ ...REQUEST, model_id: 'other' })).not.toBe(hash);
  });
});

describe('adapter guards', () => {
  it('refuses a generation_run of another stage (X-7: NA only)', async () => {
    const adapter = new FakeTtsAdapter();

    await expect(adapter.convert(REQUEST, runRef({ stage: 'IM' }))).rejects.toBeInstanceOf(
      AdapterStageMismatchError,
    );
  });

  it('exposes the TECH_DESIGN §5.4 convert() as a ProviderAdapter for the attempt guard', async () => {
    const adapter = new FakeTtsAdapter();
    const providerAdapter = asProviderAdapter(adapter, REQUEST);
    // A branded PersistedGenerationRun can only be minted by openAttempt() (B-02's
    // DB test covers that path); here the cast proves the bridge forwards the run
    // and lets the guard call the TTS contract method.
    const run = runRef() as unknown as PersistedGenerationRun;

    const result = await providerAdapter.execute(run);

    expect(providerAdapter.provider).toBe('fake');
    expect(providerAdapter.stage).toBe('NA');
    expect(adapter.callCount).toBe(1);
    expect(result.alignment.characters.length).toBeGreaterThan(0);
  });
});

describe('buildSilentWav', () => {
  it('writes a mono 8 kHz 8-bit PCM header whose data chunk matches the duration', () => {
    const wav = buildSilentWav(0.5);

    expect(wav.byteLength).toBe(44 + 4000);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe('data');
  });
});

describe('qualification fixture', () => {
  it('is at least 60 s of speech at the measured pace and carries >=10 proper nouns', () => {
    const words = TTS_QUALIFICATION_SAMPLE.text.trim().split(/\s+/);

    expect(words.length / 3.035).toBeGreaterThanOrEqual(60);
    expect(TTS_QUALIFICATION_SAMPLE.proper_nouns.length).toBeGreaterThanOrEqual(10);
    for (const noun of TTS_QUALIFICATION_SAMPLE.proper_nouns) {
      expect(TTS_QUALIFICATION_SAMPLE.text).toContain(noun);
    }
  });
});

describe('qualify() (US-012)', () => {
  it('runs the R-008-3 thresholds on the fixture and records a pass', async () => {
    const adapter = new FakeTtsAdapter();
    const store = new RecordingStore();

    const result = await adapter.qualify({ store });

    expect(result.passed).toBe(true);
    expect(result.details).toMatchObject({
      sample_label: TTS_QUALIFICATION_SAMPLE.label,
      monotonic: true,
      character_coverage: 1,
      word_coverage: 1,
      min_sample_s: 60,
      failures: [],
    });
    expect(result.details.duration_s).toBeGreaterThanOrEqual(60);
    expect(result.details.sample_words).toBeGreaterThanOrEqual(183);

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      provider: 'fake',
      adapter: 'tts.fake',
      passed: true,
    });
    expect(store.entries[0]?.details).toMatchObject({ word_coverage: 1, monotonic: true });
  });

  it('records a failure when word coverage misses the 99% threshold', async () => {
    const words = TTS_QUALIFICATION_SAMPLE.text.trim().split(/\s+/);
    const adapter = new FakeTtsAdapter({
      alignment: alignmentFromWords(words, {
        wordSlotS: 1 / 3.035,
        speechS: 0.9 / 3.035,
        untimedWords: [1, 2, 3, 4],
      }),
    });
    const store = new RecordingStore();

    const result = await adapter.qualify({ store });

    expect(result.passed).toBe(false);
    expect(result.details.failures.join(' ')).toContain('word_coverage');
    expect(store.entries[0]?.passed).toBe(false);
  });

  it('records a failure for a sample shorter than 60 s, without calling the provider twice', async () => {
    const adapter = new FakeTtsAdapter();
    const store = new RecordingStore();

    const result = await adapter.qualify({
      store,
      sample: { label: 'too-short', text: 'one two three four', proper_nouns: [] },
    });

    expect(result.passed).toBe(false);
    expect(result.details.failures.join(' ')).toContain('sample_duration');
    expect(adapter.providerCalls).toBe(1);
    expect(store.entries[0]?.passed).toBe(false);
  });

  it('goes through convert() (stage-checked) when the caller supplies a committed run', async () => {
    const adapter = new FakeTtsAdapter();
    const store = new RecordingStore();

    await expect(adapter.qualify({ store, run: runRef({ stage: 'IM' }) })).rejects.toBeInstanceOf(
      AdapterStageMismatchError,
    );
    expect(store.entries).toHaveLength(0);

    const result = await adapter.qualify({ store, run: runRef() });

    expect(result.passed).toBe(true);
    expect(adapter.callCount).toBe(1);
  });
});
