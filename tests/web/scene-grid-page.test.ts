import { describe, expect, it } from 'vitest';

import { StoryboardViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderSceneGrid } from '../../src/web/render/sceneGrid.js';
import { checkpointState } from '../../src/web/scenes/model.js';
import type { StoryboardView } from '../../src/web/scenes/model.js';
import { byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-12 scene grid — UI_SPEC §5 UC-07/UC-08/UC-10, §6.7 W-06, UX_SPEC W-06,
 * A-15/A-16, R-007-1/2, R-013-1.
 *
 * Signal for F-06: "scene grid shows per-scene state + provenance; first-three
 * checkpoint blocks scenes 4+". The grid never hides a tile and never renders a
 * scene it does not have; a missing row is an explicit not-started tile.
 */

const storyboard = StoryboardViewSchema.parse(FIXTURES['storyboard.get']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);

function board(
  patch: (
    scene: StoryboardView['scenes'][number],
    index: number,
  ) => StoryboardView['scenes'][number],
  base: StoryboardView = storyboard,
): StoryboardView {
  return { ...base, scenes: base.scenes.map((scene, index) => patch(scene, index)) };
}

const firstThree = (): StoryboardView => ({
  ...board((scene, index) =>
    index < 3
      ? { ...scene, state: 'done' as const }
      : { ...scene, asset: null, state: 'not_run' as const },
  ),
  first_three_reviewed: false,
  approved: false,
  approved_at: null,
});

const withImState = (state: string, blockedReason: string | null = null): typeof detail => ({
  ...detail,
  stages: detail.stages.map((stage) =>
    stage.stage === 'IM'
      ? { ...stage, state: state as never, blocked_reason: blockedReason }
      : stage,
  ),
});

const render = (input: {
  storyboard: StoryboardView | null;
  releaseWired?: boolean;
  videoDetail?: typeof detail;
  notice?: string;
}) =>
  parseHtml(
    renderSceneGrid({
      detail: (input.videoDetail ?? detail) as never,
      storyboard: input.storyboard,
      release: { wired: input.releaseWired ?? true },
      ...(input.notice === undefined ? {} : { notice: input.notice }),
    }),
  );

describe('checkpoint header and banner (W-06, A-15)', () => {
  it('states the generated count and the checkpoint copy with the 14-call release', () => {
    const root = render({ storyboard: firstThree() });
    const grid = root.children.find((node) => node.attrs['data-scene-grid'] !== undefined);
    expect(grid?.attrs['data-checkpoint']).toBe('open');
    const text = textOf(root);
    expect(text).toContain('3 of 17 generated · 14 not started');
    expect(text).toContain(
      '3 of 17 generated. Check the protagonist before releasing the remaining 14 (14 image calls).',
    );
    expect(text).toContain('Release remaining 14');
    expect(text).toContain('14 image calls');
    expect(text).toContain('Fix scenes 1–3 first');
  });

  it('renders the checkpoint as a banner above the grid, not a modal', () => {
    const html = renderSceneGrid({
      detail: detail as never,
      storyboard: firstThree(),
      release: { wired: true },
    });
    expect(html).toContain('data-checkpoint-banner="open"');
    const banner = html.indexOf('data-checkpoint-banner');
    const tiles = html.indexOf('data-scene-tiles');
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(tiles);
  });

  it('renders 17 tiles and marks scenes 4+ as held by the checkpoint', () => {
    const root = render({ storyboard: firstThree() });
    const tiles = byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined);
    expect(tiles).toHaveLength(17);
    expect(tiles[0]?.attrs['data-blocked']).toBeUndefined();
    expect(tiles[2]?.attrs['data-blocked']).toBeUndefined();
    expect(tiles[3]?.attrs['data-blocked']).toBe('checkpoint');
    expect(tiles[16]?.attrs['data-blocked']).toBe('checkpoint');
  });

  it('keeps every not-started tile in the DOM with its scene id and span', () => {
    const root = render({ storyboard: firstThree() });
    const tiles = byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined);
    expect(tiles[3]?.attrs['data-scene-no']).toBe('S04');
    expect(textOf(tiles[3]!)).toContain('S04');
    expect(textOf(tiles[3]!)).toContain('4.4 s');
    expect(textOf(tiles[3]!)).toContain('NOT RUN');
  });

  it('disables release with a visible reason when no backend route is wired', () => {
    const root = render({ storyboard: firstThree(), releaseWired: false });
    const release =
      root.children.find((node) => node.attrs['data-release'] !== undefined) ??
      byTag(root, 'button').find((node) => node.attrs['data-release'] !== undefined);
    expect(release).toBeDefined();
    expect(release?.attrs['disabled']).toBeDefined();
    const describedBy = release?.attrs['aria-describedby'];
    expect(describedBy).toBeDefined();
    expect(textOf(root)).toContain('Release is not wired');
  });

  it('posts the release with the storyboard revision when it is wired', () => {
    const html = renderSceneGrid({
      detail: detail as never,
      storyboard: firstThree(),
      release: { wired: true },
    });
    expect(html).toContain('/scenes/release-checkpoint');
    expect(html).toContain('name="revision" value="2"');
    expect(html).not.toContain('Release is not wired');
  });

  it('says so when the series has no recurring character', () => {
    const noProtagonist = {
      ...board((scene) => ({ ...scene, uses_protagonist: false })),
      first_three_reviewed: false,
    };
    const text = textOf(render({ storyboard: noProtagonist }));
    expect(text).toContain(
      'Protagonist checkpoint not applicable — this series has no recurring character.',
    );
    expect(text).not.toContain('Check the protagonist before releasing');
  });
});

