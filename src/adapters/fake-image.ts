/**
 * Deterministic in-memory image adapter (TECH_DESIGN §10 fakes, B-06 Signal).
 *
 * No network, no clock, no randomness: the same request yields byte-identical
 * output on any machine, so tests and the qualification fixtures are stable.
 * The output is a real PNG at the documented geometry (FFmpeg/QC can read it),
 * with three tEXt chunks carrying the provenance a verifier needs:
 *
 *   reels_refs   — canonical digest of the reference set (what "identity held"
 *                  means in the fake), which is how a simulated drift is caught;
 *   reels_prompt — sha256 of the prompt, so scenes differ per prompt;
 *   reels_model  — the model id stamped into the pretend response.
 *
 * `simulateReferenceDrift` exists to prove the *qualifier* fails when identity
 * moves — a fake that can only pass would make the qualification test vacuous.
 */
import { createHash } from 'node:crypto';

import {
  GenerationRunContractViolationError,
  type ProviderAdapter,
} from '../domain/generation-run.js';
import { encodePng, readPngText } from './image-bytes.js';
import {
  DOCUMENTED_1K_GEOMETRY,
  DOCUMENTED_2K_GEOMETRY,
  normalizeImageRequest,
  referenceSetDigest,
  type ImageAdapter,
  type ImageCallContext,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageSize,
  type ReferencePreservationCheck,
  type ReferencePreservationInput,
} from './image.js';

export interface FakeImageAdapterOptions {
  readonly imageSize?: ImageSize;
  readonly model?: string;
  /** Fixed seed; otherwise a deterministic one is derived from the request. */
  readonly seed?: number;
  /** Make scenes 2+ carry a different reference marker (for failure tests). */
  readonly simulateReferenceDrift?: boolean;
}

const DEFAULT_MODEL = 'fake-nano-banana';
const DRIFT_MARKER = ':simulated-drift:';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class FakeImageAdapter implements ImageAdapter {
  readonly provider = 'fake';
  readonly adapterName = 'FakeImageAdapter';
  readonly stage = 'IM' as const;
  readonly idempotencyProtected = false as const;
  readonly model: string;
  readonly imageSize: ImageSize;
  readonly qualificationCheck: ReferencePreservationCheck;

  /** Every request this instance served, in order (assertable state, no I/O). */
  readonly calls: ImageGenerateRequest[] = [];

  private readonly fixedSeed: number | undefined;
  private readonly simulateReferenceDrift: boolean;

  constructor(options: FakeImageAdapterOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.imageSize = options.imageSize ?? '1K';
    this.fixedSeed = options.seed;
    this.simulateReferenceDrift = options.simulateReferenceDrift ?? false;
    this.qualificationCheck = {
      name: 'fake-reference-marker',
      check: (input: ReferencePreservationInput) => this.checkReference(input),
    };
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
    const sceneIndex = this.calls.length;
    this.calls.push(request);

    const referenceDigest = referenceSetDigest(normalized.reference_images);
    const stampedReference =
      this.simulateReferenceDrift && sceneIndex > 0
        ? sha256(`${referenceDigest}${DRIFT_MARKER}${sceneIndex}`)
        : referenceDigest;

    const promptDigest = sha256(normalized.prompt);
    const requestDigest = sha256(
      JSON.stringify({
        prompt: normalized.prompt,
        reference: referenceDigest,
        image_size: normalized.image_size,
        aspect_ratio: normalized.aspect_ratio,
        model: this.model,
        seed: this.fixedSeed ?? null,
      }),
    );

    const geometry =
      normalized.image_size === '2K' ? DOCUMENTED_2K_GEOMETRY : DOCUMENTED_1K_GEOMETRY;
    const palette = [0, 2, 4].map((offset) =>
      Number.parseInt(requestDigest.slice(offset, offset + 2), 16),
    );

    const bytes = encodePng({
      width: geometry.width,
      height: geometry.height,
      pixel: (x, y) => [
        (palette[0]! + x) % 256,
        (palette[1]! + y * 3) % 256,
        (palette[2]! + x + y) % 256,
      ],
      text: {
        reels_refs: stampedReference,
        reels_prompt: promptDigest,
        reels_model: this.model,
      },
    });

    return {
      image_bytes: bytes,
      mime_type: 'image/png',
      width: geometry.width,
      height: geometry.height,
      provider_request_id: `fake-image-${requestDigest.slice(0, 20)}`,
      seed: this.fixedSeed ?? Number.parseInt(requestDigest.slice(0, 8), 16),
      model: this.model,
      idempotency_protected: false,
      run_id: run.id,
    };
  }

  bind(request: ImageGenerateRequest): ProviderAdapter<ImageGenerateResult> {
    return {
      provider: this.provider,
      stage: this.stage,
      execute: (run) => this.generate(request, run),
    };
  }

  private checkReference(input: ReferencePreservationInput): {
    readonly preserved: boolean;
    readonly detail: string;
  } {
    const marker = readPngText(input.result.image_bytes, 'reels_refs');
    if (marker === null) {
      return {
        preserved: false,
        detail: 'the output carries no reference marker (not a fake image)',
      };
    }
    if (marker !== input.referenceSha256) {
      return {
        preserved: false,
        detail: `reference drifted at scene ${input.sceneIndex + 1}: output marker ${marker.slice(0, 12)}… does not match the reference set ${input.referenceSha256.slice(0, 12)}…`,
      };
    }
    return { preserved: true, detail: 'output marker matches the reference set' };
  }
}
