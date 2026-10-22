/**
 * Image adapter — Gemini `gemini-nano-banana-2.1` (TECH_DESIGN §5.3, US-011).
 *
 * Contract points that are not negotiable:
 * - at most 14 reference images per request, passed as `inlineData` beside the
 *   text prompt (D4). The prompt is forwarded verbatim; the adapter does not
 *   rewrite or append prompt engineering ("no text, no lettering" belongs to
 *   the storyboard prompt, per QUALIFICATION §1);
 * - `9:16` at `imageSize` 1K (768×1376 as measured) or 2K;
 * - 60 s timeout (configurable), 10 req/min per key (configurable);
 * - no honoured idempotency key, recorded as unprotected (R-012-2);
 * - the provider request id is mandatory provenance (R-013-1) — a billed 200
 *   without one is a non-retryable contract failure, not a success;
 * - `generate()` only accepts an `ImageCallContext`, which a
 *   `PersistedGenerationRun` satisfies structurally; the production entry point
 *   is `bind(req).execute(run)` through `executePersisted()`, so the committed
 *   attempt row still precedes the socket (TECH_DESIGN §3.5).
 */
import { createHash } from 'node:crypto';

import {
  GenerationRunContractViolationError,
  type ProviderAdapter,
  type ProviderStageCode,
} from '../domain/generation-run.js';
import { classifyHttpStatus, parseRetryAfter, ProviderRequestError } from './errors.js';
import { readImageDimensions, UnsupportedImageFormatError } from './image-bytes.js';
import { TokenBucket, type RateLimiter } from './rate-limit.js';

/** D4: the documented reference-image ceiling. */
export const MAX_REFERENCE_IMAGES = 14;

/** TECH_DESIGN §5.3: 9:16 is the only aspect ratio the MVP asks for. */
export const IMAGE_ASPECT_RATIO = '9:16';

export const IMAGE_SIZES = ['1K', '2K'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Documented output geometry per size (QUALIFICATION §1 measured 1K at 768×1376). */
export interface ImageGeometry {
  readonly width: number;
  readonly height: number;
}

export const DOCUMENTED_1K_GEOMETRY: ImageGeometry = { width: 768, height: 1376 };

/** 2K is the same aspect at twice the linear size; only the ratio is contractual. */
export const DOCUMENTED_2K_GEOMETRY: ImageGeometry = { width: 1536, height: 2752 };

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

const ALLOWED_REFERENCE_MIME_TYPES: readonly ImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/** Base64 with no data: prefix, no whitespace (inlineData is strict). */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface InlineImageData {
  readonly mime_type: ImageMimeType;
  /** Base64 payload, exactly as the provider's `inlineData.data`. */
  readonly data: string;
}

/**
 * What the model needs to hear when a scene is conditioned on the established
 * protagonist. Measured: the same reference image with no words about identity still
 * produced a different person (a hooded man where the first scene had a woman),
 * while the reference plus this instruction held face, hair, glasses and jacket.
 */
export const CHARACTER_LOCK_INSTRUCTION =
  'The attached image is the established protagonist. Reproduce the SAME character ' +
  'exactly — same face, same hair, same glasses, same clothing — changing only pose, ' +
  'camera and lighting. ';

export interface ImageGenerateRequest {
  readonly prompt: string;
  /** 0..14 images; order is preserved (a character sheet can precede a style plate). */
  readonly reference_images: readonly InlineImageData[];
  readonly image_size?: ImageSize;
  readonly aspect_ratio?: typeof IMAGE_ASPECT_RATIO;
}

export interface NormalizedImageRequest {
  readonly prompt: string;
  readonly reference_images: readonly InlineImageData[];
  readonly image_size: ImageSize;
  readonly aspect_ratio: typeof IMAGE_ASPECT_RATIO;
}

/**
 * The part of a persisted run an adapter needs. `PersistedGenerationRun`
 * satisfies it structurally, so the production call path is unchanged; a
 * qualification harness can also pass an explicit non-project context.
 */
export interface ImageCallContext {
  readonly id: string;
  readonly stage: ProviderStageCode;
  readonly promptHash: string;
}

export interface ImageGenerateResult {
  readonly image_bytes: Uint8Array;
  readonly mime_type: ImageMimeType;
  /** Geometry parsed from the returned bytes, not assumed from the request. */
  readonly width: number;
  readonly height: number;
  readonly provider_request_id: string;
  readonly seed?: number;
  readonly model: string;
  /** Always false for this provider (no honoured idempotency key). */
  readonly idempotency_protected: boolean;
  /** The attempt row this call belongs to (provenance). */
  readonly run_id: string;
}

export interface ReferencePreservationInput {
  readonly sceneIndex: number;
  readonly request: ImageGenerateRequest;
  readonly result: ImageGenerateResult;
  /** sha256 of the canonical reference set (see `referenceSetDigest`). */
  readonly referenceSha256: string;
}

export interface ReferencePreservationCheck {
  readonly name: string;
  check(input: ReferencePreservationInput): {
    readonly preserved: boolean;
    readonly detail: string;
  };
}

export interface ImageAdapter {
  readonly provider: string;
  readonly adapterName: string;
  readonly stage: 'IM';
  readonly idempotencyProtected: false;
  readonly model: string;
  readonly imageSize: ImageSize;
  /** Present only when the adapter can verify reference preservation automatically. */
  readonly qualificationCheck?: ReferencePreservationCheck;
  generate(req: ImageGenerateRequest, run: ImageCallContext): Promise<ImageGenerateResult>;
  /** The B-02 structural entry point: `executePersisted(pool, adapter.bind(req), run)`. */
  bind(req: ImageGenerateRequest): ProviderAdapter<ImageGenerateResult>;
}

export class ImageRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRequestValidationError';
  }
}

