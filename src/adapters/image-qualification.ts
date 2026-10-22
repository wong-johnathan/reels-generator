/**
 * Image adapter qualification — TECH_DESIGN 5.6, US-012 (R-008-3).
 *
 * Runs the PRD threshold ("reference preserved across >=3 scenes") against the
 * configured image adapter, records pass/fail + date, and exposes the gate the
 * content worker calls before a billable image stage.
 *
 * The image threshold is inherently visual. Two honest paths:
 * - an adapter that can verify automatically (the deterministic fake stamps a
 *   reference marker into its PNG) is judged mechanically;
 * - a real provider has no automatic verifier here, so the runner records
 *   `passed=false` with `requires_human_review=true` plus the scene evidence,
 *   and never invents a visual pass. An operator verdict, once a human has
 *   looked at the three panels, is recorded explicitly.
 *
 * The `provider_qualification` table write/read lives in the shared module
 * `src/adapters/qualification.ts` (B-05's canonical copy); this module adds the
 * image-specific runner, fixture and a store seam so the runner is testable
 * without a database.
 *
 * A qualification run of a real provider is billable (three images). It happens
 * before integration, outside a project pipeline, because no project/job exists
 * yet; `billable_calls` is recorded in the details so the cost is not hidden.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '../db/client.js';
import { encodePng } from './image-bytes.js';
import {
  CHARACTER_LOCK_INSTRUCTION,
  IMAGE_ASPECT_RATIO,
  referenceSetDigest,
  type ImageAdapter,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type InlineImageData,
} from './image.js';
import {
  latestQualification,
  QualificationGateError,
  recordQualification,
  type QualificationRow,
} from './qualification.js';

export interface ImageQualificationStore {
  record(entry: {
    readonly provider: string;
    readonly adapter: string;
    readonly passed: boolean;
    readonly details: Record<string, unknown>;
    readonly runAt?: Date;
  }): Promise<QualificationRow>;
  /** The newest row for this provider+adapter, or null when never qualified. */
  latest(provider: string, adapter: string): Promise<QualificationRow | null>;
}

/** In-memory store for unit tests and for a dry run without a database. */
export class InMemoryImageQualificationStore implements ImageQualificationStore {
  private readonly rows: QualificationRow[] = [];

