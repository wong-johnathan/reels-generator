import { describe, expect, it } from 'vitest';

import { VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderChip } from '../../src/web/render/chip.js';
import { renderStageRail } from '../../src/web/render/stageRail.js';
import { STATE_GLYPH, stateGlyph } from '../../src/web/workspace/glyphs.js';
import {
  chipStateForVideo,
  RAIL_STATE_LABELS,
  railNodes,
  ribbonRuns,
  STATE_LABELS,
  staleSummary,
  type VideoDetail,
} from '../../src/web/workspace/model.js';
import { FEED_RAIL_WORDS, FEED_STATE_WORDS } from '../../src/web/workspace/events.js';
import { STAGE_CODES, STAGE_LABELS, STAGE_STATES } from '../../src/shared/stages.js';
import { byTag, hasClass, parseHtml, textOf, type HtmlNode } from './helpers/html.js';

/**
 * F-04 — UC-03 stage rail, UC-04 chip, UC-05 stale ribbon.
 *
 * The eight states are encoded on four channels (UI_SPEC §3.1): colour,
 * glyph, word and border structure. These tests assert the three channels that
 * survive a screenshot: a word, a glyph, and the data attribute the stylesheet
 * keys its structure off.
 */

const BASE = VideoDetailSchema.parse(FIXTURES['video.get']);

function withStages(overrides: Readonly<Record<string, Record<string, unknown>>>): VideoDetail {
  const clone = structuredClone(BASE) as VideoDetail;
  clone.stages = clone.stages.map((stage) =>
    overrides[stage.stage] === undefined ? stage : { ...stage, ...overrides[stage.stage] },
  );
  return VideoDetailSchema.parse(clone);
}

const nodeFor = (page: HtmlNode, code: string): HtmlNode => {
  const found = byTag(page, 'li').find((node) => node.attrs['data-stage'] === code);
  if (found === undefined) throw new Error('no rail node ' + code);
  return found;
};

describe('UC-03 stage rail — structure', () => {
  it('renders the eleven stage codes in pipeline order', () => {
    const page = parseHtml(renderStageRail(BASE));
    const codes = byTag(page, 'li')
      .map((node) => node.attrs['data-stage'])
      .filter((code): code is string => code !== undefined);
    expect(codes).toEqual([...STAGE_CODES]);
  });

  it('renders a state word and a glyph for every node (AX-13, never colour alone)', () => {
    const page = parseHtml(renderStageRail(BASE));
    for (const code of STAGE_CODES) {
      const node = nodeFor(page, code);
      const word = textOf(node);
      const expected =
        RAIL_STATE_LABELS[node.attrs['data-state'] as keyof typeof RAIL_STATE_LABELS];
      expect(word, code).toContain(expected);
      expect(byTag(node, 'svg').length, code).toBeGreaterThan(0);
    }
  });

  it('marks the current stage with aria-current=step and exactly one tab stop', () => {
    const page = parseHtml(renderStageRail(BASE));
    const links = byTag(page, 'a');
    const current = links.filter((link) => link.attrs['aria-current'] === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]?.attrs['aria-label']).toContain(STAGE_LABELS[BASE.current_stage]);
    expect(links.filter((link) => link.attrs['tabindex'] === '0')).toHaveLength(1);
    expect(links.filter((link) => link.attrs['tabindex'] === '-1')).toHaveLength(10);
  });

  it('shows the series pin each stage started on, and no pin before it starts', () => {
    const page = parseHtml(renderStageRail(BASE));
    expect(textOf(nodeFor(page, 'T'))).toContain('v2');
    expect(textOf(nodeFor(page, 'SB'))).toContain('v3');
    const fresh = withStages({
      SC: { state: 'not_run', series_version: null, series_version_id: null },
    });
    const freshPage = parseHtml(renderStageRail(fresh));
    expect(textOf(nodeFor(freshPage, 'SC'))).not.toContain('v3');
    expect(nodeFor(freshPage, 'SC').attrs['data-state']).toBe('not_run');
  });

  it('names the blocked precondition on the node (R-005-2/3)', () => {
    const page = parseHtml(renderStageRail(BASE));
    const link = byTag(nodeFor(page, 'EX'), 'a')[0];
    expect(link?.attrs['aria-label']).toContain('blocked: final approval required');
    expect(nodeFor(page, 'EX').attrs['data-state']).toBe('blocked');
  });

  it('tags FA and EX as gates, and only those two', () => {
    const page = parseHtml(renderStageRail(BASE));
    const gated = STAGE_CODES.filter((code) =>
      byTag(nodeFor(page, code), 'span').some((span) => textOf(span) === 'gate'),
    );
    expect(gated).toEqual(['FA', 'EX']);
  });

  it('renders the running counter as "11 of 17" with a determinate 2 px bar — never a whole-stage percentage', () => {
    const running = withStages({
      IM: { state: 'running', progress: { current: 11, total: 17 } },
    });
    const page = parseHtml(renderStageRail(running));
    const node = nodeFor(page, 'IM');
    expect(node.attrs['data-progress-text']).toBe('11 of 17');
    expect(node.attrs['data-progress-percent']).toBe('65');
    expect(textOf(node)).toContain('11 of 17');
    const bar = byTag(node, 'span').find((span) => span.attrs['data-bar'] !== undefined);
    expect(bar?.attrs['style']).toContain('--pct:65%');
  });

  it('collapses the word for `awaiting approval` to AWAITING on the rail', () => {
    expect(RAIL_STATE_LABELS.awaiting_approval).toBe('AWAITING');
    expect(STATE_LABELS.awaiting_approval).toBe('AWAITING APPROVAL');
  });
});

