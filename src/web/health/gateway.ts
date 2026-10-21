/**
 * S-19/S-21's data dependency — contract `health.report`,
 * `settings.providers` and `attempts.list`.
 *
 * The health endpoint is service-wide; attempt rows are per video
 * (`attempts.list` is `/api/videos/:videoId/attempts`). This gateway keeps that
 * shape rather than inventing a global attempts endpoint: the page lists the
 * rows of the video the operator selected. INT-01 composes the production
 * adapter from the contract routes; this module ships the in-memory one the
 * preview and the tests drive.
 */
import type { z } from 'zod';

import type { StageCode } from '../../shared/stages.js';
import type {
  AttemptRowSchema,
  HealthReportSchema,
  ProviderSettingsViewSchema,
} from '../../../contract/api.js';

export type HealthReport = z.infer<typeof HealthReportSchema>;
export type ProviderSettingsView = z.infer<typeof ProviderSettingsViewSchema>;
export type AttemptRow = z.infer<typeof AttemptRowSchema>;

export interface AttemptsQuery {
  readonly stage: StageCode | null;
  readonly limit: number;
}

export interface OpsGateway {
  health(): Promise<HealthReport>;
  settings(): Promise<ProviderSettingsView>;
  attempts(videoId: string, query: AttemptsQuery): Promise<AttemptRow[]>;
}

export interface MemoryOpsSeed {
  readonly report: HealthReport;
  /** Defaults to `report.providers`, in the same order. */
  readonly settingsProviders?: ProviderSettingsView['providers'];
  readonly attemptsByVideo: Readonly<Record<string, readonly AttemptRow[]>>;
  readonly now?: () => number;
}

/** Newest first; `limit` is applied after the stage filter (contract query). */
export function selectAttempts(rows: readonly AttemptRow[], query: AttemptsQuery): AttemptRow[] {
  return rows
    .filter((row) => query.stage === null || row.stage === query.stage)
    .map((row, index) => ({ row, index, at: Date.parse(row.created_at) }))
    .sort((left, right) => {
      const delta = (Number.isNaN(right.at) ? 0 : right.at) - (Number.isNaN(left.at) ? 0 : left.at);
      return delta === 0 ? left.index - right.index : delta;
    })
    .slice(0, query.limit)
    .map((entry) => entry.row);
}

export class OpsNotFoundError extends Error {
  constructor(what: string) {
    super('No ' + what);
    this.name = 'OpsNotFoundError';
  }
}

export function createMemoryOpsGateway(seed: MemoryOpsSeed): OpsGateway {
  const byVideo = new Map(Object.entries(seed.attemptsByVideo));
  return {
    async health(): Promise<HealthReport> {
      return seed.report;
    },
    async settings(): Promise<ProviderSettingsView> {
      return {
        read_only: true,
        key_values_exposed: false,
        providers: [...(seed.settingsProviders ?? seed.report.providers)],
      };
    },
    async attempts(videoId: string, query: AttemptsQuery): Promise<AttemptRow[]> {
      if (!byVideo.has(videoId)) throw new OpsNotFoundError('attempts for video ' + videoId);
      return selectAttempts(byVideo.get(videoId) ?? [], query);
    },
  };
}