  async record(entry: {
    readonly provider: string;
    readonly adapter: string;
    readonly passed: boolean;
    readonly details: Record<string, unknown>;
    readonly runAt?: Date;
  }): Promise<QualificationRow> {
    const row: QualificationRow = {
      id: `mem-${this.rows.length + 1}`,
      provider: entry.provider,
      adapter: entry.adapter,
      passed: entry.passed,
      details: entry.details,
      run_at: entry.runAt ?? new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async latest(provider: string, adapter: string): Promise<QualificationRow | null> {
    const matching = this.rows.filter(
      (row) => row.provider === provider && row.adapter === adapter,
    );
    if (matching.length === 0) return null;
    // Ties resolve to the later insertion, matching the SQL's run_at DESC.
    return matching.reduce((newest, row) =>
      row.run_at.getTime() >= newest.run_at.getTime() ? row : newest,
    );
  }
}

/** `provider_qualification` store backed by the shared SQL helpers. */
export class PgImageQualificationStore implements ImageQualificationStore {
  constructor(private readonly db: Queryable) {}

  record(entry: {
    readonly provider: string;
    readonly adapter: string;
    readonly passed: boolean;
    readonly details: Record<string, unknown>;
    readonly runAt?: Date;
  }): Promise<QualificationRow> {
    return recordQualification(this.db, entry);
  }

  latest(provider: string, adapter: string): Promise<QualificationRow | null> {
    return latestQualification(this.db, provider, adapter);
  }
}

/**
 * The image gate: only the newest record counts, so a later failure closes the
 * gate even if an older row passed.
 */
export async function assertImageQualified(
  store: ImageQualificationStore,
  adapter: { readonly provider: string; readonly adapterName: string },
): Promise<void> {
  const latest = await store.latest(adapter.provider, adapter.adapterName);
  if (latest === null || latest.passed !== true) {
    throw new QualificationGateError(adapter.provider, adapter.adapterName, latest);
  }
}

export interface ImageQualificationScene {
  readonly name: string;
  readonly prompt: string;
}

export interface ImageQualificationFixture {
  /** The recurring protagonist, described once, independent of any scene. */
  readonly character?: string;
  readonly name: string;
  readonly reference: InlineImageData;
  readonly scenes: readonly ImageQualificationScene[];
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A real reference PNG (readable by FFmpeg), not a base64 placeholder. */
const QUALIFICATION_REFERENCE_BYTES = encodePng({
  width: 96,
  height: 172,
  pixel: (x, y) => [(x * 3) % 256, (y * 2) % 256, ((x + y) * 5) % 256],
});

/**
 * The three-scene reference-consistency sample of QUALIFICATION 1: same
 * character, scene 2 a hostile change (pose/light/environment), scene 3 the
 * widest shot with the back to the viewer.
 */
export const IMAGE_QUALIFICATION_FIXTURE: ImageQualificationFixture = {
  name: 'reference-consistency-3-scenes-v2',
  /**
   * The character, stated once and separately from any scene. Building the sheet
   * prompt out of a scene prompt produced a picture of a *scene*, and every later
   * scene drifted off it; identity has to be described on its own terms.
   */
  character:
    'woman, early thirties, pale skin, dark-auburn chin-length bob, round thin wire ' +
    'glasses, small scar through the right eyebrow, olive utility jacket with epaulets ' +
    'and flap pockets over a grey crew-neck tee',
  reference: {
    mime_type: 'image/png',
    data: Buffer.from(QUALIFICATION_REFERENCE_BYTES).toString('base64'),
  },
  scenes: [
    {
      name: 'scene-1-front',
      prompt:
        'flat comic illustration, recurring protagonist: woman with a dark-auburn bob, round wire glasses, olive utility jacket with epaulets and flap pockets, grey tee, scar through the right eyebrow; front view, overcast daylight, neutral street',
    },
    {
      name: 'scene-2-hostile-change',
      prompt:
        'flat comic illustration, the SAME recurring protagonist as the attached image: woman with a dark-auburn bob, round wire glasses, olive utility jacket with epaulets, grey tee; now crouched under a blue streetlamp at night in the rain, new pose and new lighting; identity must hold',
    },
    {
      name: 'scene-3-back-view',
      prompt:
        'flat comic illustration, the SAME recurring protagonist as the attached image: woman with a dark-auburn bob, round wire glasses, olive utility jacket with epaulets, grey tee; widest shot with the back to the viewer, walking away under sodium streetlights; silhouette, hair, jacket and palette must hold',
    },
  ],
};

export interface ImageQualificationVerdict {
  readonly passed: boolean;
  readonly reviewer: string;
  readonly notes?: string;
}

export interface RunImageQualificationOptions {
  readonly adapter: ImageAdapter;
  readonly store: ImageQualificationStore;
  readonly fixture?: ImageQualificationFixture;
  readonly now?: () => Date;
  /** Operator verdict for an adapter with no automatic verifier. */
  readonly verdict?: ImageQualificationVerdict;
}

export interface ImageQualificationOutcome {
  readonly passed: boolean;
  readonly record: QualificationRow;
}

/**
 * Run the >=3-scene reference-preservation qualification and record the result.
 *
 * A provider failure is data (a failed qualification row), not an exception: the
 * gate stays closed and the operator sees why. Misconfigured input (a fixture
 * with fewer than three scenes) throws before any call.
 */
export async function runImageQualification(
  options: RunImageQualificationOptions,
): Promise<ImageQualificationOutcome> {
  const fixture = options.fixture ?? IMAGE_QUALIFICATION_FIXTURE;
  if (fixture.scenes.length < 3) {
    throw new Error(
      `the image qualification fixture needs at least 3 scenes (US-012, R-008-3), got ${fixture.scenes.length}`,
    );
  }

  const checkedAt = (options.now ?? (() => new Date()))();
  // Recomputed per scene, because the reference itself moves as the chain extends.
  const automaticVerifier = options.adapter.qualificationCheck;
  const scenes: Record<string, unknown>[] = [];

  // The reference starts as the fixture's own and becomes the previous scene's
  // output. The fixture used to hand every scene the same gradient PNG, which is no
  // anchor at all: the model invented a different person per scene and the sample
  // measured nothing. Chaining is also what the production stage now does.
  // A character sheet first, then every scene conditioned on it.
  //
  // Chaining scene 1 into scene 2 was not enough: measured over repeated runs the
  // model kept the composition and threw the character away (a yellow raincoat where
  // scene 1 had an olive utility jacket). A neutral portrait makes identity the only
  // thing in the reference, and that held across a daylight kitchen and a night-time
  // rain scene. This is also what the production stage does.
  const sheetPrompt =
    'character reference sheet: single front-facing portrait of ' +
    (fixture.character ?? 'the recurring protagonist') +
    '. Flat comic illustration, bold black line art, neutral warm grey background, ' +
    'even lighting, no text';
  let reference = fixture.reference;
  let sheet: ImageGenerateResult | null = null;
  let generationError: string | undefined;
  try {
    sheet = await options.adapter.generate(
      {
        prompt: sheetPrompt,
        reference_images: [],
        image_size: options.adapter.imageSize,
        aspect_ratio: IMAGE_ASPECT_RATIO,
      },
      {
        id: `qualification:${options.adapter.provider}:sheet`,
        stage: 'IM',
        promptHash: sha256Hex(sheetPrompt),
      },
    );
    reference = {
      mime_type: sheet.mime_type,
      data: Buffer.from(sheet.image_bytes).toString('base64'),
    };
  } catch (error) {
    generationError = error instanceof Error ? error.message : String(error);
  }

  for (const [index, scene] of fixture.scenes.entries()) {
    if (generationError !== undefined) break;
    const referenceSha256 = referenceSetDigest([reference]);
    const request: ImageGenerateRequest = {
      // Mirrors the production stage: every scene after the first is conditioned on
      // the chain and told so explicitly. Without this the sample measured a prompt
      // shape that never ships.
      prompt: index === 0 ? scene.prompt : CHARACTER_LOCK_INSTRUCTION + scene.prompt,
      reference_images: [reference],
      image_size: options.adapter.imageSize,
      aspect_ratio: IMAGE_ASPECT_RATIO,
    };

    try {
      const result = await options.adapter.generate(request, {
        id: `qualification:${options.adapter.provider}:${index}`,
        stage: 'IM',
        promptHash: sha256Hex(scene.prompt),
      });
      const check = automaticVerifier?.check({
        sceneIndex: index,
        request,
        result,
        referenceSha256,
      });

      const chainedReference: InlineImageData = {
        mime_type: result.mime_type,
        data: Buffer.from(result.image_bytes).toString('base64'),
      };

      scenes.push({
        scene: scene.name,
        prompt_sha256: sha256Hex(scene.prompt),
        run_id: result.run_id,
        provider_request_id: result.provider_request_id,
        image_sha256: sha256Hex(result.image_bytes),
        width: result.width,
        height: result.height,
        mime_type: result.mime_type,
        reference_preserved: check === undefined ? null : check.preserved,
        detail:
          check === undefined
            ? 'no automatic verifier: human visual review required'
            : check.detail,
      });
      // The chain advances: scene N+1 is conditioned on the image scene N produced.
      reference = chainedReference;
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const distinctOutputs = new Set(scenes.map((scene) => scene.image_sha256)).size === scenes.length;
  let passed = false;
  let requiresHumanReview = false;
  let reason: string | undefined = generationError;

  if (generationError === undefined) {
    if (scenes.length < 3) {
      reason = `only ${scenes.length} of the 3 qualification scenes produced an image`;
    } else if (!distinctOutputs) {
      reason =
        'two qualification scenes produced identical image bytes, so they are not distinct scenes';
    } else if (automaticVerifier !== undefined) {
      passed = scenes.every((scene) => scene.reference_preserved === true);
      if (!passed) reason = 'the reference was not preserved in at least one scene';
    } else if (options.verdict !== undefined) {
      passed = options.verdict.passed;
      if (!passed) reason = 'the operator rejected the visual reference-consistency check';
    } else {
      requiresHumanReview = true;
      reason =
        'the adapter has no automatic verifier: a human visual review verdict is required (QUALIFICATION 1)';
    }
  }

  const details: Record<string, unknown> = {
    threshold: 'reference preserved across >=3 scenes',
    fixture: fixture.name,
    provider: options.adapter.provider,
    adapter: options.adapter.adapterName,
    model: options.adapter.model,
    image_size: options.adapter.imageSize,
    aspect_ratio: IMAGE_ASPECT_RATIO,
    // The digest of the reference the first scene was conditioned on; each scene also
    // records its own, because the chain moves.
    reference_sha256: referenceSetDigest([fixture.reference]),
    reference_count: 1,
    scene_count: scenes.length,
    billable_calls: scenes.length,
    scenes,
    automatic_verifier: automaticVerifier === undefined ? null : automaticVerifier.name,
    requires_human_review: requiresHumanReview,
    passed,
    ...(reason === undefined ? {} : { reason }),
    ...(generationError === undefined ? {} : { error: generationError }),
    ...(options.verdict === undefined
      ? {}
      : {
          verdict: {
            passed: options.verdict.passed,
            reviewer: options.verdict.reviewer,
            ...(options.verdict.notes === undefined ? {} : { notes: options.verdict.notes }),
          },
        }),
    checked_at: checkedAt.toISOString(),
  };

  const record = await options.store.record({
    provider: options.adapter.provider,
    adapter: options.adapter.adapterName,
    passed,
    details,
    runAt: checkedAt,
  });

  return { passed, record };
}
