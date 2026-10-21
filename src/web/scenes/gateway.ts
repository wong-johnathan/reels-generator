/**
 * The scene surfaces' data dependency — contract `storyboard.get`,
 * `storyboard.approve`, `scenes.get`, `scenes.replace_image`.
 *
 * Same shape as the S-03/S-04 and S-09 video gateways: the web app never
 * invents a response, it renders what the gateway returns. INT-01 composes the
 * production adapter from the contract routes; this module ships the in-memory
 * one the preview and the tests drive.
 *
 * `releaseRemaining` is deliberately optional: the frozen contract has no
 * checkpoint-release route (gap F-06-1, raised on the card). When the seam is
 * absent the grid renders the release control disabled with the reason,
 * instead of the browser guessing a request shape.
 */
import type { z } from 'zod';

import type { SceneViewSchema, StoryboardViewSchema } from '../../../contract/api.js';

export type SceneView = z.infer<typeof SceneViewSchema>;
export type StoryboardView = z.infer<typeof StoryboardViewSchema>;

export interface ReplaceImageInput {
  readonly revision: number;
  readonly image_prompt?: string;
}

export interface StoryboardApproveInput {
  readonly revision: number;
  readonly note?: string;
}

export interface SceneGateway {
  storyboard(videoId: string): Promise<StoryboardView | null>;
  approveStoryboard(videoId: string, input: StoryboardApproveInput): Promise<StoryboardView>;
  scene(videoId: string, sceneId: string): Promise<SceneView | null>;
  replaceImage(videoId: string, sceneId: string, input: ReplaceImageInput): Promise<void>;
  /** Optional seam for the first-three checkpoint (gap F-06-1). */
  releaseRemaining?(
    videoId: string,
    input: { readonly revision: number },
  ): Promise<{ readonly queued: number }>;
}

/** 409: the storyboard or the scene changed since the page was rendered. */
export class SceneConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super('The scene changed; current revision is ' + currentRevision);
    this.name = 'SceneConflictError';
    this.currentRevision = currentRevision;
  }
}

/** 404: no scene with that id on this video. */
export class SceneNotFoundError extends Error {
  constructor(sceneId: string) {
    super('No scene ' + sceneId);
    this.name = 'SceneNotFoundError';
  }
}

/** 409/blocked: a named precondition (checkpoint open, provider down). */
export class SceneBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SceneBlockedError';
  }
}

export interface MemorySceneCalls {
  readonly approve: { readonly videoId: string; readonly revision: number }[];
  readonly replace: {
    readonly videoId: string;
    readonly sceneId: string;
    readonly revision: number;
    readonly image_prompt: string | null;
  }[];
  readonly release: { readonly videoId: string; readonly revision: number }[];
}

export interface MemorySceneSeed {
  readonly storyboards: readonly StoryboardView[];
  /** `null` models a backend without a release route (gap F-06-1). */
  readonly releaseRemaining?: number | null;
}

export interface MemorySceneGateway extends SceneGateway {
  readonly calls: MemorySceneCalls;
  readonly current: () => StoryboardView | null;
}

/**
 * In-memory store: one storyboard per video, its scenes served by id. A
 * replace flips the targeted scene to `running` so a test can see that exactly
 * one scene moved, and the release seam is only present when the seed says so.
 */
export function createMemorySceneGateway(seed: MemorySceneSeed): MemorySceneGateway {
  const byVideo = new Map<string, StoryboardView>();
  for (const board of seed.storyboards) {
    byVideo.set(board.project_id, board);
    for (const scene of board.scenes) byVideo.set(scene.id, board);
  }
  const approve: MemorySceneCalls['approve'][number][] = [];
  const replace: MemorySceneCalls['replace'][number][] = [];
  const release: MemorySceneCalls['release'][number][] = [];
  let latest: StoryboardView | null = seed.storyboards[0] ?? null;

  const gateway: MemorySceneGateway = {
    calls: { approve, replace, release },
    current: () => latest,
    async storyboard(videoId: string): Promise<StoryboardView | null> {
      const board = byVideo.get(videoId);
      if (board === undefined) return null;
      if (latest === null) latest = board;
      return board;
    },
    async approveStoryboard(videoId: string, input: StoryboardApproveInput) {
      const board = byVideo.get(videoId);
      if (board === undefined) throw new SceneNotFoundError(videoId);
      if (board.revision !== input.revision) throw new SceneConflictError(board.revision);
      approve.push({ videoId, revision: input.revision });
      const approved: StoryboardView = {
        ...board,
        approved: true,
        approved_at: '2026-10-20T09:41:12.000Z',
        revision: board.revision + 1,
      };
      remember(approved);
      return approved;
    },
    async scene(videoId: string, sceneId: string) {
      const board = byVideo.get(videoId);
      if (board === undefined) return null;
      if (latest === null) latest = board;
      return board.scenes.find((scene) => scene.id === sceneId) ?? null;
    },
    async replaceImage(videoId: string, sceneId: string, input: ReplaceImageInput) {
      const board = byVideo.get(videoId);
      if (board === undefined) throw new SceneNotFoundError(videoId);
      const scene = board.scenes.find((candidate) => candidate.id === sceneId);
      if (scene === undefined) throw new SceneNotFoundError(sceneId);
      replace.push({
        videoId,
        sceneId,
        revision: input.revision,
        image_prompt: input.image_prompt ?? null,
      });
      remember({
        ...board,
        revision: board.revision + 1,
        scenes: board.scenes.map((candidate) =>
          candidate.id === sceneId ? { ...candidate, state: 'running' as const } : candidate,
        ),
      });
    },
  };

  if (seed.releaseRemaining !== null) {
    const queued = seed.releaseRemaining ?? 0;
    gateway.releaseRemaining = async (videoId, input) => {
      const board = byVideo.get(videoId);
      if (board === undefined) throw new SceneNotFoundError(videoId);
      if (board.revision !== input.revision) throw new SceneConflictError(board.revision);
      release.push({ videoId, revision: input.revision });
      remember({ ...board, first_three_reviewed: true, revision: board.revision + 1 });
      return { queued };
    };
  }

  function remember(board: StoryboardView): void {
    latest = board;
    byVideo.set(board.project_id, board);
  }

  return gateway;
}
