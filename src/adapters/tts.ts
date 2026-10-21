/**
 * TTS adapter — ElevenLabs `convert-with-timestamps` (TECH_DESIGN §5.4),
 * its deterministic fake, and the R-008-3 qualification gate (US-011 TTS,
 * US-012 TTS qualification).
 *
 * Carried by every adapter per TECH_DESIGN §5:
 * - configurable model id, credentials and timeout (R-008-1; TTS default 120 s);
 * - a per-key rate limiter, default 10 requests/minute (R-008-2);
 * - a recorded `provider_qualification` row via `qualify()` (R-008-3 / §5.6);
 * - the idempotency declaration: ElevenLabs honours no client key, so
 *   `idempotencyProtected` is literally `false` (R-012-2, §5.5).
 *
 * 1. The adapter cannot be called without a committed `generation_run`.
 *    `convert(req, run)` takes a run reference and refuses any stage other than
 *    `NA`; the branded `PersistedGenerationRun` from `src/domain/generation-run.ts`
 *    only exists after a commit, and `asProviderAdapter()` is the bridge that
 *    lets the attempt guard's `executePersisted()` call this adapter.
 *
 * 2. One documented exemption: `qualify()` may call the provider without a run.
 *    A qualification happens before a project exists, so there is no
 *    `project_id` to key a `generation_run` row on. The qualification itself is
 *    recorded — provider, adapter, pass/fail, measured numbers and date — in
 *    `provider_qualification`, which is the row the worker's billable-call gate
 *    reads. If a committed run is supplied (`deps.run`), the call goes through
 *    `convert()` and the stage guard applies.
 *
 * 3. No test in this repository may reach a paid provider: the fake is
 *    deterministic, and the HTTP client is an injected `fetch`.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  AdapterStageMismatchError,
  type ProviderAdapter,
  type ProviderStageCode,
} from '../domain/generation-run.js';
import {
  alignmentDurationSeconds,
  countTextWords,
  deriveWordTimings,
  MIN_QUALIFICATION_SAMPLE_S,
  validateWordTimings,
  type CharacterAlignment,
} from '../domain/word-timing.js';
import {
  TTS_QUALIFICATION_SAMPLE,
  type TtsQualificationSample,
} from './tts-qualification-sample.js';

/** The `convert` request of TECH_DESIGN §5.4. */
export interface TtsConvertRequest {
  readonly text: string;
  readonly voice_id: string;
  readonly model_id: string;
}

/** The `convert` result of TECH_DESIGN §5.4. */
export interface TtsConvertResult {
  readonly audio: Uint8Array;
  readonly alignment: CharacterAlignment;
  readonly duration_s: number;
  readonly provider_request_id: string | null;
}

/**
 * The parts of a committed `generation_run` an adapter may read. Structurally
 * narrower than `PersistedGenerationRun` (the branded id is widened to `string`)
 * so a unit test can pass a plain literal while production still has to obtain
 * a `PersistedGenerationRun` through `openAttempt()`.
 */
export interface TtsRunRef {
  readonly id: string;
  readonly projectId: string;
  readonly stage: ProviderStageCode;
  readonly promptHash: string;
}

/** R-011-2's two error classes; the retry loop lives in B-08, not here. */
export type ProviderErrorClass = 'transient' | 'non_retryable';

export class TtsProviderError extends Error {
  readonly errorClass: ProviderErrorClass;
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(
    errorClass: ProviderErrorClass,
    message: string,
    options: { readonly httpStatus?: number | null; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TtsProviderError';
    this.errorClass = errorClass;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = errorClass === 'transient';
  }
}

/**
 * A timeout may still have been billed (R-012-4). It is transient for retry
 * purposes, but the attempt row must be marked `unknown charge`, never "unbilled".
 */
export class TtsTimeoutError extends TtsProviderError {
  readonly mayHaveBilled = true;

