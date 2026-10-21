/**
 * M-005 — state, gates and seed (TECH_DESIGN §3.2, §4.3).
 *
 * Tables: video_stage, review_decision, publication_log, invalidation_rule,
 * provider_qualification. Seeds the 8-row invalidation matrix of §4.3.
 *
 * The matrix is data, not code (R-006-2, D12): changing it is a data migration,
 * so `src/domain/invalidation.ts` (B-03) reads these rows and only these rows.
 */
export const M005_STATE_GATES_SEED_SQL = /* sql */ `
-- ── video_stage: per-stage state + the per-stage series-version pin (R-002-2/4)
CREATE TABLE video_stage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  stage             text NOT NULL CHECK (stage IN ('T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX')),
  state             text NOT NULL DEFAULT 'not_run'
                      CHECK (state IN ('not_run', 'running', 'done', 'awaiting_approval', 'stale', 'failed', 'blocked', 'cancelled')),
  series_version_id uuid REFERENCES series_version (id),
  stale             bool NOT NULL DEFAULT false,
  stale_cause       text,
  stale_revision    int,
  stale_at          timestamptz,
  last_event_at     timestamptz,
  last_event        text,
  progress_current  int CHECK (progress_current >= 0),
  progress_total    int CHECK (progress_total >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_stage_project_stage_key UNIQUE (project_id, stage)
);
CREATE INDEX idx_video_stage_project ON video_stage (project_id);
CREATE INDEX idx_video_stage_state ON video_stage (state);

-- ── review_decision: operator gate / staleness ledger (R-005) ────────────────
CREATE TABLE review_decision (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  stage                text NOT NULL CHECK (stage IN ('SC', 'SB', 'IM', 'FA', 'STALE')),
  decision             text NOT NULL
                         CHECK (decision IN ('approve', 'reject', 'accept_staleness', 'acknowledge_unsourced')),
  target_stage         text CHECK (target_stage IS NULL OR target_stage IN ('T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX')),
  reason               text,
  revision_at_decision int,
  decided_by           uuid REFERENCES operator (id),
  decided_at           timestamptz NOT NULL DEFAULT now(),
  -- R-005-4: a reject names the return stage and its reason.
  CONSTRAINT review_decision_reject_check
    CHECK (decision <> 'reject' OR (reason IS NOT NULL AND target_stage IS NOT NULL))
);
CREATE INDEX idx_rd_project ON review_decision (project_id, stage);

-- ── publication_log: manual posting record (R-014-4, D8) ────────────────────
CREATE TABLE publication_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  platform    text NOT NULL,
  posted_at   timestamptz NOT NULL,
  url         text,
  posted_flag bool NOT NULL DEFAULT false,
  posted_by   uuid REFERENCES operator (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pl_project ON publication_log (project_id);
CREATE INDEX idx_pl_posted ON publication_log (posted_flag);

-- ── invalidation_rule: the invalidation matrix as data (R-006-2, §4.3) ──────
CREATE TABLE invalidation_rule (
  edit_kind         text PRIMARY KEY
                      CHECK (edit_kind IN ('script_wording', 'duration', 'aspect_ratio', 'image_replace',
                                           'captions_music', 'voice_speed', 'topic_after_research', 'reorder')),
  invalidated_stages text[] NOT NULL,
  survives          text[] NOT NULL,
  image_calls       int NOT NULL CHECK (image_calls >= 0),
  tts_calls         int NOT NULL CHECK (tts_calls >= 0),
  render_passes     int NOT NULL CHECK (render_passes >= 0),
  text_action       text,
  conditional_check text,
  description       text
);

INSERT INTO invalidation_rule
  (edit_kind, invalidated_stages, survives, image_calls, tts_calls, render_passes, text_action, conditional_check, description)
VALUES
  ('script_wording', ARRAY['SB', 'NA', 'TC', 'RE'], ARRAY['IM'], 0, 1, 1,
   're-derive 17 scene prompts', NULL,
   'Wording-only script edit: images survive, narration and everything after it re-run.'),
  ('duration', ARRAY['SC', 'SB', 'NA', 'TC', 'RE'], ARRAY['IM'], 0, 1, 1,
   're-derive script + storyboard', NULL,
   'Target-duration change re-derives the script and storyboard; existing images survive.'),
  ('aspect_ratio', ARRAY['RE'], ARRAY['IM'], 0, 0, 1,
   NULL, 'reframe',
   'Render re-runs; the conditional reframe adds 17 image calls only if the reframe check fails.'),
  ('image_replace', ARRAY['IM', 'RE'], ARRAY['NA'], 1, 0, 1,
   NULL, NULL,
   'IM is invalidated for the replaced scene only (one image call); other scenes and narration survive.'),
  ('captions_music', ARRAY['RE'], ARRAY['IM', 'NA'], 0, 0, 1,
   NULL, NULL,
   'Captions and music are burned at render time, so only render re-runs.'),
  ('voice_speed', ARRAY['NA', 'TC', 'RE'], ARRAY['IM'], 0, 1, 1,
   NULL, NULL,
   'Narration, timing and render re-run; images survive.'),
  ('topic_after_research', ARRAY['SC', 'SB', 'NA', 'TC', 'RE'], ARRAY[]::text[], 0, 1, 1,
   're-derive script + storyboard', NULL,
   'A topic change after research re-derives the script and storyboard; RS/IM are invalidated downstream.'),
  ('reorder', ARRAY['TC', 'RE'], ARRAY['IM', 'NA'], 0, 0, 1,
   'captions remap to new order', NULL,
   'Reorder touches scene position only; captions remap and render re-runs.');

-- ── provider_qualification: recorded adapter qualification (R-008-3) ────────
-- Written by each adapter's qualify(); empty until US-012 runs.
CREATE TABLE provider_qualification (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  adapter  text NOT NULL,
  passed   bool NOT NULL,
  details  jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pq_provider_adapter_run ON provider_qualification (provider, adapter, run_at DESC);
`;
