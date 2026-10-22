import type { Pool } from 'pg';
import { automaticApprovalActive } from '../config/auto-approval.js';
import { createPostgresSceneGateway } from '../web/scenes/postgres.js';
import { createPostgresRenderGateway } from '../web/quality/postgres.js';

/** Use exactly the same transactional validation and ledger as manual approval.
 * Reads supply the expected revision, not authority: a racing edit is refused
 * by the gateway under lock. Refusals propagate; they are never auto-retried
 * with a newer revision that has not been checked.
 */
export async function autoApproveStoryboard(pool: Pool, projectId: string): Promise<boolean> {
  if (!automaticApprovalActive()) return false;
  const gateway = createPostgresSceneGateway(pool);
  const board = await gateway.storyboard(projectId);
  if (board === null || board.approved) return false;
  await gateway.approveStoryboard(projectId, {
    revision: board.revision,
    note: 'auto_approve_all',
  });
  return true;
}

export async function autoApproveFinal(
  pool: Pool,
  projectId: string,
  checkedRevision?: number,
): Promise<boolean> {
  if (!automaticApprovalActive()) return false;
  const gateway = createPostgresRenderGateway(pool);
  const revision = checkedRevision ?? (await gateway.revision?.(projectId));
  if (revision === null || revision === undefined) return false;
  await gateway.approve(projectId, { revision, note: 'auto_approve_all' });
  return true;
}