  constructor(timeoutMs: number) {
    super(
      'transient',
      `TTS request timed out after ${timeoutMs} ms; the provider may have billed it (R-012-4)`,
    );
    this.name = 'TtsTimeoutError';
  }
}

/** A 200 whose body is not the documented shape will not improve on retry. */
export class TtsResponseShapeError extends TtsProviderError {
  constructor(detail: string) {
    super('non_retryable', `TTS provider response is not the documented shape: ${detail}`, {
      httpStatus: 200,
    });
    this.name = 'TtsResponseShapeError';
  }
}

/** R-011-2: 408/429/5xx are transient; every other status fails fast. */
export function classifyTtsHttpStatus(status: number): ProviderErrorClass {
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'non_retryable';
}

/**
 * The canonical `generation_run.prompt_hash` for a TTS call: sha256 over the
 * exact request the provider will see, so the attempt row and the request agree.
 */
export function ttsPromptHash(request: TtsConvertRequest): string {
  const canonical = JSON.stringify({
    text: request.text,
    voice_id: request.voice_id,
    model_id: request.model_id,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface RateLimiter {
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  /** Sustained rate. Also the burst capacity unless `capacity` overrides it (R-008-2 default 10). */
  readonly perMinute: number;
  readonly capacity?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Per-provider-key token bucket (TECH_DESIGN §5.7). Exceeding it *waits* — the
 * caller's job is queued, never dropped. The clock and sleep are injectable so
 * the pacing is testable without spending real seconds.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: TokenBucketOptions) {
    if (!Number.isFinite(options.perMinute) || options.perMinute <= 0) {
      throw new Error('perMinute must be a positive number: a disabled limiter is not a limiter');
    }
    this.capacity = options.capacity ?? options.perMinute;
    this.refillPerMs = options.perMinute / 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (now - this.lastRefillMs) * this.refillPerMs,
      );
      this.lastRefillMs = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) / this.refillPerMs));
    }
  }
}

export interface TtsQualificationEntry {
  readonly provider: string;
  readonly adapter: string;
  readonly passed: boolean;
  readonly details: Record<string, unknown>;
}

/** The write port of §5.6; the Postgres implementation is `PostgresQualificationStore`. */
export interface TtsQualificationStore {
  record(entry: TtsQualificationEntry): Promise<void>;
}

export interface TtsQualificationDetails {
  readonly sample_label: string;
  readonly sample_words: number;
  readonly sample_chars: number;
  readonly duration_s: number;
  readonly character_coverage: number;
  readonly word_coverage: number;
  readonly script_coverage: number | null;
  readonly monotonic: boolean;
  readonly min_sample_s: number;
  readonly failures: readonly string[];
}

export interface TtsQualificationResult {
  readonly passed: boolean;
  readonly details: TtsQualificationDetails;
}

export interface TtsQualificationDeps {
  readonly store: TtsQualificationStore;
  /** Defaults to the D5 sample (`tts-qualification-sample.ts`). */
  readonly sample?: TtsQualificationSample;
  /** Supply when re-qualifying inside a project so the call is stage-checked. */
  readonly run?: TtsRunRef;
  readonly voiceId?: string;
  readonly modelId?: string;
}

export interface TtsAdapter {
  readonly provider: string;
  /** `provider_qualification.adapter` — identifies the implementation, not the vendor. */
  readonly adapterName: string;
  readonly stage: 'NA';
  readonly modelId: string;
  readonly voiceId: string;
  readonly timeoutMs: number;
  readonly rateLimitPerMinute: number;
  readonly idempotencyProtected: false;
  convert(request: TtsConvertRequest, run: TtsRunRef): Promise<TtsConvertResult>;
  qualify(deps: TtsQualificationDeps): Promise<TtsQualificationResult>;
}

/**
 * Shared `qualify()` (R-008-3, TECH_DESIGN §5.6): call the adapter, derive word
 * timings from the returned alignment, apply the thresholds, and record the
 * result — pass or fail — so the gate always sees the newest measurement.
 */