export class ImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageConfigError';
  }
}

function isImageSize(value: string): value is ImageSize {
  return (IMAGE_SIZES as readonly string[]).includes(value);
}

function isAllowedMimeType(value: string): value is ImageMimeType {
  return (ALLOWED_REFERENCE_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Validate and fill defaults. Every rejection happens before a request is
 * built, so an invalid request can never become a billable call.
 */
export function normalizeImageRequest(
  request: ImageGenerateRequest,
  defaults: { readonly imageSize: ImageSize },
): NormalizedImageRequest {
  const prompt = request.prompt.trim();
  if (prompt === '') {
    throw new ImageRequestValidationError(
      'prompt must not be empty (a blank scene cannot be billed)',
    );
  }

  const references = request.reference_images;
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new ImageRequestValidationError(
      `reference_images has ${references.length} images; the provider accepts at most ${MAX_REFERENCE_IMAGES} (D4)`,
    );
  }
  for (const [index, reference] of references.entries()) {
    if (!isAllowedMimeType(reference.mime_type)) {
      throw new ImageRequestValidationError(
        `reference_images[${index}].mime_type "${reference.mime_type}" is not one of ${ALLOWED_REFERENCE_MIME_TYPES.join(', ')}`,
      );
    }
    if (reference.data === '' || !BASE64_PATTERN.test(reference.data)) {
      throw new ImageRequestValidationError(
        `reference_images[${index}].data must be non-empty base64 without a data: prefix`,
      );
    }
  }

  const imageSize = request.image_size ?? defaults.imageSize;
  if (!isImageSize(imageSize)) {
    throw new ImageRequestValidationError(
      `image_size must be one of ${IMAGE_SIZES.join(', ')}, got "${String(imageSize)}"`,
    );
  }

  if (request.aspect_ratio !== undefined) {
    if (request.aspect_ratio !== IMAGE_ASPECT_RATIO) {
      throw new ImageRequestValidationError(
        `aspect_ratio must be "${IMAGE_ASPECT_RATIO}" (TECH_DESIGN §5.3); got "${request.aspect_ratio}"`,
      );
    }
  }

  return {
    prompt,
    reference_images: references,
    image_size: imageSize,
    aspect_ratio: IMAGE_ASPECT_RATIO,
  };
}

/**
 * Canonical digest of a reference set: order-independent, mime-aware. Two
 * requests carrying the same images produce the same digest, which is what the
 * fake stamps into its output and what the qualifier compares across scenes.
 */
export function referenceSetDigest(references: readonly InlineImageData[]): string {
  const digests = references
    .map((reference) =>
      createHash('sha256').update(`${reference.mime_type}:${reference.data}`).digest('hex'),
    )
    .sort();
  return createHash('sha256').update(digests.join('\n')).digest('hex');
}

interface GeminiPart {
  readonly text?: string;
  readonly inlineData?: { readonly mimeType?: string; readonly data?: string };
}

interface GeminiResponseBody {
  readonly responseId?: string;
  readonly seed?: number;
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly GeminiPart[] };
  }[];
}

