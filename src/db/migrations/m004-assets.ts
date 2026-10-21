/**
 * M-004 — assets: content-addressed provenance (R-013, R-026).
 *
 * Tables: asset, asset_ref.
 *
 * Circular FK: `asset.generation_run_id → generation_run` is created with
 * `asset`; the reverse `generation_run.asset_id → asset` is the additive
 * nullable ALTER below (LEAD_PLAN §3). `scene.asset_id → asset` is added here
 * for the same reason — `scene` exists from M-002.
 *
 * R-026 is structural: `unique(content_sha256)` plus an object key derived from
 * the hash, so the object store can never hold two blobs for one hash.
 */
export const M004_ASSETS_SQL = /* sql */ `
-- ── asset: content-addressed blob + provenance (R-013-1, R-026) ──────────────
CREATE TABLE asset (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES project (id) ON DELETE SET NULL,
  stage                 text NOT NULL CHECK (stage IN ('IM', 'NA', 'RE', 'QC', 'EX', 'MUSIC', 'POSTER', 'DERIV', 'REF')),
  scene_id              uuid REFERENCES scene (id) ON DELETE SET NULL,
  kind                  text NOT NULL
                          CHECK (kind IN ('image', 'audio', 'video', 'caption', 'sidecar', 'zip', 'derivative')),
  content_sha256        text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  object_key            text NOT NULL,
  object_size_bytes     bigint CHECK (object_size_bytes >= 0),
  mime_type             text,
  width                 int CHECK (width > 0),
  height                int CHECK (height > 0),
  series_version_id     uuid REFERENCES series_version (id),
  provider              text,
  model                 text,
  seed                  text,
  provider_request_id   text,
  prompt_hash           text,
  prompt_text           text,
  rights_metadata       jsonb,
  generation_run_id     uuid REFERENCES generation_run (id),
  retention_eligible_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- R-026-2: the object key is a pure function of the hash.
  CONSTRAINT asset_object_key_matches_hash CHECK (object_key = 'sha256:' || content_sha256)
);
-- One row per unique content hash (R-026-1); also the dedupe landing point.
CREATE UNIQUE INDEX uq_asset_content_sha256 ON asset (content_sha256);
CREATE INDEX idx_asset_project ON asset (project_id);
CREATE INDEX idx_asset_retention ON asset (retention_eligible_at);

-- ── asset_ref: M:N asset↔project link for shared content (R-026) ─────────────
CREATE TABLE asset_ref (
  asset_id   uuid NOT NULL REFERENCES asset (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, project_id, role)
);
CREATE INDEX idx_asset_ref_project ON asset_ref (project_id);

-- Reverse edges of the circular FK pair (LEAD_PLAN §3).
ALTER TABLE generation_run ADD COLUMN asset_id uuid REFERENCES asset (id);
ALTER TABLE scene ADD COLUMN asset_id uuid REFERENCES asset (id);
`;
