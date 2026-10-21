/**
 * Postgres adapter for the S-10 script surface — contract `script.get`.
 *
 * This is the production half of the ScriptGateway seam: the web app renders
 * `ScriptView | null` and never invents a response, so every field below maps
 * to a column (or a documented derivation from columns) and nothing else.
 *
 * The `ScriptGateway` interface only exposes `get` — `script.save` and
 * `script.approve` exist in the frozen contract but are not part of this seam,
 * so the adapter implements the read only. The optimistic-lock revision is
 * still carried on the view so a future save seam can use it unchanged.
 *
 * `budget` is not a stored column: it is re-derived from `project
 * .target_duration_s` with the same `wordBudget` formula the script pipeline
 * used (src/shared/calibration.ts), and `within_band` is recomputed against the
 * stored `script_revision.word_count`. That is a pure function of two stored
 * values, not a fabricated figure.
 */
import type { Pool } from 'pg';

import { ScriptViewSchema } from '../../../contract/api.js';
import { withTransaction, type Queryable } from '../../db/client.js';
import { DEFAULT_TARGET_DURATION_S, wordBudget } from '../../shared/calibration.js';
import type { ScriptGateway, ScriptView } from './gateway.js';

/** `script_revision` + the project column the budget derivation needs. */
interface ScriptRevisionRow {
  readonly id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly schema_version: string;
  readonly status: string;
  readonly content: unknown;
  readonly word_count: number | null;
  readonly estimated_runtime_s: number | null;
  readonly eight_gram_scan_pass: boolean | null;
  readonly eight_gram_violations: unknown;
  readonly approved_at: Date | null;
  readonly target_duration_s: number | null;
}

interface ClaimRow {
  readonly id: string;
  readonly script_revision_id: string;
  readonly text: string;
  readonly is_factual: boolean;
  readonly status: string;
  readonly source_id: string | null;
  readonly url_status: string | null;
  readonly url_reachable_at: Date | null;
  readonly source_url: string | null;
  readonly source_title: string | null;
  readonly source_domain: string | null;
  readonly source_rerank_score: number | null;
}

const SCRIPT_SELECT = /* sql */ `
  sr.id, sr.project_id, sr.revision, sr.schema_version, sr.status, sr.content,
  sr.word_count, sr.estimated_runtime_s, sr.eight_gram_scan_pass,
  sr.eight_gram_violations, sr.approved_at, p.target_duration_s
`;

async function findLatestScript(db: Queryable, videoId: string): Promise<ScriptRevisionRow | null> {
  const result = await db.query<ScriptRevisionRow>(
    `SELECT ${SCRIPT_SELECT}
       FROM script_revision sr
       JOIN project p ON p.id = sr.project_id
      WHERE sr.project_id = $1
      ORDER BY sr.revision DESC
      LIMIT 1`,
    [videoId],
  );
  return result.rows[0] ?? null;
}

async function listClaims(db: Queryable, scriptRevisionId: string): Promise<ClaimRow[]> {
  const result = await db.query<ClaimRow>(
    `SELECT c.id, c.script_revision_id, c.text, c.is_factual, c.status,
            c.source_id, c.url_status, c.url_reachable_at,
            s.url AS source_url, s.title AS source_title,
            s.domain AS source_domain, s.rerank_score AS source_rerank_score
       FROM claim c
       LEFT JOIN source s ON s.id = c.source_id
      WHERE c.script_revision_id = $1
      ORDER BY c.created_at ASC, c.id ASC`,
    [scriptRevisionId],
  );
  return result.rows;
}

/** `claim.url_status` is stored as text; the contract wants an int or null. */
function parseHttpStatus(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function toScriptView(row: ScriptRevisionRow, claims: ClaimRow[]): ScriptView {
  const wordCount = row.word_count ?? 0;
  const budget = wordBudget(row.target_duration_s ?? DEFAULT_TARGET_DURATION_S);
  return ScriptViewSchema.parse({
    id: row.id,
    project_id: row.project_id,
    revision: row.revision,
    schema_version: row.schema_version,
    status: row.status,
    content: row.content,
    word_count: wordCount,
    estimated_runtime_s: row.estimated_runtime_s ?? 0,
    budget: {
      target_words: budget.target_words,
      min_words: budget.min_words,
      max_words: budget.max_words,
      within_band: wordCount >= budget.min_words && wordCount <= budget.max_words,
    },
    eight_gram: {
      // `null` (scan never recorded) fails closed: no pass may be assumed.
      pass: row.eight_gram_scan_pass ?? false,
      violations: toStrings(row.eight_gram_violations),
    },
    claims: claims.map((claim) => ({
      id: claim.id,
      script_revision_id: claim.script_revision_id,
      text: claim.text,
      is_factual: claim.is_factual,
      status: claim.status,
      source:
        claim.source_id === null
          ? null
          : {
              id: claim.source_id,
              url: claim.source_url ?? '',
              title: claim.source_title,
              domain: claim.source_domain ?? '',
              rerank_score: claim.source_rerank_score ?? 0,
            },
      url_status: parseHttpStatus(claim.url_status),
      url_reachable_at:
        claim.url_reachable_at === null ? null : claim.url_reachable_at.toISOString(),
    })),
    approved_at: row.approved_at === null ? null : row.approved_at.toISOString(),
  });
}

export function createPostgresScriptGateway(pool: Pool): ScriptGateway {
  return {
    async get(videoId: string): Promise<ScriptView | null> {
      return withTransaction(pool, async (client) => {
        const script = await findLatestScript(client, videoId);
        if (script === null) return null;
        const claims = await listClaims(client, script.id);
        return toScriptView(script, claims);
      });
    },
  };
}
