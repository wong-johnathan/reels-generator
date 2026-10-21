/**
 * S-10's data dependency (contract `script.get`).
 *
 * Same shape as the F-03/F-04 gateways: the web app renders `ScriptView | null`
 * and never invents a response. INT-01 composes the production adapter from the
 * contract's route; this module ships the in-memory one the preview and the
 * tests drive.
 */
import type { z } from 'zod';

import type { ScriptViewSchema } from '../../../contract/api.js';

export type ScriptView = z.infer<typeof ScriptViewSchema>;

export interface ScriptGateway {
  /** The latest script revision for a video, or null before the first revision exists. */
  get(videoId: string): Promise<ScriptView | null>;
}

export function createMemoryScriptGateway(scripts: readonly ScriptView[]): ScriptGateway {
  const byProject = new Map(scripts.map((script) => [script.project_id, script]));
  return {
    async get(videoId: string): Promise<ScriptView | null> {
      return byProject.get(videoId) ?? null;
    },
  };
}
