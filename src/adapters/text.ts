/**
 * Text adapter — DeepSeek chat (TECH_DESIGN §5.1, US-011 text half, US-012 text qual).
 *
 * Contract shape:
 * - `generate(req, run)` takes an already-persisted `PersistedGenerationRun`
 *   (B-02's brand, §3.5). `forRequest()` returns the `ProviderAdapter` surface
 *   (`execute(run)`) so B-08's `executePersisted()` wrapper can verify the run is
 *   committed, and check the stage, before this class ever opens a socket.
 * - The adapter never retries: it classifies (see `errors.ts`). Backoff and the
 *   three-attempt ceiling are B-08's, R-011-2.
 * - Idempotency is declared **unprotected** (`idempotencyProtected === false`,
 *   R-012-2 / TECH_DESIGN §5.5): DeepSeek honours no client key, so the
 *   ≤1-billable guarantee is the commit-before-call rule, not a header.
 * - `qualify()` runs the R-008-3 text threshold — a schema-conformant response
 *   for each of the three text schemas — and writes one
 *   `provider_qualification` row with pass/fail + date.
 *
 * DeepSeek specifics: `POST {baseUrl}/chat/completions`, `Authorization: Bearer`,
 * `response_format: { type: 'json_object' }` (DeepSeek honours JSON mode, not a
 * caller-supplied JSON Schema). The versioned zod schema is therefore enforced
 * locally and is the authority for R-004-1.
 */
import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import type { Queryable } from '../db/client.js';
import {
  insertQualification,
  type ProviderQualificationRow,
} from '../db/repositories/provider-qualifications.js';
import {
  AdapterStageMismatchError,
  type PersistedGenerationRun,
  type ProviderAdapter,
} from '../domain/generation-run.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
  ProviderSchemaError,
  ProviderTimeoutError,
  type ProviderErrorClass,
} from './errors.js';
import { TokenBucketRateLimiter, type RateLimiter } from './rate-limit.js';
import {
  schemaHashOf,
  TEXT_SCHEMAS,
  type JsonSchema,
  type TextSchema,
  type TextSchemaName,
  type TextStageCode,
} from './text-schemas.js';

export const TEXT_PROVIDER = 'deepseek';
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
/** TECH_DESIGN §5.1: text timeout 60 s, configurable at the worker boundary. */
export const TEXT_TIMEOUT_MS = 60_000;
/** TECH_DESIGN §5.7: 10 requests/min per provider key. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
/** Stamped on every qualification row so a behaviour change is traceable. */
export const TEXT_ADAPTER_VERSION = 'text-adapter.v1';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** One structured-output request. The schema is the validator *and* the version. */
export interface TextRequest<Out> {
  readonly stage: TextStageCode;
  readonly schema: TextSchema<Out>;
  readonly messages: readonly ChatMessage[];
  /** Per-request override of the adapter's configured model id (R-008-1). */
  readonly model?: string;
  readonly temperature?: number;
  readonly max_tokens?: number;
}

export interface TextUsage {
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
}

export interface TextResult<Out> {
  readonly content: Out;
  /** The provider envelope, for provenance/debugging. Never contains the key. */
  readonly raw: unknown;
  readonly provider_request_id: string;
  readonly model: string;
  readonly http_status: number;
  readonly usage: TextUsage;
}

/** What a text adapter must implement, regardless of whether it talks to HTTP. */
export interface TextGeneration {
  readonly provider: string;
  readonly model: string;
  generate<Out>(req: TextRequest<Out>, run: PersistedGenerationRun): Promise<TextResult<Out>>;
}

export interface TextQualificationOpenRunInput {
  readonly stage: TextStageCode;
  readonly schemaName: TextSchemaName;
  readonly schemaVersion: string;
  readonly promptHash: string;
}

/**
 * Qualification needs two collaborators it does not own:
 * - the database, to write the `provider_qualification` row (§5.6);
 * - `openRun`, which must persist a committed `generation_run` before each
 *   qualification call. The worker/ops caller supplies it (B-08/B-13), so
 *   qualification cannot bypass the attempt-row rule (R-012-1).
 */
export interface TextQualificationDeps {
  readonly db: Queryable;
  readonly openRun: (input: TextQualificationOpenRunInput) => Promise<PersistedGenerationRun>;
}

export interface TextQualificationCheck {
  readonly stage: TextStageCode;
  readonly schema: TextSchemaName;
  readonly schema_version: string;
  readonly passed: boolean;
  readonly error_class: ProviderErrorClass | null;
  readonly error_code: string | null;
  readonly field_errors: readonly string[];
  /** Adapter-generated summary; never model content and never a credential. */
  readonly error_message: string | null;
}

