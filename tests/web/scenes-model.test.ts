import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { StoryboardViewSchema } from '../../contract/api.js';
import type { StageState } from '../../src/shared/stages.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  checkpointState,
  gridCountText,
  gridCounts,
  MAX_SCENE_PROMPT,
  promptSummary,
  provenanceRows,
  PROVENANCE_NOT_RECORDED,
  releaseLabel,
  releaseSubLabel,
  replaceButtonLabel,
  replaceConsequence,
  sceneAccessibleName,
  sceneSpan,
  sceneTiles,
  storyboardRows,
  storyboardState,
} from '../../src/web/scenes/model.js';
import type { SceneView, StoryboardView } from '../../src/web/scenes/model.js';

type Scene = z.infer<typeof StoryboardViewSchema>['scenes'][number];

/**
 * F-06 model derivations — UI_SPEC §5 UC-07/UC-08, §6.7 W-06, UX_SPEC
 * W-06/A-15/A-17, R-007-1, R-013-1.
 *
 * Every number and every sentence the grid, the tiles and the provenance panel
 * show is derived here from the contract shapes, so the renderer cannot invent
 * a count, a span or a call estimate.
 */

const storyboard = StoryboardViewSchema.parse(FIXTURES['storyboard.get']);

function withScenes(
  patch: (scene: Scene, index: number) => Scene,
  base = storyboard,
): StoryboardView {
  return { ...base, scenes: base.scenes.map((scene, index) => patch(scene, index)) };
}

/** The checkpoint state: scenes 1–3 have images, 4–17 have not started. */
const checkpoint = (): StoryboardView =>
  withScenes((scene, index) =>
    index < 3
      ? { ...scene, state: 'done' }
      : { ...scene, asset: null, state: 'not_run', revision: 1 },
  );

const firstThreeReached = (): StoryboardView => ({
  ...checkpoint(),
  first_three_reviewed: false,
  approved: false,
  approved_at: null,
});

describe('scene spans (UC-08 meta row, AX-15)', () => {
  it('renders a 4.4 s narration span with a spoken full form', () => {
    const scene = storyboard.scenes[0] as SceneView;
    expect(sceneSpan(scene)).toEqual({ seconds: 4.4, compact: '4.4 s', spoken: '4.4 seconds' });
  });

  it('rounds to one decimal, never to a whole second', () => {
    const scene = {
      ...(storyboard.scenes[0] as SceneView),
      narration: { start_ms: 0, end_ms: 3150 },
    };
    expect(sceneSpan(scene)?.compact).toBe('3.2 s');
    expect(sceneSpan(scene)?.spoken).toBe('3.2 seconds');
  });

  it('is null when the storyboard has no narration spans yet', () => {
    const scene = { ...(storyboard.scenes[0] as SceneView), narration: null };
    expect(sceneSpan(scene)).toBeNull();
  });
});

describe('tile text (UC-08, AX-15)', () => {
  it('caps the prompt summary at 140 characters and marks the cut', () => {
    const long = 'a'.repeat(MAX_SCENE_PROMPT + 20);
    const summary = promptSummary(long);
    expect(summary.length).toBe(MAX_SCENE_PROMPT);
    expect(summary.endsWith('…')).toBe(true);
    expect(promptSummary('short prompt')).toBe('short prompt');
  });

  it('names the tile: position, id, state, narration and pin', () => {
    const scene = storyboard.scenes[2] as SceneView;
    expect(sceneAccessibleName(scene, 17)).toBe(
      'Scene 3 of 17, S03, done, 4.4 second narration, pin v3',
    );
  });

  it('omits the narration clause and the pin when there is neither', () => {
    const scene = {
      ...(storyboard.scenes[3] as SceneView),
      asset: null,
      state: 'not_run' as const,
      narration: null,
    };
    expect(sceneAccessibleName(scene, 17)).toBe('Scene 4 of 17, S04, not run');
  });
});

