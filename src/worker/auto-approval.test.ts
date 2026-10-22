import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { validateEnv } from '../config/env.js';
import { autoApproveFinal, autoApproveStoryboard } from './auto-approval.js';

const scenes = { storyboard: vi.fn(), approveStoryboard: vi.fn() };
const render = { revision: vi.fn(), approve: vi.fn() };
vi.mock('../web/scenes/postgres.js', () => ({ createPostgresSceneGateway: () => scenes }));
vi.mock('../web/quality/postgres.js', () => ({ createPostgresRenderGateway: () => render }));
const pool = {} as Pool;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('AUTO_APPROVE_ALL', () => {
  it('is a validated boolean, default false', () => {
    expect(validateEnv({}, 'worker').values.AUTO_APPROVE_ALL).toBe('false');
    for (const value of ['true', 'false']) {
      expect(validateEnv({ AUTO_APPROVE_ALL: value }, 'web').values.AUTO_APPROVE_ALL).toBe(value);
    }
    for (const value of ['yes', '1', 'TRUE']) {
      expect(validateEnv({ AUTO_APPROVE_ALL: value }, 'worker').issues).toContainEqual(
        expect.objectContaining({ key: 'AUTO_APPROVE_ALL', problem: 'invalid' }),
      );
    }
  });

  it.each(['false', ''])('leaves both gates manual when %j', async (value) => {
    vi.stubEnv('AUTO_APPROVE_ALL', value);
    expect(await autoApproveStoryboard(pool, 'p')).toBe(false);
    expect(await autoApproveFinal(pool, 'p')).toBe(false);
    expect(scenes.storyboard).not.toHaveBeenCalled();
    expect(render.revision).not.toHaveBeenCalled();
  });

  it('approves SB via the normal revision-checked gateway with an audit reason', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    scenes.storyboard.mockResolvedValue({ revision: 4, approved: false });
    expect(await autoApproveStoryboard(pool, 'p')).toBe(true);
    expect(scenes.approveStoryboard).toHaveBeenCalledWith('p', {
      revision: 4,
      note: 'auto_approve_all',
    });
  });

  it('approves FA via the normal revision-checked gateway with an audit reason', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    render.revision.mockResolvedValue(3);
    expect(await autoApproveFinal(pool, 'p')).toBe(true);
    expect(render.approve).toHaveBeenCalledWith('p', { revision: 3, note: 'auto_approve_all' });
  });

  it('preserves the render revision QC actually inspected instead of approving a newer render', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    render.revision.mockResolvedValue(2);
    render.approve.mockRejectedValue(new Error('stale revision'));
    await expect(autoApproveFinal(pool, 'p', 1)).rejects.toThrow('stale revision');
    expect(render.revision).not.toHaveBeenCalled();
    expect(render.approve).toHaveBeenCalledWith('p', { revision: 1, note: 'auto_approve_all' });
  });

  it('does not approve absent assets', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    scenes.storyboard.mockResolvedValue(null);
    render.revision.mockResolvedValue(null);
    expect(await autoApproveStoryboard(pool, 'p')).toBe(false);
    expect(await autoApproveFinal(pool, 'p')).toBe(false);
    expect(scenes.approveStoryboard).not.toHaveBeenCalled();
    expect(render.approve).not.toHaveBeenCalled();
  });

  it.each(['QC failed', 'stale revision', 'missing asset', 'hard validation error'])(
    'never masks gateway refusal: %s',
    async (message) => {
      vi.stubEnv('AUTO_APPROVE_ALL', 'true');
      render.revision.mockResolvedValue(1);
      render.approve.mockRejectedValue(new Error(message));
      await expect(autoApproveFinal(pool, 'p')).rejects.toThrow(message);
      scenes.storyboard.mockResolvedValue({ revision: 1, approved: false });
      scenes.approveStoryboard.mockRejectedValue(new Error(message));
      await expect(autoApproveStoryboard(pool, 'p')).rejects.toThrow(message);
    },
  );
});
