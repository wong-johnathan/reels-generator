/**
 * S-15's data dependency — contract `render.get` and `render.approve`.
 *
 * Same shape as the series, video and narration gateways: the web app renders
 * what the gateway returns and never invents a response. INT-01 composes the
 * production adapter from the contract routes; this module ships the in-memory
 * one the preview and the tests drive.
 *
 * Two deliberate edges:
 *  - `revision` is optional. The frozen contract's `render.approve` takes the
 *    `revision` in `ApprovalRequestSchema`, but `render.get` never returns one
 *    (gap S-15-1, raised on the card). The page enables approval only when the
 *    gateway can supply that number; otherwise the control is disabled with
 *    the reason instead of posting a guessed value.
 *  - `approve` re-checks the QC state it holds. The page already blocks the
 *    button, but a hand-rolled POST must be refused too: a gate that can be
 *    bypassed with curl is not a gate (R-005-3).
 */
import type { z } from 'zod';

import type { RenderViewSchema } from '../../../contract/api.js';
import { QC_REQUIREMENTS } from './model.js';

export type RenderView = z.infer<typeof RenderViewSchema>;

export interface RenderApproveInput {
  /** `ApprovalRequestSchema.revision` — the page's optimistic-lock value. */
  readonly revision: number;
  /** `ApprovalRequestSchema.note` (≤ 2000 characters). */
  readonly note?: string;
}

export class RenderNotFoundError extends Error {
  constructor(videoId: string) {
    super('No render for video ' + videoId);
    this.name = 'RenderNotFoundError';
  }
}

/** A named refusal: QC failed, a check is missing, the page is stale, already approved. */
export class RenderRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RenderRefusedError';
  }
}

export interface RenderGateway {
  get(videoId: string): Promise<RenderView | null>;
  /** The revision `render.approve` must carry, or null when it cannot be known. */
  revision?(videoId: string): Promise<number | null>;
  approve(videoId: string, input: RenderApproveInput): Promise<RenderView>;
}

export interface MemoryRenderCalls {
  readonly approve: {
    readonly videoId: string;
    readonly revision: number;
    readonly note: string | null;
  }[];
}

export interface MemoryRenderSeed {
  readonly videoId: string;
  /** `null` models "no render output yet". */
  readonly view: RenderView | null;
  readonly revision?: number;
  readonly now?: () => number;
}

export interface MemoryRenderGateway extends RenderGateway {
  readonly calls: MemoryRenderCalls;
  readonly current: () => RenderView | null;
  /** Always known in memory; the production adapter reads it from the FA revision. */
  revision(videoId: string): Promise<number | null>;
}

function missingRequirement(view: RenderView): string | null {
  for (const requirement of QC_REQUIREMENTS) {
    if (!view.qc.checks.some((check) => check.requirement.trim() === requirement)) {
      return requirement;
    }
  }
  return null;
}

export function createMemoryRenderGateway(seed: MemoryRenderSeed): MemoryRenderGateway {
  let current = seed.view;
  const revision = seed.revision ?? 1;
  const calls: MemoryRenderCalls = { approve: [] };
  const now = seed.now ?? ((): number => Date.UTC(2026, 9, 20, 9, 41, 12));

  return {
    calls,
    current: () => current,
    async get(videoId: string): Promise<RenderView | null> {
      if (videoId !== seed.videoId) return null;
      return current;
    },
    async revision(videoId: string): Promise<number | null> {
      if (videoId !== seed.videoId) return null;
      return revision;
    },
    async approve(videoId: string, input: RenderApproveInput): Promise<RenderView> {
      if (videoId !== seed.videoId) throw new RenderNotFoundError(videoId);
      if (current === null) throw new RenderRefusedError('No render has run for this video.');
      if (input.revision !== revision) {
        throw new RenderRefusedError(
          'This page is out of date: the render revision is now ' +
            revision +
            '. Reload and re-read the QC results before approving. Nothing was approved.',
        );
      }
      if (current.approved) throw new RenderRefusedError('This render is already approved.');
      if (current.qc.status !== 'pass') {
        throw new RenderRefusedError(
          'Final approval is blocked while QC fails. Nothing was approved.',
        );
      }
      const missing = missingRequirement(current);
      if (missing !== null) {
        throw new RenderRefusedError(
          'Final approval is blocked: QC has not reported ' + missing + '. Nothing was approved.',
        );
      }
      if (current.video === null) {
        throw new RenderRefusedError(
          'The render has no video asset, so there is nothing to approve.',
        );
      }
      calls.approve.push({
        videoId,
        revision: input.revision,
        note: input.note === undefined || input.note.length === 0 ? null : input.note,
      });
      current = {
        ...current,
        status: 'done',
        approved: true,
        approved_at: new Date(now()).toISOString(),
      };
      return current;
    },
  };
}