export abstract class BaseTtsAdapter implements TtsAdapter {
  abstract readonly provider: string;
  abstract readonly adapterName: string;
  readonly stage = 'NA' as const;
  abstract readonly modelId: string;
  abstract readonly voiceId: string;
  abstract readonly timeoutMs: number;
  readonly rateLimitPerMinute: number;
  readonly idempotencyProtected = false as const;

  protected constructor(rateLimitPerMinute: number) {
    this.rateLimitPerMinute = rateLimitPerMinute;
  }

  abstract convert(request: TtsConvertRequest, run: TtsRunRef): Promise<TtsConvertResult>;

  /**
   * The transport. No run is required: `convert()` adds the stage guard, and
   * `qualify()` is the one documented exemption (see the module docstring).
   */
  protected abstract request(request: TtsConvertRequest): Promise<TtsConvertResult>;

  async qualify(deps: TtsQualificationDeps): Promise<TtsQualificationResult> {
    const sample = deps.sample ?? TTS_QUALIFICATION_SAMPLE;
    const request: TtsConvertRequest = {
      text: sample.text,
      voice_id: deps.voiceId ?? this.voiceId,
      model_id: deps.modelId ?? this.modelId,
    };

    const converted = deps.run
      ? await this.convert(request, deps.run)
      : await this.request(request);

    const timings = deriveWordTimings(converted.alignment, { script: sample.text });
    const validation = validateWordTimings(timings);
    const failures = [...validation.failures];
    if (converted.duration_s < MIN_QUALIFICATION_SAMPLE_S) {
      failures.push(
        `sample_duration ${converted.duration_s.toFixed(2)} s < ${MIN_QUALIFICATION_SAMPLE_S} s (R-008-3)`,
      );
    }

    const details: TtsQualificationDetails = {
      sample_label: sample.label,
      sample_words: countTextWords(sample.text),
      sample_chars: sample.text.length,
      duration_s: converted.duration_s,
      character_coverage: timings.coverage.character_coverage,
      word_coverage: timings.coverage.word_coverage,
      script_coverage: timings.coverage.script_coverage,
      monotonic: timings.monotonic,
      min_sample_s: MIN_QUALIFICATION_SAMPLE_S,
      failures,
    };
    const passed = failures.length === 0;

    await deps.store.record({
      provider: this.provider,
      adapter: this.adapterName,
      passed,
      details: { ...details },
    });

    return { passed, details };
  }
}

/**
 * Bridge to the attempt guard: `executePersisted()` calls `execute(run)` on a
 * `ProviderAdapter`, while TECH_DESIGN §5.4 names the TTS method `convert(req, run)`.
 * Bind the request once, hand the guard the adapter.
 */
export function asProviderAdapter(
  adapter: TtsAdapter,
  request: TtsConvertRequest,
): ProviderAdapter<TtsConvertResult> {
  return {
    provider: adapter.provider,
    stage: 'NA',
    execute: (run) => adapter.convert(request, run),
  };
}

/**
 * A mono 8 kHz 8-bit PCM WAV of silence — deterministic, playable audio of the
 * reported duration, so downstream stages (storage, ffprobe, mix) can be
 * exercised without a provider or a checked-in binary.
 */
export function buildSilentWav(durationS: number, sampleRate = 8000): Uint8Array {
  const dataBytes = Math.max(1, Math.round(durationS * sampleRate));
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate: 1 byte/sample * 1 channel
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  new Uint8Array(buffer, 44).fill(0x80); // 8-bit unsigned silence
  return new Uint8Array(buffer);
}

/** ElevenLabs' `convert-with-timestamps` response, as much of it as we need. */
const ALIGNMENT_SCHEMA = z.object({
  characters: z.array(z.string()).min(1),
  character_start_times_seconds: z.array(z.number()).min(1),
  character_end_times_seconds: z.array(z.number()).min(1),
});

const CONVERT_RESPONSE_SCHEMA = z.object({
  audio_base64: z.string().min(1),
  alignment: ALIGNMENT_SCHEMA,
});

