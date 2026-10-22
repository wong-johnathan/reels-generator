import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  advanceAfterStage,
  type ClaimedJob,
  RENDER_STAGES,
  runStage,
  type OrchestratorDeps,
} from './orchestrator.js';
import { renderShell, type ShellModel } from '../web/render/shell.js';
const hooks = vi.hoisted(() => ({
  sb: vi.fn(),
  fa: vi.fn(),
  qc: vi.fn(),
  ex: vi.fn(),
  event: vi.fn(),
  current: vi.fn(),
  insert: vi.fn(),
  settle: vi.fn(),
}));
vi.mock('./auto-approval.js', () => ({
  autoApproveStoryboard: hooks.sb,
  autoApproveFinal: hooks.fa,
}));
vi.mock('../render/qc-stage.js', () => ({ runQcStage: hooks.qc }));
vi.mock('../export/stage.js', () => ({ runExportStage: hooks.ex }));
vi.mock('../db/repositories/stage-state.js', () => ({
  applyStageEvent: hooks.event,
  setProjectCurrentStage: hooks.current,
}));
vi.mock('../db/repositories/jobs.js', () => ({ insertQueuedJob: hooks.insert }));
vi.mock('./settle.js', () => ({ settleAfterStage: hooks.settle }));
const job = (stage: ClaimedJob['stage']): ClaimedJob => ({
  id: 'j',
  projectId: 'p',
  stage,
  sceneId: null,
  priority: 2,
});
const query = vi.fn(async (sql: string, args?: unknown[]) => ({
  rows: sql.includes('count(*)')
    ? [{ n: '0' }]
    : sql.includes('SELECT state')
      ? [{ state: args?.[1] === 'QC' ? 'not_run' : 'done' }]
      : [],
}));
const pool = { query } as unknown as Pool;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('automatic approval rail', () => {
  it('parks SB but confirms it through its normal gateway', async () => {
    await advanceAfterStage(pool, job('SB'));
    expect(hooks.event).toHaveBeenCalledWith(pool, 'p', 'SB', 'gate');
    expect(hooks.sb).toHaveBeenCalledWith(pool, 'p');
    expect(hooks.insert).not.toHaveBeenCalled(); // gateway owns IM mint
  });
  it('adds QC and EX to render-worker claims', () => {
    expect(RENDER_STAGES).toEqual(expect.arrayContaining(['RE', 'QC', 'EX']));
  });
  it('never mints IM past a duplicate SB advance while approval is waiting', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'false');
    query.mockResolvedValueOnce({ rows: [{ state: 'awaiting_approval' }] });
    query.mockResolvedValueOnce({ rows: [{ state: 'awaiting_approval' }] });
    expect(await advanceAfterStage(pool, job('SB'))).toBeNull();
    expect(hooks.insert).not.toHaveBeenCalled();
  });
  it('keeps the legacy manual RE end when OFF after a completed render', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'false');
    await advanceAfterStage(pool, job('RE'));
    expect(hooks.settle).toHaveBeenCalled();
    expect(hooks.insert).not.toHaveBeenCalled();
  });
  it('schedules real QC after RE when ON, not a fake pass', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    expect(await advanceAfterStage(pool, job('RE'))).toBe('QC');
    expect(hooks.insert).toHaveBeenCalledWith(pool, { projectId: 'p', stage: 'QC', priority: 2 });
    expect(hooks.fa).not.toHaveBeenCalled();
    expect(hooks.settle).not.toHaveBeenCalled();
  });
  it('dispatches QC and refuses a failure', async () => {
    hooks.qc.mockResolvedValue({ status: 'fail', error: 'QC failed' });
    const deps = { pool } as OrchestratorDeps;
    expect((await runStage(deps, job('QC'))).status).toBe('failed');
    expect(hooks.qc).toHaveBeenCalled();
    expect(hooks.fa).not.toHaveBeenCalled();
  });
  it('dispatches the normal export runner (which validates approval/assets)', async () => {
    hooks.ex.mockResolvedValue({ status: 'built' });
    expect((await runStage({ pool } as OrchestratorDeps, job('EX'))).status).toBe('succeeded');
    hooks.ex.mockResolvedValue({ status: 'refused', error: 'missing asset' });
    expect((await runStage({ pool } as OrchestratorDeps, job('EX'))).status).toBe('failed');
  });
});

describe('operator indicator', () => {
  it('shows automatic approval active only when configured', () => {
    const model: ShellModel = {
      title: 'Test',
      documentTitle: 'Test',
      nav: 'batches',
      content: '',
      breadcrumbs: [],
      attentionCount: 0,
      degraded: [],
      assets: { stylesHref: '/app.css', extraScripts: [] },
      status: {
        ready: true,
        degradedReasons: [],
        inFlight: 0,
        attention: null,
        operator: null,
        updatedAt: null,
        now: 0,
      },
    };
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    expect(renderShell(model)).toContain('Automatic approval active');
    vi.stubEnv('AUTO_APPROVE_ALL', 'false');
    expect(renderShell(model)).not.toContain('Automatic approval active');
  });
});
