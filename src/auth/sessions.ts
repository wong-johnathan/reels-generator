/**
 * Postgres-backed session store — TECH_DESIGN §3.2 (`session`), R-015-2.
 *
 * Only the sha256 of the cookie value is stored, so the database is not a
 * credential store for live sessions. Expiry is enforced in SQL as well as in
 * the service, so a session that has just expired cannot be read by a race.
 */
import type { Queryable } from '../db/client.js';
import type { NewSession, SessionRecord, SessionStore } from './types.js';

interface SessionRow {
  readonly id: string;
  readonly operator_id: string;
  readonly username: string;
  readonly token_hash: string;
  readonly expires_at: Date;
  readonly created_at: Date;
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Queryable) {}

  async create(session: NewSession): Promise<{ id: string }> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO session (operator_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [session.operatorId, session.tokenHash, session.expiresAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error('the session insert returned no row');
    return { id: row.id };
  }

  async findByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.id, s.operator_id, o.username, s.token_hash, s.expires_at, s.created_at
         FROM session s
         JOIN operator o ON o.id = s.operator_id
        WHERE s.token_hash = $1
          AND s.expires_at > $2
        LIMIT 1`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      operatorId: row.operator_id,
      username: row.username,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async deleteById(id: string): Promise<void> {
    await this.db.query('DELETE FROM session WHERE id = $1', [id]);
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.query('DELETE FROM session WHERE expires_at <= $1', [now]);
    return result.rowCount ?? result.rows.length;
  }
}