export interface GeminiImageAdapterOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly imageSize?: ImageSize;
  readonly timeoutMs?: number;
  readonly rateLimitPerMinute?: number;
  readonly rateLimiter?: RateLimiter;
  readonly baseUrl?: string;
  /** Injection seam for tests; production uses the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = 'gemini-nano-banana-2.1';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;

function positiveInteger(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ImageConfigError(`${name} must be an integer 1..${max}, got ${String(value)}`);
  }
  return value;
}

function sanitizeProviderDetail(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError';
}

export class GeminiImageAdapter implements ImageAdapter {
  readonly provider = 'gemini';
  readonly adapterName = 'GeminiImageAdapter';
  readonly stage = 'IM' as const;
  readonly idempotencyProtected = false as const;
  readonly model: string;
  readonly imageSize: ImageSize;
  readonly timeoutMs: number;
  readonly rateLimitPerMinute: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: RateLimiter;

  constructor(options: GeminiImageAdapterOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === '') {
      throw new ImageConfigError(
        'the image adapter requires a provider key from the environment contract',
      );
    }

    const imageSize = options.imageSize ?? '1K';
    if (!isImageSize(imageSize)) {
      throw new ImageConfigError(
        `GEMINI_IMAGE_SIZE must be one of ${IMAGE_SIZES.join(', ')}, got "${String(imageSize)}"`,
      );
    }

    this.apiKey = apiKey;
    this.model =
      options.model === undefined || options.model.trim() === ''
        ? DEFAULT_MODEL
        : options.model.trim();
    this.imageSize = imageSize;
    this.timeoutMs = positiveInteger(
      'PROVIDER_TIMEOUT_IMAGE_S (ms)',
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      600_000,
    );
    this.rateLimitPerMinute = positiveInteger(
      'PROVIDER_RATE_LIMIT_PER_MIN',
      options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      600,
    );
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.rateLimiter =
      options.rateLimiter ?? new TokenBucket({ perMinute: this.rateLimitPerMinute });
  }

  async generate(
    request: ImageGenerateRequest,
    run: ImageCallContext,
  ): Promise<ImageGenerateResult> {
    if (run.stage !== 'IM') {
      throw new GenerationRunContractViolationError(
        `image adapter (stage IM) cannot execute run ${run.id} of stage ${run.stage}`,
      );
    }

    const normalized = normalizeImageRequest(request, { imageSize: this.imageSize });

    // Waiting for the bucket is not a provider call: aborting here is unbilled.
    await this.rateLimiter.acquire();

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = this.buildBody(normalized);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.httpError(response, sanitizeProviderDetail(await response.text()));
      }

      const raw = await response.text();
      const payload = this.parseBody(raw);
      const providerRequestId = this.requestId(payload, response);
      const imagePart = this.imagePart(payload);
      const bytes = this.decodeImage(imagePart);
      const dimensions = readImageDimensions(bytes);
      const mimeType = this.responseMimeType(imagePart, dimensions.format);

      return {
        image_bytes: bytes,
        mime_type: mimeType,
        width: dimensions.width,
        height: dimensions.height,
        provider_request_id: providerRequestId,
        ...(typeof payload.seed === 'number' ? { seed: payload.seed } : {}),
        model: this.model,
        idempotency_protected: false,
        run_id: run.id,
      };
    } catch (error) {
      throw this.mapThrown(error);
    } finally {
      clearTimeout(timer);
    }
  }

  bind(request: ImageGenerateRequest): ProviderAdapter<ImageGenerateResult> {
    return {
      provider: this.provider,
      stage: this.stage,
      execute: (run) => this.generate(request, run),
    };
  }

  private buildBody(normalized: NormalizedImageRequest): unknown {
    return {
      contents: [
        {
          role: 'user',
          parts: [
            { text: normalized.prompt },
            ...normalized.reference_images.map((reference) => ({
              inlineData: { mimeType: reference.mime_type, data: reference.data },
            })),
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: normalized.aspect_ratio,
          imageSize: normalized.image_size,
        },
      },
    };
  }

  private httpError(response: Response, detail: string): ProviderRequestError {
    const status = response.status;
    const failureClass = classifyHttpStatus(status);
    const billedUnknown = status >= 500;
    const suffix = detail === '' ? '' : `: ${detail}`;
    return new ProviderRequestError(`gemini image request failed with HTTP ${status}${suffix}`, {
      failureClass,
      httpStatus: status,
      billedUnknown,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }

  private parseBody(raw: string): GeminiResponseBody {
    try {
      return JSON.parse(raw) as GeminiResponseBody;
    } catch (error) {
      throw new ProviderRequestError(
        'gemini image provider returned a 200 whose body is not JSON: the call may have billed (R-012-4)',
        { failureClass: 'non_retryable', httpStatus: 200, billedUnknown: true, cause: error },
      );
    }
  }

  private requestId(payload: GeminiResponseBody, response: Response): string {
    const fromBody = payload.responseId?.trim() ?? '';
    if (fromBody !== '') return fromBody;

    const fromHeader =
      response.headers.get('x-goog-request-id')?.trim() ??
      response.headers.get('x-request-id')?.trim() ??
      '';
    if (fromHeader !== '') return fromHeader;

    throw new ProviderRequestError(
      'gemini image provider returned an image without a request id: provenance cannot be recorded (R-013-1)',
      { failureClass: 'non_retryable', httpStatus: 200, billedUnknown: true },
    );
  }

  private imagePart(payload: GeminiResponseBody): GeminiPart {
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const part = parts.find((candidate) => {
      const data = candidate.inlineData?.data;
      return typeof data === 'string' ? data.length > 0 : false;
    });
    if (part === undefined) {
      throw new ProviderRequestError(
        'gemini image provider returned no image part: the prompt was refused or answered with text only (billed)',
        { failureClass: 'non_retryable', httpStatus: 200, billedUnknown: true },
      );
    }
    return part;
  }

  private decodeImage(part: GeminiPart): Uint8Array {
    const data = part.inlineData?.data ?? '';
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (bytes.length === 0) {
      throw new ProviderRequestError(
        'gemini image provider returned an empty inlineData payload (billed)',
        { failureClass: 'non_retryable', httpStatus: 200, billedUnknown: true },
      );
    }
    return bytes;
  }

  private responseMimeType(part: GeminiPart, format: 'png' | 'jpeg'): ImageMimeType {
    const declared = part.inlineData?.mimeType;
    if (declared === 'image/png' || declared === 'image/jpeg') return declared;
    if (declared === 'image/webp') {
      throw new ProviderRequestError(
        'gemini image provider returned WebP, whose geometry this build cannot measure; refusing to guess (billed)',
        { failureClass: 'non_retryable', httpStatus: 200, billedUnknown: true },
      );
    }
    // An absent/unknown mimeType is tolerated only because the bytes parsed.
    return format === 'png' ? 'image/png' : 'image/jpeg';
  }

  private mapThrown(error: unknown): ProviderRequestError {
    if (error instanceof ProviderRequestError) return error;
    if (error instanceof UnsupportedImageFormatError) {
      return new ProviderRequestError(
        `gemini image provider returned bytes whose geometry cannot be read: ${error.message} (billed)`,
        { failureClass: 'non_retryable', httpStatus: 200, billedUnknown: true, cause: error },
      );
    }
    if (isAbortError(error)) {
      return new ProviderRequestError(
        `gemini image request timed out after ${this.timeoutMs} ms: the call may have billed (R-012-4)`,
        { failureClass: 'transient', billedUnknown: true, cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new ProviderRequestError(
      `gemini image request failed before a response was read: ${detail} (charge unknown, R-012-4)`,
      { failureClass: 'transient', billedUnknown: true, cause: error },
    );
  }
}

export interface GeminiImageEnvDeps {
  readonly fetchImpl?: typeof fetch;
  readonly rateLimiter?: RateLimiter;
  readonly baseUrl?: string;
}

/**
 * Build the adapter from the R-008-1 configuration keys. Invalid values fail at
 * construction with a named error naming the key, never at first billable call.
 */