describe('UC-05 stale ribbon — one or two nodes are tooltips, three or more get the ribbon', () => {
  it('reports "stale: none" and hides the ribbon when nothing is stale', () => {
    const page = parseHtml(renderStageRail(BASE));
    expect(textOf(page)).toContain('stale: none');
    const ribbon = byTag(page, 'div').find((node) => node.attrs['data-stale-ribbon'] !== undefined);
    expect(ribbon?.attrs['hidden']).toBeDefined();
  });

  it('keeps a single stale stage as a node tooltip, without a ribbon', () => {
    const stale = withStages({ NA: { stale: true, stale_cause: 'script rev 4' } });
    const nodes = railNodes(stale);
    expect(ribbonRuns(nodes)).toHaveLength(0);
    expect(staleSummary(nodes)).toBe('stale: NA');
    const page = parseHtml(renderStageRail(stale));
    expect(nodeFor(page, 'NA').attrs['data-stale']).toBe('true');
    expect(nodeFor(page, 'NA').attrs['data-state']).toBe('stale');
    expect(textOf(nodeFor(page, 'NA'))).toContain('STALE');
    expect(byTag(nodeFor(page, 'NA'), 'a')[0]?.attrs['title']).toContain('was done');
    expect(byTag(nodeFor(page, 'NA'), 'a')[0]?.attrs['title']).toContain('stale: script rev 4');
    const ribbon = byTag(page, 'div').find((node) => node.attrs['data-stale-ribbon'] !== undefined);
    expect(ribbon?.attrs['hidden']).toBeDefined();
  });

  it('merges three consecutive stale stages into the ribbon and names every one', () => {
    const stale = withStages({
      NA: {
        stale: true,
        stale_cause: 'script rev 4, 14:12 UTC',
        stale_at: '2026-10-20T14:12:00.000Z',
      },
      TC: {
        stale: true,
        stale_cause: 'script rev 4, 14:12 UTC',
        stale_at: '2026-10-20T14:12:00.000Z',
      },
      RE: {
        stale: true,
        stale_cause: 'script rev 4, 14:12 UTC',
        stale_at: '2026-10-20T14:12:00.000Z',
      },
    });
    const nodes = railNodes(stale);
    expect(
      ribbonRuns(nodes)
        .flat()
        .map((node) => node.code),
    ).toEqual(['NA', 'TC', 'RE']);
    const page = parseHtml(renderStageRail(stale));
    const ribbon = byTag(page, 'div').find((node) => node.attrs['data-stale-ribbon'] !== undefined);
    expect(ribbon?.attrs['hidden']).toBeUndefined();
    const ribbonText = textOf(ribbon as HtmlNode);
    expect(ribbonText).toContain('NA');
    expect(ribbonText).toContain('TC');
    expect(ribbonText).toContain('RE');
    expect(ribbonText).toContain('stale');
    expect(ribbonText).toContain('script rev 4, 14:12 UTC');
    expect(textOf(page)).toContain('stale: NA, TC, RE');
  });

  it('does not merge three stale stages that are not consecutive', () => {
    const stale = withStages({
      NA: { stale: true },
      TC: { stale: true },
      QC: { stale: true },
    });
    const nodes = railNodes(stale);
    // NA and TC are consecutive but only two; QC is separated by RE.
    expect(ribbonRuns(nodes)).toHaveLength(0);
    expect(staleSummary(nodes)).toBe('stale: NA, TC, QC');
  });

  it('never gates the ribbon text on colour: the word stale is always present', () => {
    const stale = withStages({ NA: { stale: true }, TC: { stale: true }, RE: { stale: true } });
    const page = parseHtml(renderStageRail(stale));
    for (const code of ['NA', 'TC', 'RE']) {
      expect(textOf(nodeFor(page, code)).toLowerCase()).toContain('stale');
    }
  });
});