describe('grid counts (UC-07 header)', () => {
  it('counts all-ready scenes as 17 generated and 0 not started', () => {
    const counts = gridCounts(storyboard.scenes, 17);
    expect(counts).toMatchObject({ total: 17, generated: 17, notStarted: 0, remaining: 0 });
    expect(gridCountText(counts)).toBe('17 of 17 generated');
  });

  it('counts the checkpoint: 3 generated, 14 not started', () => {
    const counts = gridCounts(checkpoint().scenes, 17);
    expect(counts).toMatchObject({ total: 17, generated: 3, notStarted: 14, remaining: 14 });
    expect(gridCountText(counts)).toBe('3 of 17 generated · 14 not started');
  });

  it('keeps running, failed and stale scenes out of the not-started count', () => {
    const scenes = withScenes((scene, index) => {
      if (index < 3) return { ...scene, state: 'done' };
      if (index === 3) return { ...scene, asset: null, state: 'running' };
      if (index === 4) return { ...scene, asset: null, state: 'failed' };
      if (index === 5) return { ...scene, state: 'stale' };
      return { ...scene, asset: null, state: 'not_run' };
    }).scenes;
    const counts = gridCounts(scenes, 17);
    expect(counts.generating).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.stale).toBe(1);
    expect(counts.notStarted).toBe(11);
    expect(gridCountText(counts)).toBe('4 of 17 generated · 11 not started');
  });

  it('renders the full grid even when the storyboard has fewer rows than the target', () => {
    const partial = { ...checkpoint(), scenes: checkpoint().scenes.slice(0, 3) };
    const counts = gridCounts(partial.scenes, partial.scene_count);
    expect(counts).toMatchObject({ total: 17, generated: 3, notStarted: 14 });
  });
});

describe('first-three checkpoint (PRD §10, A-15, W-06)', () => {
  it('is open with the exact 14-call copy while scenes 4–17 wait', () => {
    const state = checkpointState({
      storyboard: firstThreeReached(),
      blockedReason: null,
    });
    expect(state.kind).toBe('open');
    expect(state.kind === 'open' && state.copy).toBe(
      '3 of 17 generated. Check the protagonist before releasing the remaining 14 (14 image calls).',
    );
    expect(state.kind === 'open' && state.remaining).toBe(14);
    expect(releaseLabel(14)).toBe('Release remaining 14');
    expect(releaseSubLabel(14)).toBe('14 image calls');
  });

  it('is cleared once the first three are reviewed', () => {
    expect(
      checkpointState({
        storyboard: { ...storyboard, first_three_reviewed: true },
        blockedReason: null,
      }).kind,
    ).toBe('cleared');
  });

  it('names the exception for a series with no recurring character', () => {
    const noProtagonist = withScenes((scene) => ({ ...scene, uses_protagonist: false }));
    const state = checkpointState({ storyboard: noProtagonist, blockedReason: null });
    expect(state.kind).toBe('not_applicable');
    expect(state.kind === 'not_applicable' && state.copy).toBe(
      'Protagonist checkpoint not applicable — this series has no recurring character.',
    );
  });

  it('blocks with the stage reason when the script is not approved', () => {
    const state = checkpointState({
      storyboard: null,
      blockedReason: 'script not approved',
      total: 17,
    });
    expect(state.kind).toBe('blocked');
    expect(state.kind === 'blocked' && state.reason).toBe('script not approved');
    expect(state.kind === 'blocked' && state.copy).toBe(
      '0 of 17 generated. Images are blocked until the script is approved.',
    );
  });

  it('never claims a checkpoint on a series that has no protagonist reference', () => {
    const noProtagonist = withScenes((scene) => ({ ...scene, uses_protagonist: false }));
    expect(checkpointState({ storyboard: noProtagonist, blockedReason: null }).kind).toBe(
      'not_applicable',
    );
  });
});

