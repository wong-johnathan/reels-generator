/**
 * QA-owned e2e fixture: one content-worker process executing exactly one
 * billable attempt (US-013, R-012-3).
 *
 * The parent test (`tests/e2e/forced-kill.e2e.test.ts`) starts this process,
 * waits until the fake provider has received the request, then sends SIGKILL.
 * That is the real forced-kill window the requirement names: the attempt row is
 * committed, the provider was called, and no asset has been persisted.
 *
 * The process deliberately prints nothing about success: `CALL_RETURNED` only
 * appears if the fake provider ever answers, which it never does before the
 * kill.
 */
import { Pool } from 'pg';

import type { ProviderAdapter } from '../../../src/domain/generation-run.js';
import { runProviderAttempt } from '../../../src/workers/attempt.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const providerUrl = required('FAKE_PROVIDER_URL');
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 2 });

const adapter: ProviderAdapter<{ readonly ok: true }> = {
  provider: 'fake-image',
  stage: 'IM',
  async execute(): Promise<{ readonly ok: true }> {
    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_hash: 'sha256:forced-kill-e2e', scene_no: 7 }),
    });
    process.stdout.write(`CALL_RETURNED ${response.status}\n`);
    await response.text();
    return { ok: true };
  },
};

const outcome = await runProviderAttempt(
  {
    pool,
    adapter,
    // TECH_DESIGN §2 step (c): the asset is written here, after the call and
    // before the run closes. The kill lands before this line can run.
    onResult: async () => {
      process.stdout.write('PERSISTING_ASSET\n');
    },
  },
  {
    jobId: required('JOB_ID'),
    attemptNo: 1,
    projectId: required('PROJECT_ID'),
    stage: 'IM',
    provider: 'fake-image',
    model: 'fake-image-1',
    promptHash: 'sha256:forced-kill-e2e',
    workerId: 'qa-e2e-content-worker',
  },
);

process.stdout.write(`OUTCOME ${JSON.stringify({ status: outcome.status, charge: outcome.charge })}\n`);
await pool.end();