describe('UC-04 video state chip', () => {
  it('renders the exact uppercase word for the sm size', () => {
    for (const state of STAGE_STATES) {
      const page = parseHtml(renderChip(state));
      expect(textOf(page)).toBe(STATE_LABELS[state]);
      expect(byTag(page, 'svg')).toHaveLength(1);
      expect(page.children[0]?.attrs['data-state']).toBe(state);
    }
  });

  it('uses sentence case at md and lg (UI_SPEC §3.1)', () => {
    expect(textOf(parseHtml(renderChip('awaiting_approval', { size: 'lg' })))).toBe(
      'Awaiting approval',
    );
    expect(textOf(parseHtml(renderChip('blocked', { size: 'md' })))).toBe('Blocked');
  });

  it('gives every state a distinct glyph path (the structure channel)', () => {
    const paths = STAGE_STATES.map((state) => stateGlyph(state));
    expect(new Set(paths).size).toBe(STAGE_STATES.length);
    expect(Object.keys(STATE_GLYPH).sort()).toEqual([...STAGE_STATES].sort());
  });

  it('maps the video state to a chip state, borrowing the stage state for attention', () => {
    expect(chipStateForVideo({ status: 'COMPLETE', stage_state: 'done' })).toBe('done');
    expect(chipStateForVideo({ status: 'RUNNING', stage_state: 'running' })).toBe('running');
    expect(chipStateForVideo({ status: 'NOT_STARTED', stage_state: 'not_run' })).toBe('not_run');
    expect(chipStateForVideo({ status: 'CANCELLED', stage_state: 'cancelled' })).toBe('cancelled');
    expect(chipStateForVideo({ status: 'NEEDS_ATTENTION', stage_state: 'failed' })).toBe('failed');
    expect(chipStateForVideo({ status: 'NEEDS_ATTENTION', stage_state: 'blocked' })).toBe(
      'blocked',
    );
  });
});

describe('SSR and enhancer agree on one word per state (AX-20)', () => {
  it('uses the same state words on both sides of the wire', () => {
    expect(FEED_STATE_WORDS).toEqual(STATE_LABELS);
    expect(FEED_RAIL_WORDS).toEqual(RAIL_STATE_LABELS);
  });

  it('keeps the rail one visual row in the markup (no wrapping list)', () => {
    const page = parseHtml(renderStageRail(BASE));
    const list = byTag(page, 'ol')[0];
    expect(list).toBeDefined();
    expect(hasClass(list as HtmlNode, 'stage-list')).toBe(true);
  });
});
