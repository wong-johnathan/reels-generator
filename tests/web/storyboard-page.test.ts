import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { StoryboardViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderStoryboard } from '../../src/web/render/storyboard.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-11 storyboard — UX_SPEC §6 S-11, W-06; US-018; R-009-2, R-004-1, R-013-1.
 *
 * The panel is server-rendered: the scene count against target, every scene's
 * narration span, prompt and protagonist reference are decided here. The
 * optional storyboard gate is a plain form; nothing on this page spends a
 * provider call.
 */

const storyboard = StoryboardViewSchema.parse(FIXTURES['storyboard.get']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']) as unknown as VideoDetail;

type Detail = z.infer<typeof VideoDetailSchema>;

function withStage(state: string, overrides: Partial<Detail['stages'][number]> = {}): VideoDetail {
  return {
    ...detail,
    stages: detail.stages.map((stage) =>
      stage.stage === 'SB' ? { ...stage, state: state as never, ...overrides } : stage,
    ),
  } as unknown as VideoDetail;
}

const page = (board: typeof storyboard | null, videoDetail: VideoDetail = detail) =>
  parseHtml(renderStoryboard({ detail: videoDetail, storyboard: board }));

describe('storyboard ready (US-018)', () => {
  it('states the scene count against the target', () => {
    const html = renderStoryboard({ detail, storyboard });
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('17 scenes · target 17');
  });

  it('lists all 17 scenes with span, prompt, protagonist use and camera move', () => {
    const root = page(storyboard);
    const rows = byTag(root, 'tr').filter((row) => row.attrs['data-scene-no'] !== undefined);
    expect(rows).toHaveLength(17);
    const first = rows[0];
    expect(first?.attrs['data-scene-no']).toBe('S01');
    const text = textOf(first!);
    expect(text).toContain('S01');
    expect(text).toContain('4.4 s');
    expect(text).toContain('Scene 1: the protagonist meets the idea');
    expect(text).toContain('yes');
    expect(text).toContain('zoom in');
    expect(text).toContain('DONE');
  });

  it('carries a state chip with the word, not just a colour, on every row', () => {
    const root = page(storyboard);
    const table = byTag(root, 'table')[0];
    const chips = byTag(table!, 'span').filter((node) => node.attrs['class'] === 'vchip');
    expect(chips.length).toBe(17);
    for (const chip of chips) {
      expect(textOf(chip)).toBe('DONE');
      expect(chip.attrs['data-state']).toBe('done');
    }
  });

  it('links each scene to its S-13 detail', () => {
    const root = page(storyboard);
    const links = byTag(root, 'a').filter((node) => node.attrs['data-scene-link'] !== undefined);
    expect(links).toHaveLength(17);
    expect(links[0]?.attrs['href']).toContain('/videos/');
    expect(links[0]?.attrs['href']).toContain('/scenes/');
  });

  it('gives the table a caption and column headers for screen readers', () => {
    const root = page(storyboard);
    const table = byTag(root, 'table')[0];
    expect(table).toBeDefined();
    expect(byTag(table!, 'caption')[0]?.children[0]).toBeDefined();
    const headers = byTag(table!, 'th').map((node) => textOf(node));
    expect(headers).toEqual(['Scene', 'Narration', 'Prompt', 'Protagonist', 'Camera', 'State']);
  });
});

describe('optional storyboard gate (UX_SPEC S-11 primary action)', () => {
  it('offers an approve form while the storyboard is unapproved', () => {
    const unapproved = { ...storyboard, approved: false, approved_at: null };
    const html = renderStoryboard({ detail, storyboard: unapproved });
    expect(html).toContain('method="post"');
    expect(html).toContain('/storyboard/approve');
    expect(html).toContain('name="revision" value="2"');
    expect(html).toContain('Approve storyboard');
    expect(html).toContain('optional gate');
  });

  it('replaces the control with the record line once approved', () => {
    const html = renderStoryboard({ detail, storyboard });
    expect(html).not.toContain('/storyboard/approve');
    expect(html).toContain('Approved rev 2');
    expect(html).toContain('2026-10-20T09:41:12Z');
  });
});

describe('storyboard states (UX_SPEC S-11 row)', () => {
  it('says there is no storyboard yet before the script is approved', () => {
    const html = renderStoryboard({
      detail: withStage('blocked', { blocked_reason: 'script not approved' }),
      storyboard: null,
    });
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('No storyboard yet. Approve the script first.');
    expect(html).toContain('/script');
    expect(html).not.toContain('<table');
  });

  it('shows the split in progress without inventing spans', () => {
    const html = renderStoryboard({ detail: withStage('running'), storyboard: null });
    expect(html).toContain('data-state="splitting"');
    expect(html).toContain('Splitting the script into scenes');
    expect(html).toContain('narration spans appear when the split completes');
  });

  it('states the attempt count when the split failed', () => {
    const html = renderStoryboard({
      detail: withStage('failed', {
        attempts: { count: 3, max_attempts: 3, last_error_class: 'transient' },
      }),
      storyboard: null,
    });
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('after 3 attempts');
    expect(html).toContain('transient');
  });
});
