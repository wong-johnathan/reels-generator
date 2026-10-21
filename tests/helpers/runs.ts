/**
 * Test-only constructors for a `PersistedGenerationRun`.
 *
 * The production brand proves the row is committed (src/domain/generation-run.ts).
 * A unit test of an adapter's request/response handling must not open a database,
 * so it hands the adapter a cast value. The cast is deliberate and visible; the
 * commit-before-call ordering itself is proven separately by the DB-backed tests
 * (`src/domain/generation-run.test.ts`, `src/adapters/text-qualify.test.ts`).
 */
import type { PersistedGenerationRun, ProviderStageCode } from '../../src/domain/generation-run.js';

export interface FakeRunOptions {
  readonly id?: string;
  readonly stage?: ProviderStageCode;
  readonly projectId?: string;
  readonly jobAttemptId?: string;
  readonly promptHash?: string;
  readonly attemptNo?: number;
}

export const FIXED_RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A deterministic stand-in for a committed `generation_run` row. */
export function fakePersistedRun(options: FakeRunOptions = {}): PersistedGenerationRun {
  const run = {
    id: options.id ?? FIXED_RUN_ID,
    jobAttemptId: options.jobAttemptId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: options.projectId ?? '22222222-2222-4222-8222-111111111111',
    stage: options.stage ?? 'T',
    sceneId: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptHash: options.promptHash ?? 'b'.repeat(64),
    attemptNo: options.attemptNo ?? 1,
    seriesVersionId: null,
    status: 'pending',
    chargeStatus: 'pending',
    idempotencyProtected: false,
    committedAt: new Date('2026-10-20T09:00:00.000Z'),
    committedByBackendPid: 1,
  };
  return run as unknown as PersistedGenerationRun;
}