export function geminiImageAdapterFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  deps: GeminiImageEnvDeps = {},
): GeminiImageAdapter {
  const apiKey = env.GEMINI_API_KEY?.trim() ?? '';
  if (apiKey === '') {
    throw new ImageConfigError('GEMINI_API_KEY is required for the image adapter');
  }

  const imageSize = (env.GEMINI_IMAGE_SIZE ?? '1K').trim();
  if (!isImageSize(imageSize)) {
    throw new ImageConfigError(
      `GEMINI_IMAGE_SIZE must be one of ${IMAGE_SIZES.join(', ')}, got "${imageSize}"`,
    );
  }

  const timeoutSeconds = Number.parseInt(env.PROVIDER_TIMEOUT_IMAGE_S ?? '60', 10);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new ImageConfigError(
      `PROVIDER_TIMEOUT_IMAGE_S must be an integer 1..600, got "${env.PROVIDER_TIMEOUT_IMAGE_S ?? ''}"`,
    );
  }

  const rateLimitPerMinute = Number.parseInt(env.PROVIDER_RATE_LIMIT_PER_MIN ?? '10', 10);
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 600) {
    throw new ImageConfigError(
      `PROVIDER_RATE_LIMIT_PER_MIN must be an integer 1..600, got "${env.PROVIDER_RATE_LIMIT_PER_MIN ?? ''}"`,
    );
  }

  const model = (env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL).trim();
  if (model === '') {
    throw new ImageConfigError('GEMINI_IMAGE_MODEL must not be empty');
  }

  return new GeminiImageAdapter({
    apiKey,
    model,
    imageSize,
    timeoutMs: timeoutSeconds * 1_000,
    rateLimitPerMinute,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.rateLimiter === undefined ? {} : { rateLimiter: deps.rateLimiter }),
    ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
  });
}
