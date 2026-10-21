/**
 * FakeTextAdapter — the deterministic, in-memory stand-in for DeepSeek chat
 * (TECH_DESIGN §6: "Providers are never called in tests").
 *
 * It honours the same `TextAdapter` surface and the same `generation_run`
 * contract as the real adapter, so B-08/B-09 tests exercise the real call path
 * with zero sockets. Determinism is deliberate and testable:
 * - content is the canonical fixture for the requested schema version,
 * - `provider_request_id` is derived from the run id and schema version, so the
 *   same run produces the same bytes on every run,
 * - a scripted `responses` queue can inject a failure without a network.
 */
import {
  AdapterStageMismatchError,
  type PersistedGenerationRun,
  type ProviderAdapter,
} from '../domain/generation-run.js';
import { ProviderHttpError, ProviderSchemaError, ProviderTimeoutError } from './errors.js';
import { fixtureFor } from './text-fixtures.js';
import {
  runTextQualification,
  TEXT_PROVIDER,
  TEXT_TIMEOUT_MS,
  type ChatMessage,
  type TextAdapter,
  type TextQualificationDeps,
  type TextQualificationOutcome,
  type TextRequest,
  type TextResult,
} from './text.js';
import type { TextSchema } from './text-schemas.js';

/** One scripted reply. The queue is consumed in order; an empty queue means success. */
export type FakeTextResponse =
  | { readonly kind: 'ok' }
  | { readonly kind: 'content'; readonly content: unknown }
  | { readonly kind: 'invalid-schema'; readonly content: unknown }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'timeout' };

export interface RecordedTextCall {
  readonly runId: string;
  readonly stage: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly messages: readonly ChatMessage[];
}

export interface FakeTextAdapterOptions {
  readonly model?: string;
  readonly responses?: readonly FakeTextResponse[];
}

export class FakeTextAdapter implements TextAdapter {
  readonly provider = TEXT_PROVIDER;
  readonly idempotencyProtected = false as const;
  readonly model: string;
  readonly calls: RecordedTextCall[] = [];
  private readonly responses: FakeTextResponse[];

  constructor(options: FakeTextAdapterOptions = {}) {
    this.model = options.model ?? 'fake-text';
    this.responses = [...(options.responses ?? [])];
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
    if (run.stage !== req.stage) {
      throw new AdapterStageMismatchError(req.stage, run.stage, run.id);
    }

    this.calls.push({
      runId: run.id,
      stage: req.stage,
      schemaName: req.schema.name,
      schemaVersion: req.schema.version,
      messages: req.messages,
    });

    const scripted = this.responses.shift() ?? { kind: 'ok' };

    if (scripted.kind === 'http') {
      throw new ProviderHttpError({
        provider: this.provider,
        httpStatus: scripted.status,
        providerRequestId: this.requestId(run, req.schema),
        detail: 'scripted fake failure',
      });
    }
    if (scripted.kind === 'timeout') {
      throw new ProviderTimeoutError(this.provider, TEXT_TIMEOUT_MS);
    }

    const content =
      scripted.kind === 'content' || scripted.kind === 'invalid-schema'
        ? scripted.content
        : fixtureFor(req.schema.name);

    if (scripted.kind === 'invalid-schema') {
      const parsed = req.schema.schema.safeParse(content);
      throw new ProviderSchemaError(
        this.provider,
        req.schema.version,
        parsed.success
          ? ['(root): scripted schema failure']
          : parsed.error.issues.map((issue) => {
              const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
              return `${path}: ${issue.message}`;
            }),
      );
    }

    let validated: Out;
    try {
      validated = req.schema.parse(content);
    } catch (error) {
      throw new ProviderSchemaError(this.provider, req.schema.version, [
        error instanceof Error ? error.message : String(error),
      ]);
    }

    const providerRequestId = this.requestId(run, req.schema);
    const serialised = JSON.stringify(validated);
    const raw = {
      id: providerRequestId,
      object: 'chat.completion',
      model: this.model,
      choices: [{ index: 0, message: { role: 'assistant', content: serialised } }],
      usage: {
        prompt_tokens: this.tokensOf(req.messages.map((message) => message.content).join(' ')),
        completion_tokens: this.tokensOf(serialised),
      },
    };

    return {
      content: validated,
      raw,
      provider_request_id: providerRequestId,
      model: this.model,
      http_status: 200,
      usage: {
        prompt_tokens: raw.usage.prompt_tokens,
        completion_tokens: raw.usage.completion_tokens,
      },
    };
  }

  /** `fake-<run prefix>-<schema version>`: stable for a run, distinct across runs. */
  private requestId(
    run: PersistedGenerationRun,
    schema: TextSchema<unknown> | TextSchema<never>,
  ): string {
    return `fake-${run.id.slice(0, 8)}-${schema.version}`;
  }

  /** A deterministic stand-in for token accounting (`ceil(bytes / 4)`). */
  private tokensOf(value: string): number {
    return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
  }
}
