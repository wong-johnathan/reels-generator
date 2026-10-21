/**
 * M-001 — foundation: auth, series and versioning (TECH_DESIGN §3, LEAD_PLAN §3).
 *
 * Tables: operator, session, series, series_version, reference.
 *
 * Circular FK: `series.current_version_id → series_version` cannot exist in the
 * `series` CREATE, because `series_version.series_id → series` needs `series`
 * first. It is added as a nullable ALTER after `series_version` exists
 * (LEAD_PLAN §3, "circular FK note") and maintained by the version-mint service.
 *
 * `operator` is created here and seeded by the auth task (LEAD_PLAN §4 B-13 owns
 * the argon2id hash): no credential value enters a migration.
 */
export const M001_FOUNDATION_SQL = /* sql */ `
-- The two extensions TECH_DESIGN §3 requires. pgvector backs topic dedupe (R-020);
-- without it the schema cannot be applied, so fail with an actionable message
-- instead of a bare "extension not available" (R-017-2 fails closed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION
      'M-001: the pgvector extension is not installed on this server. TECH_DESIGN §3 requires it for topic.embedding and the hnsw index (R-020); run the database on an image that ships pgvector (e.g. pgvector/pgvector:pg16).';
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── operator (D3: the single seeded operator; no registration, no reset) ─────
CREATE TABLE operator (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Exactly one operator row: a unique index on a constant expression (D3).
CREATE UNIQUE INDEX operator_single_row ON operator ((true));

-- ── session (R-015-2: httpOnly session; only the token hash is stored) ───────
CREATE TABLE session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operator (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_operator ON session (operator_id);
CREATE INDEX idx_session_expires ON session (expires_at);

-- ── series: a series profile (R-001) ─────────────────────────────────────────
CREATE TABLE series (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  slug                 text NOT NULL UNIQUE,
  niche                jsonb NOT NULL,
  script_style         jsonb,
  voice_config         jsonb,
  art_style            jsonb,
  default_aspect_ratio text NOT NULL DEFAULT '9:16',
  target_duration_s    int NOT NULL DEFAULT 75 CHECK (target_duration_s BETWEEN 10 AND 180),
  narration_language   text,
  captions_preset      jsonb,
  music_config         jsonb,
  image_resolution     text NOT NULL DEFAULT '1K',
  mode                 text NOT NULL CHECK (mode IN ('factual', 'creative')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision             int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_series_status ON series (status);

-- ── series_version: immutable snapshot of a series edit (R-002-1) ────────────
CREATE TABLE series_version (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id         uuid NOT NULL REFERENCES series (id) ON DELETE RESTRICT,
  version           int NOT NULL CHECK (version >= 1),
  snapshot          jsonb NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('factual', 'creative')),
  target_duration_s int NOT NULL CHECK (target_duration_s BETWEEN 10 AND 180),
  voice_id          text,
  art_preset        text,
  created_by        uuid REFERENCES operator (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT series_version_series_version_key UNIQUE (series_id, version)
);
CREATE INDEX idx_sv_series ON series_version (series_id);

-- Denormalised latest version (LEAD_PLAN §3 circular FK note; service-maintained).
ALTER TABLE series
  ADD COLUMN current_version_id uuid REFERENCES series_version (id);

-- ── reference: style/rights references for the 8-gram scan (R-003) ───────────
-- source_text is stored and never sent to a provider (R-003-3).
CREATE TABLE reference (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id               uuid NOT NULL REFERENCES series (id) ON DELETE CASCADE,
  title                   text NOT NULL,
  source_text             text,
  extracted_style_summary text,
  rights_note             text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reference_series ON reference (series_id);
`;