export interface ElevenLabsTtsOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId?: string;
  /** R-008-1: 120 s for a TTS call. */
  readonly timeoutMs?: number;
  /** R-008-2: 10 requests/minute per provider key. */
  readonly rateLimitPerMinute?: number;
  readonly baseUrl?: string;
  /** Injected in tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof fetch;
  readonly limiter?: RateLimiter;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The real TTS adapter. `qualify()` and `convert()` both go through the same
 * HTTP path, so a passing qualification measured the code that will run.
 */
export class ElevenLabsTtsAdapter extends BaseTtsAdapter {
  readonly provider = 'elevenlabs';
  readonly adapterName = 'tts.elevenlabs.convert-with-timestamps';
  readonly modelId: string;
  readonly voiceId: string;
  readonly timeoutMs: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(options: ElevenLabsTtsOptions) {
    super(options.rateLimitPerMinute ?? 10);
    if (options.apiKey.trim() === '') {
      throw new Error('ElevenLabsTtsAdapter requires an api key (value never echoed)');
    }
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId;
    this.modelId = options.modelId ?? 'eleven_multilingual_v2';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.limiter =
      options.limiter ??
      new TokenBucketRateLimiter({
        perMinute: this.rateLimitPerMinute,
        now: options.now,
        sleep: options.sleep,
      });
  }

  async convert(request: TtsConvertRequest, run: TtsRunRef): Promise<TtsConvertResult> {
    if (run.stage !== 'NA') {
      throw new AdapterStageMismatchError('NA', run.stage, run.id);
    }
    if (request.text.trim() === '') {
      throw new TtsProviderError('non_retryable', 'refusing to synthesize an empty narration text');
    }
    return this.request(request);
  }