export interface TextQualificationDetails {
  readonly adapter: 'text';
  readonly adapter_version: string;
  readonly provider: string;
  readonly model: string;
  readonly checks: readonly TextQualificationCheck[];
  readonly schema_hashes: Readonly<Record<TextSchemaName, string>>;
}

export interface TextQualificationOutcome {
  readonly passed: boolean;
  readonly details: TextQualificationDetails;
  /** The row as written; a failed qualification is recorded too (§5.6). */
  readonly row: ProviderQualificationRow;
}

export interface TextAdapter extends TextGeneration {
  /** R-012-2: every current provider is unprotected, recorded, not hidden. */
  readonly idempotencyProtected: false;
  forRequest<Out>(req: TextRequest<Out>): ProviderAdapter<TextResult<Out>>;
  qualify(deps: TextQualificationDeps): Promise<TextQualificationOutcome>;
}

export interface ChatRequestBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: false;
  readonly response_format: { readonly type: 'json_object' };
  readonly temperature?: number;
  readonly max_tokens?: number;
}

/** The exact body sent to DeepSeek. Exported so a test can assert it without a socket. */
export function buildChatRequestBody<Out>(req: TextRequest<Out>, model: string): ChatRequestBody {
  return {
    model,
    messages: req.messages,
    stream: false,
    response_format: { type: 'json_object' },
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.max_tokens === undefined ? {} : { max_tokens: req.max_tokens }),
  };
}

/** The identity of a stage's document, for prompt construction. */
export interface TextSchemaDescriptor {
  readonly name: TextSchemaName;
  readonly version: string;
  readonly jsonSchema: JsonSchema;
}

/** The qualification prompt for one schema. Deterministic: same bytes every run. */
export function qualificationMessages(schema: TextSchemaDescriptor): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are qualifying a structured-output contract. Reply with a single JSON object and nothing else.',
    },
    {
      role: 'user',
      content: [
        `Produce one complete "${schema.name}" document that validates against ${schema.version}.`,
        `JSON Schema: ${JSON.stringify(schema.jsonSchema)}`,
        'Use short, plausible English content. Do not add commentary or markdown fences.',
      ].join('\n'),
    },
  ];
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fieldErrorsOf(error: unknown): string[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}

