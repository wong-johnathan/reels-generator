/**
 * M-007 — readable object layout (deviation D-F from R-026's content addressing).
 *
 * R-026 made the object key a pure function of the content hash:
 *
 *   CHECK (object_key = 'sha256:' || content_sha256)
 *   UNIQUE (content_sha256)
 *
 * That is the right shape for a deduplicating blob store, and the wrong shape for
 * a human browsing a MinIO console: every object is named after its bytes, so the
 * library is an opaque wall of hashes. Objects are now addressed by where they
 * belong — `<series-slug>/batch-0001/scenes/S01.png`, `.../narration.mp3`,
 * `.../video.mp4` — and the hash survives on the row as provenance.
 *
 * What this gives up: one object per unique byte sequence. The same image used by
 * two batches is now stored twice. For a private factory where every video is
 * unique content that costs little, and it buys a library that can be read.
 *
 * `content_sha256` remains NOT NULL and format-checked, so provenance, auditing
 * and any future dedupe pass still have what they need. `object_key` becomes the
 * uniqueness guarantee, which also catches two assets colliding on one path.
 *
 * R-017-3 (additive-only migrations) is deliberately deviated from here: dropping
 * a CHECK constraint is structural. Recorded as D-F in DEVIATIONS.md. Existing
 * objects stay at their `sha256:` keys and remain readable — only new assets use
 * the readable layout, so this needs no data migration.
 */
export const M007_OBJECT_LAYOUT_SQL = /* sql */ `
-- The key is no longer derived from the hash.
ALTER TABLE asset DROP CONSTRAINT IF EXISTS asset_object_key_matches_hash;

-- One row per unique content is no longer true: the same bytes may legitimately
-- live in two batch folders, so uniqueness moves to the path.
DROP INDEX IF EXISTS uq_asset_content_sha256;
CREATE UNIQUE INDEX uq_asset_object_key ON asset (object_key);

-- Reads by project already exist; the download path resolves an asset by id, and
-- a per-project listing by stage is the common operator query.
CREATE INDEX IF NOT EXISTS idx_asset_project_stage ON asset (project_id, stage);

-- ── batch.ordinal: the readable half of the path ──────────────────────────────
-- batch-0001 needs a number that does not move once assets point at it, so it
-- is stored rather than derived from a count at read time. Backfilled from
-- creation order, then enforced per series.
ALTER TABLE batch ADD COLUMN IF NOT EXISTS ordinal int;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY series_id ORDER BY created_at, id) AS n
    FROM batch
   WHERE ordinal IS NULL
)
UPDATE batch b
   SET ordinal = numbered.n
  FROM numbered
 WHERE b.id = numbered.id;

ALTER TABLE batch ALTER COLUMN ordinal SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_series_ordinal ON batch (series_id, ordinal);
`;
