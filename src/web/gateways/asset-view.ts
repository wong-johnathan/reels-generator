/**
 * Shared `AssetViewSchema` mapping for the page gateways.
 *
 * Both the narration and the render gateway turn a content-addressed `asset`
 * row (joined to `series_version` for the human pin number) into the contract's
 * `AssetView`. Keeping one mapper here means the two views cannot disagree
 * about how a size, a URL or a provenance field is derived.
 *
 * `size_bytes` is a `bigint` column, so `pg` hands it back as a string; the
 * contract wants an int. A null size (never written by the stages, but the
 * column is nullable) is reported as 0 rather than guessed.
 */
import type { z } from 'zod';

import type { AssetViewSchema } from '../../../contract/api.js';

export type AssetView = z.infer<typeof AssetViewSchema>;

/**
 * The asset columns every page read selects, plus the joined `series_version`
 * integer. `sv.version` is the human pin (`3`); `a.series_version_id` is the
 * uuid the provenance row carries.
 */
export const ASSET_VIEW_FIELDS = /* sql */ `
  a.id, a.stage, a.kind, a.width, a.height, a.object_size_bytes, a.content_sha256,
  a.provider, a.model, a.provider_request_id, a.prompt_hash, a.prompt_text, a.seed,
  a.series_version_id, a.created_at, a.rights_metadata, sv.version AS series_version
`;

/** The row shape `ASSET_VIEW_FIELDS` returns. */
export interface AssetViewRow {
  readonly id: string;
  readonly stage: string;
  readonly kind: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly object_size_bytes: string | number | null;
  readonly content_sha256: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly provider_request_id: string | null;
  readonly prompt_hash: string | null;
  readonly prompt_text: string | null;
  readonly seed: string | null;
  readonly series_version_id: string | null;
  readonly rights_metadata: unknown;
  readonly created_at: Date;
  readonly series_version: number | null;
}

function sizeBytes(value: string | number | null): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export function assetView(row: AssetViewRow): AssetView {
  return {
    id: row.id,
    stage: row.stage as AssetView['stage'],
    kind: row.kind as AssetView['kind'],
    width: row.width,
    height: row.height,
    size_bytes: sizeBytes(row.object_size_bytes),
    content_sha256: row.content_sha256,
    urls: {
      thumb: '/asset/' + row.id + '/thumb',
      detail: '/asset/' + row.id + '/detail',
      full: '/asset/' + row.id + '/full',
    },
    provenance: {
      provider: row.provider,
      model: row.model,
      prompt_hash: row.prompt_hash,
      prompt_text: row.prompt_text,
      seed: row.seed,
      series_version_id: row.series_version_id,
      series_version: row.series_version,
      created_at: row.created_at.toISOString(),
    },
  };
}