  protected async request(request: TtsConvertRequest): Promise<TtsConvertResult> {
    await this.limiter.acquire();

    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voice_id)}/with-timestamps`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({ text: request.text, model_id: request.model_id }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.transportError(error);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.trim() === '' ? '' : `: ${detail.trim().slice(0, 200)}`;
      throw new TtsProviderError(
        classifyTtsHttpStatus(response.status),
        `elevenlabs returned HTTP ${response.status}${suffix}`,
        { httpStatus: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TtsResponseShapeError(`body is not JSON (${String(error)})`);
    }

    const parsed = CONVERT_RESPONSE_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      throw new TtsResponseShapeError(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      );
    }

    const alignment = parsed.data.alignment;
    if (
      alignment.characters.length !== alignment.character_start_times_seconds.length ||
      alignment.characters.length !== alignment.character_end_times_seconds.length
    ) {
      throw new TtsResponseShapeError(
        'alignment arrays disagree in length ' +
          `(characters=${alignment.characters.length}, ` +
          `character_start_times_seconds=${alignment.character_start_times_seconds.length}, ` +
          `character_end_times_seconds=${alignment.character_end_times_seconds.length})`,
      );
    }

    const duration_s = alignmentDurationSeconds(alignment);
    if (!Number.isFinite(duration_s) || duration_s <= 0) {
      throw new TtsResponseShapeError('alignment carries no finite character end time');
    }

    return {
      audio: new Uint8Array(Buffer.from(parsed.data.audio_base64, 'base64')),
      alignment,
      duration_s,
      provider_request_id: response.headers.get('request-id'),
    };
  }

  private transportError(error: unknown): TtsProviderError {
    if (error instanceof TtsProviderError) return error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new TtsTimeoutError(this.timeoutMs);
    }
    // Deliberately generic: the request headers carry the api key and this
    // message is logged and shipped to the operator (R-015-5).
    return new TtsProviderError(
      'transient',
      'elevenlabs request failed before a response was received (network/transport)',
      { cause: error },
    );
  }
}

/**
 * Build the character alignment a real provider would return for `text`:
 * continuous narration at the measured pace (3.035 words/s), each word filling
 * its slot, characters evenly spread. Deterministic for a given input and pace.
 */
export function fakeAlignmentFor(text: string, wordsPerSecond = 3.035): CharacterAlignment {
  const words = text.trim() === '' ? [] : text.trim().split(/\s+/);
  if (words.length === 0) {
    throw new TtsProviderError('non_retryable', 'fake TTS needs a non-empty narration text');
  }
  if (!Number.isFinite(wordsPerSecond) || wordsPerSecond <= 0) {
    throw new TtsProviderError('non_retryable', 'wordsPerSecond must be a positive number');
  }

  const slot = 1 / wordsPerSecond;
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  words.forEach((word, wordIndex) => {
    const wordStart = wordIndex * slot;
    const step = slot / word.length;
    [...word].forEach((character, charIndex) => {
      characters.push(character);
      starts.push(wordStart + charIndex * step);
      ends.push(wordStart + (charIndex + 1) * step);
    });
    if (wordIndex < words.length - 1) {
      characters.push(' ');
      starts.push((wordIndex + 1) * slot);
      ends.push((wordIndex + 1) * slot);
    }
  });

  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

export interface FakeTtsOptions {
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly wordsPerSecond?: number;
  /** HTTP-status-like failures, consumed one per `convert()` call (B-08 retry tests). */
  readonly failures?: readonly number[];
  /** Fixed payload instead of the derived one (qualification-failure tests). */
  readonly alignment?: CharacterAlignment;
  readonly timeoutMs?: number;
  readonly rateLimitPerMinute?: number;
}

/**
 * The deterministic stand-in. No network, no credentials, no clock: the same
 * text yields byte-identical audio and alignment, which is what every downstream
 * test and every CI run uses (no test may call a paid provider).
 */
export class FakeTtsAdapter extends BaseTtsAdapter {
  readonly provider = 'fake';
  readonly adapterName = 'tts.fake';
  readonly modelId: string;
  readonly voiceId: string;
  readonly timeoutMs: number;

  private readonly wordsPerSecond: number;
  private readonly failures: readonly number[];
  private readonly alignmentOverride: CharacterAlignment | undefined;
  private readonly recorded: TtsConvertRequest[] = [];
  private failureIndex = 0;
  private providerCallCount = 0;

  constructor(options: FakeTtsOptions = {}) {
    super(options.rateLimitPerMinute ?? 10);
    this.modelId = options.modelId ?? 'fake-tts-model';
    this.voiceId = options.voiceId ?? 'fake-voice';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.wordsPerSecond = options.wordsPerSecond ?? 3.035;
    this.failures = options.failures ?? [];
    this.alignmentOverride = options.alignment;
  }

  get calls(): readonly TtsConvertRequest[] {
    return this.recorded;
  }

  get callCount(): number {
    return this.recorded.length;
  }

  /** Transport calls that actually reached the (fake) provider — includes `qualify()`. */
  get providerCalls(): number {
    return this.providerCallCount;
  }

  async convert(request: TtsConvertRequest, run: TtsRunRef): Promise<TtsConvertResult> {
    if (run.stage !== 'NA') {
      throw new AdapterStageMismatchError('NA', run.stage, run.id);
    }
    this.recorded.push(request);

    const status = this.failures[this.failureIndex];
    if (status !== undefined) {
      this.failureIndex += 1;
      throw new TtsProviderError(
        classifyTtsHttpStatus(status),
        `fake provider returned HTTP ${status}`,
        { httpStatus: status },
      );
    }

    return this.request(request);
  }

  protected async request(request: TtsConvertRequest): Promise<TtsConvertResult> {
    this.providerCallCount += 1;
    const alignment = this.alignmentOverride ?? fakeAlignmentFor(request.text, this.wordsPerSecond);
    const duration_s = alignmentDurationSeconds(alignment);
    const digest = createHash('sha256')
      .update(`${request.voice_id}|${request.model_id}|${request.text}`)
      .digest('hex')
      .slice(0, 16);

    return {
      audio: buildSilentWav(duration_s),
      alignment,
      duration_s,
      provider_request_id: `fake-tts-${digest}`,
    };
  }
}
