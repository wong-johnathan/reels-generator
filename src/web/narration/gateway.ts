/**
 * S-14's data dependency — contract `audio.get`, `audio.rerun`, `audio.accept`.
 *
 * Same shape as the series, video and scene gateways: the web app renders what
 * the gateway returns and never invents a response. INT-01 composes the
 * production adapter from the contract routes; this module ships the in-memory
 * one the preview and the tests drive.
 *
 * `accept` is deliberately optional. The frozen contract's `audio.accept`
 * takes an `alignment_id`, but `audio.get` never returns one (gap S-14-1,
 * raised on the card): the timing document is a `TC` sidecar asset whose id the
 * narration view does not carry. When the seam is missing — and while the id is
 * absent — the page renders the control disabled with the reason instead of
 * posting a guessed id.
 */
import type { z } from 'zod';

import type { NarrationViewSchema } from '../../../contract/api.js';

export type NarrationView = z.infer<typeof NarrationViewSchema>;

export interface NarrationRerunInput {
  readonly reason?: string;
}

export interface NarrationAcceptInput {
  readonly alignmentId: string;
}

/** A named refusal: script unapproved, narration already running, script changed. */
export class NarrationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NarrationRefusedError';
  }
}

export class NarrationNotFoundError extends Error {
  constructor(videoId: string) {
    super('No narration for video ' + videoId);
    this.name = 'NarrationNotFoundError';
  }
}

export interface NarrationGateway {
  get(videoId: string): Promise<NarrationView | null>;
  /** Exactly one TTS call; timing and the render follow (C-17, R-009-3). */
  rerun(videoId: string, input: NarrationRerunInput): Promise<{ readonly queued: boolean }>;
  /** The S-14-1 seam: only callable when an alignment id is actually known. */
  accept?(videoId: string, input: NarrationAcceptInput): Promise<NarrationView>;
}

export interface MemoryNarrationCalls {
  readonly rerun: { readonly videoId: string; readonly reason: string | null }[];
  readonly accept: { readonly videoId: string; readonly alignmentId: string }[];
}

export interface MemoryNarrationSeed {
  readonly videoId: string;
  /** `null` models "no narration yet". */
  readonly view: NarrationView | null;
  /** False models a build without the accept seam (gap S-14-1). */
  readonly accept?: boolean;
  readonly now?: () => number;
}

export interface MemoryNarrationGateway extends NarrationGateway {
  readonly calls: MemoryNarrationCalls;
  readonly current: () => NarrationView | null;
}

/**
 * In-memory store. A rerun marks the take `running` so a route test can see it
 * and the surface stops offering a second call; accept stamps `accepted_at`
 * and refuses a timing outside the band (R-009-4).
 */
export function createMemoryNarrationGateway(seed: MemoryNarrationSeed): MemoryNarrationGateway {
  let current: NarrationView | null = seed.view;
  const calls: MemoryNarrationCalls = { rerun: [], accept: [] };
  const now = seed.now ?? ((): number => Date.UTC(2026, 9, 20, 9, 41, 12));

  const gateway: MemoryNarrationGateway = {
    calls,
    current: () => current,
    async get(videoId: string): Promise<NarrationView | null> {
      if (videoId !== seed.videoId) return null;
      return current;
    },
    async rerun(videoId: string, input: NarrationRerunInput) {
      if (videoId !== seed.videoId) throw new NarrationNotFoundError(videoId);
      if (current === null) throw new NarrationRefusedError('No narration has run for this video.');
      if (current.status === 'running') {
        throw new NarrationRefusedError('Narration is already running.');
      }
      calls.rerun.push({ videoId, reason: input.reason ?? null });
      current = { ...current, status: 'running', accepted_at: null };
      return { queued: true };
    },
  };

  if (seed.accept === true) {
    gateway.accept = async (videoId: string, input: NarrationAcceptInput) => {
      if (videoId !== seed.videoId) throw new NarrationNotFoundError(videoId);
      if (current === null) throw new NarrationRefusedError('No narration has run for this video.');
      if (!current.band.within_band) {
        throw new NarrationRefusedError(
          'The duration is outside the band, so there is nothing to accept.',
        );
      }
      calls.accept.push({ videoId, alignmentId: input.alignmentId });
      current = { ...current, accepted_at: new Date(now()).toISOString() };
      return current;
    };
  }

  return gateway;
}