describe('tiles (UC-08)', () => {
  it('shows state chip, pin tag, scene id and narration span on a ready tile', () => {
    const root = render({ storyboard });
    const tile = byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined)[2];
    expect(tile?.attrs['data-scene-no']).toBe('S03');
    expect(textOf(tile!)).toContain('DONE');
    expect(textOf(tile!)).toContain('v3');
    expect(textOf(tile!)).toContain('S03');
    expect(textOf(tile!)).toContain('4.4 s');
  });

  it('gives the thumbnail an alt of the prompt summary and no prompt text in the tile', () => {
    const root = render({ storyboard });
    const tile = byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined)[0];
    const image = byTag(tile!, 'img')[0];
    expect(image?.attrs['alt']).toBe('Scene 1: the protagonist meets the idea');
    expect(image?.attrs['width']).toBe('168');
    expect(image?.attrs['height']).toBe('298');
    expect(textOf(tile!)).not.toContain('Scene 1: the protagonist meets the idea');
  });

  it('names the tile for assistive tech with position, state, narration and pin', () => {
    const root = render({ storyboard });
    const tile = byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined)[2];
    expect(tile?.attrs['aria-label']).toBe(
      'Scene 3 of 17, S03, done, 4.4 second narration, pin v3',
    );
  });

  it('keeps every tile reachable without JavaScript; the enhancer adds the roving tabindex', () => {
    const root = render({ storyboard });
    const tiles = byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined);
    for (const tile of tiles) expect(tile.attrs['tabindex']).toBeUndefined();
    expect(tiles[0]?.attrs['aria-selected']).toBe('false');
  });
});

