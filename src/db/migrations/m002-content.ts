/**
 * M-002 — content documents (TECH_DESIGN §3.1).
 *
 * Tables: batch, project, topic, source, script_revision, scene, claim.
 *
 * Circular FK: `project.topic_id → topic` and `topic.project_id → project`. The
 * `project` row is created first and `topic_id` is added as a nullable ALTER
 * after `topic` exists — it is "set after topic stage" (TECH_DESIGN §3.1).
 * `scene.asset_id → asset` is the same shape and is added in M-004.
 */
export const M002_CONTENT_SQL = /* sql */ `
-- ── batch: one explicit owner request (R-019) ────────────────────────────────
CREATE TABLE batch (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id         uuid NOT NULL REFERENCES series (id),
  series_version_id uuid NOT NULL REFERENCES series_version (id),
  target_count      int NOT NULL CHECK (target_count BETWEEN 1 AND 30),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETE', 'CANCELLED')),
  created_by        uuid REFERENCES operator (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz
);
CREATE INDEX idx_batch_series ON batch (series_id);
CREATE INDEX idx_batch_status ON batch (status);

-- ── project: one video (TECH_DESIGN §4.5 for the 5 states) ───────────────────
CREATE TABLE project (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid REFERENCES batch (id),
  series_id           uuid NOT NULL REFERENCES series (id),
  position_in_batch   int CHECK (position_in_batch >= 1),
  target_duration_s   int CHECK (target_duration_s BETWEEN 10 AND 180),
  status              text NOT NULL DEFAULT 'NOT_STARTED'
                        CHECK (status IN ('NOT_STARTED', 'RUNNING', 'NEEDS_ATTENTION', 'COMPLETE', 'CANCELLED')),
  current_stage       text
                        CHECK (current_stage IN ('T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX')),
  storyboard_revision int NOT NULL DEFAULT 1 CHECK (storyboard_revision >= 1),
  lead_s              real NOT NULL DEFAULT 0.5 CHECK (lead_s >= 0),
  trail_s             real NOT NULL DEFAULT 0.5 CHECK (trail_s >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Posting order is unique inside a batch; NULL batch/position is the Milestone A
  -- single-video slice, and Postgres treats NULLs as distinct in a UNIQUE.
  CONSTRAINT project_batch_position_key UNIQUE (batch_id, position_in_batch)
);
CREATE INDEX idx_project_batch ON project (batch_id);
CREATE INDEX idx_project_series ON project (series_id);
CREATE INDEX idx_project_status ON project (status);

-- ── topic: one proposed topic per project (R-020) ────────────────────────────
CREATE TABLE topic (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  title                 text,
  description           text,
  normalized_text       text NOT NULL,
  embedding             vector(1536),
  rationale             text,
  source_links          jsonb,
  dedupe_status         text NOT NULL DEFAULT 'none' CHECK (dedupe_status IN ('none', 'rejected', 'overridden')),
  dedupe_match_topic_id uuid REFERENCES topic (id),
  status                text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  revision              int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- "one topic per project" (TECH_DESIGN §3.1) plus the lookup index of the same name.
CREATE UNIQUE INDEX idx_topic_project ON topic (project_id);
CREATE INDEX idx_topic_norm ON topic (normalized_text);
CREATE INDEX idx_topic_embedding_hnsw ON topic USING hnsw (embedding vector_cosine_ops);
ALTER TABLE project ADD COLUMN topic_id uuid REFERENCES topic (id);

-- ── source: captured research source (R-008-3, R-014-1) ──────────────────────
CREATE TABLE source (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  url          text NOT NULL,
  title        text,
  snippet      text,
  summary      text,
  content      text,
  domain       text,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  rerank_score real,
  status       text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Invariant: an accepted source is resolvable and clears the §2 rerank gate.
  CONSTRAINT source_accepted_threshold_check
    CHECK (status <> 'accepted' OR (url <> '' AND rerank_score IS NOT NULL AND rerank_score >= 1.5))
);
CREATE INDEX idx_source_project ON source (project_id);
CREATE INDEX idx_source_url ON source (url);

-- ── script_revision: versioned script document (R-004, R-005) ────────────────
CREATE TABLE script_revision (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  revision             int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  content              jsonb NOT NULL,
  schema_version       text NOT NULL,
  word_count           int CHECK (word_count >= 0),
  estimated_runtime_s  real CHECK (estimated_runtime_s >= 0),
  eight_gram_scan_pass bool,
  eight_gram_violations jsonb,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  approved_by          uuid REFERENCES operator (id),
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT script_revision_project_revision_key UNIQUE (project_id, revision)
);
CREATE INDEX idx_sr_project ON script_revision (project_id);

-- ── scene: one storyboard scene (R-007: scene_no is stable, position moves) ──
CREATE TABLE scene (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  scene_no           text NOT NULL,
  position           int NOT NULL CHECK (position >= 1),
  narration_start_ms int CHECK (narration_start_ms >= 0),
  narration_end_ms   int CHECK (narration_end_ms >= 0),
  image_prompt       text,
  camera_move        text CHECK (camera_move IN ('zoom_in', 'zoom_out', 'pan_l', 'pan_r', 'static')),
  caption_emphasis   text,
  fallback_text      text,
  uses_protagonist   bool NOT NULL DEFAULT false,
  revision           int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scene_project_scene_no_key UNIQUE (project_id, scene_no),
  CONSTRAINT scene_narration_span_check
    CHECK (narration_start_ms IS NULL OR narration_end_ms IS NULL OR narration_end_ms >= narration_start_ms)
);
-- Deliberately non-unique: a reorder swaps positions inside one transaction
-- (R-006-3); scene_no, not position, is the stable identity.
CREATE INDEX idx_scene_project_pos ON scene (project_id, position);

-- ── claim: per-video factual claims (R-027) ──────────────────────────────────
CREATE TABLE claim (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  script_revision_id uuid REFERENCES script_revision (id) ON DELETE CASCADE,
  text              text NOT NULL,
  is_factual        bool NOT NULL DEFAULT true,
  status            text NOT NULL DEFAULT 'unsourced'
                      CHECK (status IN ('sourced', 'url_unreachable', 'unsourced', 'acknowledged_unsourced', 'non_factual')),
  source_id         uuid REFERENCES source (id),
  acknowledged_by   uuid REFERENCES operator (id),
  acknowledged_at   timestamptz,
  url_status        text,
  url_reachable_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_acknowledged_recorded_check
    CHECK (status <> 'acknowledged_unsourced' OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL))
);
CREATE INDEX idx_claim_project ON claim (project_id);
CREATE INDEX idx_claim_script_revision ON claim (script_revision_id);
`;
