import { describe, expect, it } from 'vitest';

import { StoryboardViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderSceneDetail } from '../../src/web/render/sceneDetail.js';
import { PROVENANCE_NOT_RECORDED, replaceConsequence } from '../../src/web/scenes/model.js';
import type { SceneView } from '../../src/web/scenes/model.js';
import { byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-13 scene detail — UI_SPEC §5 UC-09, §6.7; UX_SPEC S-13 row, A-17;
 * R-007-1, R-013-1/2, US-019/US-020.
 *
 * One scene: its image, prompt, narration span, provenance and the single-call
 * replace. The consequence sentence is C-02 verbatim and the replace button is
 * never the initial focus (AX-04).
 */

const storyboard = StoryboardViewSchema.parse(FIXTURES['storyboard.get']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);
const scene = storyboard.scenes[6] as SceneView;

const render = (input: { scene?: SceneView; replaceBlocked?: string | null; notice?: string }) => {
  const html = renderSceneDetail({
    detail: detail as never,
    scene: input.scene ?? scene,
    total: 17,
    replace: {
      wired: (input.replaceBlocked ?? null) === null,
      blockedReason: input.replaceBlocked ?? null,
    },
    ...(input.notice === undefined ? {} : { notice: input.notice }),
  });
  return { html, root: parseHtml(html) };
};

describe('scene detail content (US-019)', () => {
  it('names the scene by id and position', () => {
    const { html } = render({});
    expect(html).toContain('data-scene-detail');
    expect(html).toContain('S07');
    expect(html).toContain('scene 7 of 17');
  });

  it('renders the current image with the prompt summary as its alt text', () => {
    const { root } = render({});
    const image = byTag(root, 'img')[0];
    expect(image?.attrs['alt']).toBe('Scene 7: the protagonist meets the idea');
    expect(image?.attrs['width']).toBe('360');
    expect(image?.attrs['height']).toBe('640');
    expect(image?.attrs['src']).toBe('/asset/99999999-9999-4999-8999-111111111111/detail');
  });

  it('shows the prompt verbatim and the narration span', () => {
    const text = textOf(render({}).root);
    expect(text).toContain('Scene 7: the protagonist meets the idea');
    expect(text).toContain('4.4 s');
    expect(text).toContain('4.4 seconds');
  });

  it('renders the provenance table with model, seed, prompt hash and pin', () => {
    const { root } = render({});
    const provenance = byTag(root, 'section').find(
      (node) => node.attrs['data-provenance'] !== undefined,
    );
    expect(provenance).toBeDefined();
    const text = textOf(provenance!);
    expect(text).toContain('Provider');
    expect(text).toContain('gemini');
    expect(text).toContain('gemini-nano-banana-2.1');
    expect(text).toContain('prompt-07');
    expect(text).toContain('1729411200');
    expect(text).toContain('v3');
    expect(text).toContain('2026-10-20T09:00:00Z');
  });

  it('names the provenance fields the contract does not carry', () => {
    const text = textOf(render({}).root);
    expect(text).toContain('Provider request id');
    expect(text).toContain('Rights / licence');
    expect(text).toContain(PROVENANCE_NOT_RECORDED);
    expect(text).toContain('previous attempts are not exposed');
  });

  it('states the image stage attempt count from the video detail', () => {
    const text = textOf(render({}).root);
    expect(text).toContain('attempt 1 of 3');
  });
});

describe('replace image (UC-09, R-007-1, C-02)', () => {
  it('states the C-02 consequence verbatim before the control', () => {
    const { html, root } = render({});
    expect(textOf(root)).toContain(replaceConsequence(scene, 17));
    expect(html.indexOf('Replacing scene 7')).toBeLessThan(
      html.indexOf('Replace image · 1 image call'),
    );
  });

  it('posts the scene revision and the prefilled prompt', () => {
    const { html } = render({});
    expect(html).toContain('method="post"');
    expect(html).toContain('/replace-image');
    expect(html).toContain('name="revision" value="1"');
    expect(html).toContain('name="image_prompt"');
    expect(html).toContain('Scene 7: the protagonist meets the idea');
  });

  it('never autofocuses the spending control (AX-04)', () => {
    const { html } = render({});
    expect(html).not.toContain('autofocus');
  });

  it('is disabled with the checkpoint reason while scenes 4+ wait', () => {
    const blocked = render({
      replaceBlocked: 'Scene 7 waits for the first-three checkpoint release.',
    });
    const button = byTag(blocked.root, 'button').find(
      (node) => node.attrs['data-replace'] !== undefined,
    );
    expect(button?.attrs['disabled']).toBeDefined();
    expect(button?.attrs['aria-describedby']).toBeDefined();
    expect(blocked.html).toContain('Scene 7 waits for the first-three checkpoint release.');
  });

  it('shows the queue confirmation after a committed replace', () => {
    const text = textOf(render({ notice: 'Replacement queued: scene 7 · 1 image call.' }).root);
    expect(text).toContain('Replacement queued: scene 7 · 1 image call.');
  });
});

describe('scene without an image (W-06 tile states)', () => {
  const notStarted: SceneView = { ...scene, asset: null, state: 'not_run' };

  it('keeps the fixed 9:16 box and names the state instead of a broken image', () => {
    const { root } = render({ scene: notStarted });
    expect(byTag(root, 'img')).toHaveLength(0);
    const text = textOf(root);
    expect(text).toContain('No image yet');
    expect(text).toContain('NOT RUN');
  });

  it('offers no replace until an image exists', () => {
    const { root } = render({ scene: notStarted });
    expect(
      byTag(root, 'button').find((node) => node.attrs['data-replace'] !== undefined),
    ).toBeUndefined();
    expect(textOf(root)).toContain('Replace needs a stored image');
  });

  it('names a failed scene attempt against its maximum', () => {
    const failed: SceneView = { ...scene, asset: null, state: 'failed' };
    const text = textOf(render({ scene: failed }).root);
    expect(text).toContain('FAILED');
    expect(text).toContain('attempt 1 of 3');
  });
});
