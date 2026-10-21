/**
 * The video workspace's data dependency (contract `video.get`).
 *
 * Same shape as the S-03/S-04 gateway: the web app never invents a response,
 * it renders `VideoDetail | null`. INT-01 composes the production adapter from
 * the contract's route; this module ships the in-memory one the preview and
 * the tests drive.
 */
import type { z } from 'zod';

import type { VideoDetailSchema } from '../../../contract/api.js';

export type VideoDetail = z.infer<typeof VideoDetailSchema>;

export interface VideoGateway {
  get(videoId: string): Promise<VideoDetail | null>;
}

export class VideoNotFoundError extends Error {
  constructor(videoId: string) {
    super('No video ' + videoId);
    this.name = 'VideoNotFoundError';
  }
}

export function createMemoryVideoGateway(videos: readonly VideoDetail[]): VideoGateway {
  const byId = new Map(videos.map((video) => [video.id, video]));
  return {
    async get(videoId: string): Promise<VideoDetail | null> {
      return byId.get(videoId) ?? null;
    },
  };
}
