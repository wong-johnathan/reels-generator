/**
 * View models for S-03 and S-04 — the only place that turns contract data into
 * what the renderers draw. Kept separate from the HTML so the route, the
 * preview and the tests all build the same model.
 */
import type { z } from 'zod';

import type { SeriesDetailSchema, SeriesSummarySchema } from '../../../contract/api.js';

type SeriesDetail = z.infer<typeof SeriesDetailSchema>;
type SeriesSummary = z.infer<typeof SeriesSummarySchema>;
import type { ChangedField } from './fields.js';
import type { SeriesGateway } from './gateway.js';

export interface SeriesListRow {
  readonly summary: SeriesSummary;
  /** `null` when the per-row count could not be read — rendered as "—". */
  readonly inFlightBatches: number | null;
}

export interface SeriesListModel {
  readonly state: 'ready' | 'empty' | 'loading' | 'error';
  readonly rows: readonly SeriesListRow[];
  readonly now: number;
  readonly errorMessage?: string;
}

/**
 * `series.list` carries no batch aggregate, so the open-batch count comes from
 * the documented `series.get` for each row. One failed row degrades to "—"
 * instead of failing the page (UX_SPEC §6.1 S-03 partial state).
 */
export async function loadSeriesRows(gateway: SeriesGateway): Promise<SeriesListRow[]> {
  const summaries = await gateway.list();
  return Promise.all(
    summaries.map(async (summary): Promise<SeriesListRow> => {
      try {
        const detail = await gateway.get(summary.id);
        return { summary, inFlightBatches: detail?.in_flight_batches ?? null };
      } catch {
        return { summary, inFlightBatches: null };
      }
    }),
  );
}

export interface SeriesConflictModel {
  readonly currentRevision: number;
  readonly yourRevision: number;
  readonly currentVersion: number;
  readonly savedAt: string;
}

export interface SeriesEditorModel {
  readonly mode: 'create' | 'edit';
  readonly status: 'active' | 'archived';
  readonly detail?: SeriesDetail;
  readonly values: Readonly<Record<string, string>>;
  readonly initial: Readonly<Record<string, string>>;
  readonly changed: readonly ChangedField[];
  readonly errors: Readonly<Record<string, string>>;
  readonly conflict?: SeriesConflictModel;
  /** Renders the post-redirect confirmation only for the current version. */
  readonly savedVersion?: number;
  /** `?unchanged=1` — a save that minted nothing. */
  readonly unchanged?: boolean;
  /** A save/load failure that kept the form and its typed text intact. */
  readonly saveError?: string;
  readonly createReady?: boolean;
  readonly inFlightBatches?: number | null;
  readonly inFlightVideos?: number | null;
}