describe('selection bar (UC-07, UC-10)', () => {
  it('renders read-only pager and list from the same scene facts (AX-15/22)', () => {
    const root = render({ storyboard });
    for (const surface of ['scene-pager', 'scene-list']) {
      const region = byTag(root, surface === 'scene-pager' ? 'section' : 'ul').find(
        (node) => node.attrs['class'] === surface,
      );
      expect(region).toBeDefined();
      const rows = byTag(region!, 'a');
      expect(rows).toHaveLength(17);
      expect(rows[2]?.attrs['aria-label']).toBe(
        'Scene 3 of 17, S03, done, 4.4 second narration, pin v3',
      );
      expect(byTag(rows[2]!, 'img')[0]?.attrs['alt']).toBe(storyboard.scenes[2]?.image_prompt);
      expect(textOf(rows[2]!)).toContain('DONE');
      expect(textOf(rows[2]!)).toContain('v3');
      expect(textOf(rows[2]!)).toContain('4.4 s');
      expect(textOf(region!)).not.toMatch(/Replace image|Reorder|Release remaining/);
      expect(
        byTag(region!, 'button').every((node) => node.attrs['data-pager-step'] !== undefined),
      ).toBe(true);
    }
    expect(textOf(root)).toContain('Open at 1024 px or wider to replace a scene image.');
  });

  it('names the replace cost and the free reorder before anything is selected', () => {
    const text = textOf(render({ storyboard }));
    expect(text).toContain('replace 1 image call');
    expect(text).toContain('reorder 0 calls');
    expect(text).toContain('Replace image');
  });

  it('explains that reorder is Milestone B rather than offering a dead control', () => {
    const root = render({ storyboard });
    const up = byTag(root, 'button').find((node) => node.attrs['data-reorder'] === 'up');
    expect(up?.attrs['disabled']).toBeDefined();
    expect(textOf(root)).toContain('Reorder ships in Milestone B');
  });
});

describe('grid states (W-06 states row)', () => {
  it('preserves failed/running/stale and missing images on both narrow surfaces', () => {
    const root = render({
      storyboard: board((scene, index) => ({
        ...scene,
        asset: index === 0 ? null : scene.asset,
        state: index === 0 ? 'failed' : index === 1 ? 'running' : 'stale',
      })),
    });
    for (const surface of ['pager', 'list']) {
      const rows = byTag(root, 'a').filter(
        (node) => node.attrs['data-scene-' + surface] !== undefined,
      );
      expect(rows[0]?.attrs['data-state']).toBe('failed');
      expect(byTag(rows[0]!, 'img')).toHaveLength(0);
      expect(textOf(rows[0]!)).toContain('FAILED');
      expect(rows[1]?.attrs['data-state']).toBe('running');
      expect(rows[2]?.attrs['data-state']).toBe('stale');
    }
  });

  it('renders an honest empty state before script approval', () => {
    const root = render({
      storyboard: null,
      videoDetail: withImState('blocked', 'script not approved'),
    });
    const grid = root.children.find((node) => node.attrs['data-scene-grid'] !== undefined);
    expect(grid?.attrs['data-checkpoint']).toBe('blocked');
    const text = textOf(root);
    expect(text).toContain('0 of 17 generated. Images are blocked until the script is approved.');
    expect(text).toContain('script not approved');
    expect(
      renderSceneGrid({
        detail: withImState('blocked', 'script not approved') as never,
        storyboard: null,
        release: { wired: true },
      }),
    ).toContain('/script');
    expect(
      byTag(root, 'a').filter((node) => node.attrs['data-scene-tile'] !== undefined),
    ).toHaveLength(0);
  });

  it('treats a rate limit as benign waiting, not an error', () => {
    const text = textOf(
      render({
        storyboard,
        videoDetail: withImState('running', 'waiting: rate limit'),
      }),
    );
    expect(text).toContain('waiting: rate limit');
    expect(text.toLowerCase()).not.toContain('error');
  });

  it('keeps the last images and names the provider problem when a stage is blocked', () => {
    const text = textOf(
      render({
        storyboard,
        videoDetail: withImState('blocked', 'provider down'),
      }),
    );
    expect(text).toContain('provider down');
    expect(text).toContain('17 of 17 generated');
  });

  it('shows a success banner after a committed replace', () => {
    const text = textOf(render({ storyboard, notice: 'Replacement queued for scene 7.' }));
    expect(text).toContain('Replacement queued for scene 7.');
  });
});

describe('checkpoint derivation parity', () => {
  it('uses the same checkpoint state the model computes', () => {
    expect(checkpointState({ storyboard: firstThree(), blockedReason: null }).kind).toBe('open');
  });
});