function trimMessage(message: string): string {
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

async function qualifyOne<Out>(
  generation: TextGeneration,
  schema: TextSchema<Out>,
  deps: TextQualificationDeps,
): Promise<TextQualificationCheck> {
  const messages = qualificationMessages(schema);
  const run = await deps.openRun({
    stage: schema.stage,
    schemaName: schema.name,
    schemaVersion: schema.version,
    promptHash: sha256Hex(JSON.stringify(messages)),
  });

  const base = {
    stage: schema.stage,
    schema: schema.name,
    schema_version: schema.version,
  } as const;

  try {
    await generation.generate({ stage: schema.stage, schema, messages }, run);
    return {
      ...base,
      passed: true,
      error_class: null,
      error_code: null,
      field_errors: [],
      error_message: null,
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ...base,
        passed: false,
        error_class: error.errorClass,
        error_code: error.code,
        field_errors: error instanceof ProviderSchemaError ? error.fieldErrors : [],
        error_message: trimMessage(error.message),
      };
    }
    // An unexpected throw is a bug in the adapter or the caller, not a provider
    // verdict: record it as a failure rather than letting qualification pass.
    return {
      ...base,
      passed: false,
      error_class: 'non_retryable',
      error_code: 'unexpected_error',
      field_errors: [],
      error_message: trimMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Run the text qualification and record it (R-008-3, TECH_DESIGN §5.6).
 *
 * One provider call per schema (topic, script, storyboard), each against its own
 * committed run, then **one** `provider_qualification` row whose `passed` is the
 * conjunction. The row is written on failure too: the gate reads the newest row,
 * so an absent row and a failed row both refuse billable calls.
 */
export async function runTextQualification(
  generation: TextGeneration,
  deps: TextQualificationDeps,
): Promise<TextQualificationOutcome> {
  const checks: TextQualificationCheck[] = [
    await qualifyOne(generation, TEXT_SCHEMAS.topic, deps),
    await qualifyOne(generation, TEXT_SCHEMAS.script, deps),
    await qualifyOne(generation, TEXT_SCHEMAS.storyboard, deps),
  ];

  const details: TextQualificationDetails = {
    adapter: 'text',
    adapter_version: TEXT_ADAPTER_VERSION,
    provider: generation.provider,
    model: generation.model,
    checks,
    schema_hashes: {
      topic: schemaHashOf(TEXT_SCHEMAS.topic),
      script: schemaHashOf(TEXT_SCHEMAS.script),
      storyboard: schemaHashOf(TEXT_SCHEMAS.storyboard),
    },
  };

  const row = await insertQualification(deps.db, {
    provider: generation.provider,
    adapter: 'text',
    passed: checks.every((check) => check.passed),
    details,
  });

  return { passed: row.passed, details, row };
}

export interface DeepSeekTextAdapterConfig {
  /** DEEPSEEK_API_KEY. Required: the real adapter never runs without one. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly rateLimiter?: RateLimiter;
  /** Injected for tests; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class DeepSeekTextAdapter implements TextAdapter {
  readonly provider = TEXT_PROVIDER;
  readonly idempotencyProtected = false as const;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DeepSeekTextAdapterConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
      throw new Error(
        'DEEPSEEK_API_KEY is required for DeepSeekTextAdapter; use FakeTextAdapter in tests',
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model ?? DEEPSEEK_DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? TEXT_TIMEOUT_MS;
    this.rateLimiter =
      config.rateLimiter ??
      new TokenBucketRateLimiter({ perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE });
    this.fetchImpl =
      config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  }

  forRequest<Out>(req: TextRequest<Out>): ProviderAdapter<TextResult<Out>> {
    return {
      provider: this.provider,
      stage: req.stage,
      execute: (run: PersistedGenerationRun) => this.generate(req, run),
    };
  }

  qualify(deps: TextQualificationDeps): Promise<TextQualificationOutcome> {
    return runTextQualification(this, deps);
  }

  async generate<Out>(
    req: TextRequest<Out>,
    run: PersistedGenerationRun,
  ): Promise<TextResult<Out>> {
    // A script schema must never be called under a topic run: the row records
    // the call, so the stage mismatch is caught before the socket.
    if (run.stage !== req.stage) {
      throw new AdapterStageMismatchError(req.stage, run.stage, run.id);
    }

    await this.rateLimiter.acquire();

    const body = buildChatRequestBody(req, req.model ?? this.model);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new ProviderTimeoutError(this.provider, this.timeoutMs, error);
        throw new ProviderNetworkError(this.provider, error);
      }

      if (!response.ok) {
        const detail = await errorDetailOf(response);
        throw new ProviderHttpError({
          provider: this.provider,
          httpStatus: response.status,
          providerRequestId: response.headers.get('x-request-id'),
          ...(detail === null ? {} : { detail }),
        });
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch (error) {
        if (timedOut) throw new ProviderTimeoutError(this.provider, this.timeoutMs, error);
        throw new ProviderResponseError(this.provider, 'body is not JSON');
      }

      const envelope = raw as {
        id?: unknown;
        model?: unknown;
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const providerRequestId = typeof envelope.id === 'string' ? envelope.id.trim() : '';
      if (providerRequestId === '') {
        // R-008-4: the request id is part of the provenance record, so a
        // response without one cannot be accepted.
        throw new ProviderResponseError(this.provider, 'missing id');
      }

      const content = envelope.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new ProviderResponseError(
          this.provider,
          'choices[0].message.content is not a string',
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ProviderSchemaError(this.provider, req.schema.version, [
          'content: not valid JSON',
        ]);
      }

      let validated: Out;
      try {
        validated = req.schema.parse(parsed);
      } catch (error) {
        throw new ProviderSchemaError(this.provider, req.schema.version, fieldErrorsOf(error));
      }

      return {
        content: validated,
        raw,
        provider_request_id: providerRequestId,
        model:
          typeof envelope.model === 'string' && envelope.model !== '' ? envelope.model : body.model,
        http_status: response.status,
        usage: {
          prompt_tokens:
            typeof envelope.usage?.prompt_tokens === 'number' ? envelope.usage.prompt_tokens : null,
          completion_tokens:
            typeof envelope.usage?.completion_tokens === 'number'
              ? envelope.usage.completion_tokens
              : null,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A short, value-free summary of a provider error body. */
async function errorDetailOf(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      const message = parsed.error?.message;
      return typeof message === 'string' ? trimMessage(message) : null;
    } catch {
      return trimMessage(text);
    }
  } catch {
    return null;
  }
}
