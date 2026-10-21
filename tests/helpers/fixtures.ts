/**
 * Row fixtures for the schema tests.
 *
 * These inserts are raw SQL on purpose: they exercise the constraints the
 * migrations declare, and they are not a production write path (the domain
 * services own those). `seedProject` builds the smallest legal chain an attempt
 * needs — operator → series → series_version → project → job.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

export interface SeededProject {
  readonly operatorId: string;
  readonly seriesId: string;
  readonly seriesVersionId: string;
  readonly projectId: string;
  readonly jobId: string;
}

export async function seedProject(pool: Pool): Promise<SeededProject> {
  // D3: exactly one operator row exists for the lifetime of the deployment, so a
  // second seed call reuses it instead of inserting a duplicate.
  await pool.query(
    `INSERT INTO operator (username, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    ['owner', 'argon2id-placeholder-not-a-real-hash'],
  );
  const operator = await pool.query<{ id: string }>(`SELECT id FROM operator LIMIT 1`);
  const operatorId = operator.rows[0]!.id;

  const slug = `quiet-machines-${randomUUID().slice(0, 8)}`;
  const series = await pool.query<{ id: string }>(
    `INSERT INTO series (name, slug, niche, mode)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
    ['Quiet Machines', slug, '{"subject":"psychology","audience":"curious adults"}', 'creative'],
  );
  const seriesId = series.rows[0]!.id;

  const version = await pool.query<{ id: string }>(
    `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s, created_by)
     VALUES ($1, 1, $2::jsonb, $3, 75, $4) RETURNING id`,
    [seriesId, '{"name":"Quiet Machines"}', 'creative', operatorId],
  );
  const seriesVersionId = version.rows[0]!.id;

  await pool.query(`UPDATE series SET current_version_id = $1 WHERE id = $2`, [
    seriesVersionId,
    seriesId,
  ]);

  // Every asset writer now resolves the series slug + batch ordinal for the
  // readable object path (D-F), so the fixture mints a batch exactly the way
  // createBatch does and links the project into it.
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO batch (series_id, series_version_id, target_count, ordinal)
     VALUES ($1, $2, 1, 1) RETURNING id`,
    [seriesId, seriesVersionId],
  );
  const batchId = batch.rows[0]!.id;

  const project = await pool.query<{ id: string }>(
    `INSERT INTO project (batch_id, series_id, position_in_batch, status, current_stage)
     VALUES ($1, $2, 1, 'RUNNING', 'T') RETURNING id`,
    [batchId, seriesId],
  );
  const projectId = project.rows[0]!.id;

  const job = await pool.query<{ id: string }>(
    `INSERT INTO job (project_id, stage, status) VALUES ($1, 'T', 'running') RETURNING id`,
    [projectId],
  );

  return { operatorId, seriesId, seriesVersionId, projectId, jobId: job.rows[0]!.id };
}