describe('tiles (UC-08)', () => {
  const tiles = (board: StoryboardView, blockedReason: string | null = null) =>
    sceneTiles({
      videoId: '11111111-1111-4111-8111-111111111111',
      scenes: board.scenes,
      total: board.scene_count,
      checkpoint: checkpointState({ storyboard: board, blockedReason }),
    });

  it('renders one tile per scene, in order, each linking to S-13', () => {
    const list = tiles(storyboard);
    expect(list).toHaveLength(17);
    expect(list[0]?.no).toBe('S01');
    expect(list[16]?.no).toBe('S17');
    expect(list[6]?.href).toBe(
      '/videos/11111111-1111-4111-8111-111111111111/scenes/dddddddd-dddd-4ddd-8ddd-000000000007',
    );
  });

  it('carries the pin, the alt text and the state on every generated tile', () => {
    const tile = tiles(storyboard)[2];
    expect(tile?.pin).toBe('v3');
    expect(tile?.state).toBe('done');
    expect(tile?.alt).toBe('Scene 3: the protagonist meets the idea');
    expect(tile?.imageUrl).toBe('/asset/99999999-9999-4999-8999-111111111111/thumb');
  });

  it('marks scenes 4+ as blocked by the open checkpoint and 1–3 as not', () => {
    const list = tiles(firstThreeReached());
    expect(list[0]?.blockedByCheckpoint).toBe(false);
    expect(list[2]?.blockedByCheckpoint).toBe(false);
    expect(list[3]?.blockedByCheckpoint).toBe(true);
    expect(list[16]?.blockedByCheckpoint).toBe(true);
    expect(list[3]?.alt).toBe('Scene 4: the protagonist meets the idea');
  });
});

describe('replace copy and cost (UC-09, C-02)', () => {
  it('names the scene, the one call, the stale render and the survivors', () => {
    const scene = storyboard.scenes[6] as SceneView;
    expect(replaceConsequence(scene, 17)).toBe(
      "Replacing scene 7's image costs 1 image call. Scene 7's visual and the render become stale. Images 1–6 and 8–17 and the narration survive.",
    );
    expect(replaceButtonLabel()).toBe('Replace image · 1 image call');
  });

  it('says narration survives without listing a range when the scene is the only one', () => {
    const scene = storyboard.scenes[0] as SceneView;
    expect(replaceConsequence(scene, 1)).toBe(
      "Replacing scene 1's image costs 1 image call. Scene 1's visual and the render become stale. The narration survives.",
    );
  });
});

describe('provenance (R-013-1/2)', () => {
  it('lists provider, model, prompt hash, seed, pin and creation time', () => {
    const asset = storyboard.scenes[0]?.asset;
    expect(asset).not.toBeNull();
    const rows = provenanceRows(asset!);
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get('Provider')?.value).toBe('gemini');
    expect(byLabel.get('Model')?.value).toBe('gemini-nano-banana-2.1');
    expect(byLabel.get('Prompt hash')?.value).toBe('prompt-01');
    expect(byLabel.get('Seed')?.value).toBe('1729411200');
    expect(byLabel.get('Series pin')?.value).toBe('v3');
    expect(byLabel.get('Created')?.value).toBe('2026-10-20T09:00:00Z');
  });

  it('names the fields the contract does not carry instead of inventing them', () => {
    const rows = provenanceRows(storyboard.scenes[0]!.asset!);
    const request = rows.find((row) => row.label === 'Provider request id');
    const rights = rows.find((row) => row.label === 'Rights / licence');
    expect(request?.missing).toBe(true);
    expect(rights?.missing).toBe(true);
    expect(request?.value).toBe(PROVENANCE_NOT_RECORDED);
    expect(rights?.value).toBe(PROVENANCE_NOT_RECORDED);
  });
});

describe('storyboard rows (S-11, US-018)', () => {
  it('lists every scene with its span, prompt, protagonist use and camera move', () => {
    const rows = storyboardRows(storyboard);
    expect(rows).toHaveLength(17);
    expect(rows[0]).toMatchObject({
      no: 'S01',
      span: '4.4 s',
      protagonist: 'yes',
      camera: 'zoom in',
      state: 'done',
    });
    expect(rows[0]?.prompt).toBe('Scene 1: the protagonist meets the idea');
  });

  it('reports the storyboard states the panel distinguishes', () => {
    const stage = (state: StageState) => ({
      state,
      attempts: { count: 0, max_attempts: 3, error_class: null },
      blocked_reason: null,
    });
    expect(storyboardState({ storyboard: null, stage: stage('blocked') })).toBe('empty');
    expect(storyboardState({ storyboard: null, stage: stage('running') })).toBe('splitting');
    expect(storyboardState({ storyboard: null, stage: stage('failed') })).toBe('failed');
    expect(storyboardState({ storyboard, stage: stage('done') })).toBe('ready');
  });
});
