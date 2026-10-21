import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * Workspace surfaces — UI_SPEC §3 (the eight-state palette), §5 UC-02/UC-03/
 * UC-04/UC-05, §6.2/§6.5 geometry and §7 bands.
 *
 * The structural channel is the one a screenshot, a greyscale print and a
 * colour-blind operator share (UI_SPEC §3.2), so it is asserted here rather
 * than left to review: dashed + hatch for stale, a heavy left edge for failed,
 * a double border for blocked, a right-hand notch for awaiting approval.
 */

const css = readFileSync(new URL('../../src/web/styles/workspace.css', import.meta.url), 'utf8');

describe('UC-04 chip geometry (UI_SPEC §3.1, §5 UC-04)', () => {
  it('is 20 px by default and 24/28 px at md/lg', () => {
    expect(extractBlock(css, '.vchip')).toMatch(/height:\s*20px/);
    expect(extractBlock(css, ".vchip[data-size='md']")).toMatch(/height:\s*24px/);
    expect(extractBlock(css, ".vchip[data-size='lg']")).toMatch(/height:\s*28px/);
  });

  it('uses 2 px radius, 6 px padding, an 11 px uppercase sm word and sentence case at md/lg', () => {
    const chip = extractBlock(css, '.vchip');
    expect(chip).toMatch(/border-radius:\s*var\(--r-1\)/);
    expect(chip).toMatch(/padding:\s*0 var\(--s-3\)/);
    expect(chip).toMatch(/font-size:\s*var\(--t-10\)/);
    expect(chip).toMatch(/text-transform:\s*uppercase/);
    expect(extractBlock(css, ".vchip[data-size='md']")).toMatch(/text-transform:\s*none/);
    expect(extractBlock(css, ".vchip[data-size='lg']")).toMatch(/text-transform:\s*none/);
  });

  it('gives every state a distinct structure, not just a hue (§3.2)', () => {
    const stale = extractBlock(css, ".vchip[data-state='stale']");
    expect(stale).toMatch(/border:\s*1px dashed var\(--stale\)/);
    expect(stale).toMatch(/repeating-linear-gradient\(\s*135deg/);

    const failed = extractBlock(css, ".vchip[data-state='failed']");
    expect(failed).toMatch(/border-left-width:\s*4px/);
    expect(failed).toMatch(/background:\s*var\(--surface-danger-tint\)/);

    const blocked = extractBlock(css, ".vchip[data-state='blocked']");
    expect(blocked).toMatch(/border:\s*3px double var\(--warning\)/);

    const awaiting = extractBlock(css, ".vchip[data-state='awaiting_approval']");
    expect(awaiting).toMatch(/border-right-width:\s*3px/);

    const cancelled = extractBlock(css, ".vchip[data-state='cancelled'] .vchip-label");
    expect(cancelled).toMatch(/text-decoration:\s*line-through/);

    expect(extractBlock(css, ".vchip[data-state='done']")).toMatch(
      /background:\s*rgba\(76, 194, 106, 0\.1\)/,
    );
    expect(extractBlock(css, ".vchip[data-state='running']")).toMatch(
      /background:\s*rgba\(79, 209, 224, 0\.08\)/,
    );
  });
});

describe('UC-03 stage rail geometry (UI_SPEC §5 UC-03, §6.5)', () => {
  it('is a 56 px row of eleven flexing nodes with 74 px minimum and hairline dividers', () => {
    expect(extractBlock(css, '.stage-link')).toMatch(/height:\s*56px/);
    const node = extractBlock(css, '.stage-node');
    expect(node).toMatch(/flex:\s*1 1 0/);
    expect(node).toMatch(/min-width:\s*74px/);
    expect(node).toMatch(/border-right:\s*1px solid var\(--border-subtle\)/);
    expect(extractBlock(css, '.stage-code')).toMatch(/font-size:\s*var\(--t-20\)/);
    expect(extractBlock(css, '.stage-state')).toMatch(/font-size:\s*var\(--t-10\)/);
    expect(extractBlock(css, '.stage-pin')).toMatch(/font-size:\s*var\(--t-10\)/);
  });

  it('marks the current node with the selected surface and a 2 px accent edge', () => {
    const current = extractBlock(css, ".stage-node[data-current='true'] .stage-link");
    expect(current).toMatch(/background:\s*var\(--surface-selected\)/);
    expect(current).toMatch(/box-shadow:\s*inset 0 -2px 0 var\(--accent\)/);
  });

  it('shows the running bar as a 2 px determinate fill, never a whole-stage percentage', () => {
    expect(extractBlock(css, '.stage-progress')).toMatch(/height:\s*2px/);
    const bar = extractBlock(css, '.stage-bar');
    expect(bar).toMatch(/width:\s*var\(--pct,\s*0%\)/);
    expect(bar).toMatch(/height:\s*2px/);
    expect(bar).toMatch(/background:\s*var\(--running\)/);
  });

  it('gives the stale node the hatch and the failed node a tint, with the word doing the talking', () => {
    expect(extractBlock(css, ".stage-node[data-state='stale'] .stage-link")).toMatch(
      /repeating-linear-gradient/,
    );
    expect(extractBlock(css, ".stage-node[data-state='stale'] .stage-state")).toMatch(
      /color:\s*var\(--stale\)/,
    );
    expect(extractBlock(css, ".stage-node[data-state='failed'] .stage-link")).toMatch(
      /background:\s*rgba\(255, 123, 114, 0\.08\)/,
    );
    expect(extractBlock(css, '.stage-gate')).toMatch(/font-size:\s*9px/);
  });
});

describe('UC-05 stale ribbon (UI_SPEC §5 UC-05)', () => {
  it('is a 28 px strip beneath the rail on the stale tint with a dashed rule', () => {
    const ribbon = extractBlock(css, '.stale-ribbon');
    expect(ribbon).toMatch(/min-height:\s*28px/);
    expect(ribbon).toMatch(/background:\s*var\(--surface-stale-tint\)/);
    expect(ribbon).toMatch(/border-top:\s*1px dashed var\(--stale\)/);
    expect(ribbon).toMatch(/color:\s*var\(--stale\)/);
    expect(extractBlock(css, '.stale-ribbon-list')).toMatch(/font-family:\s*var\(--font-mono\)/);
  });
});

describe('UC-02 tabs and the workspace panel (UI_SPEC §5 UC-02, §6.5)', () => {
  it('is a 34 px tab row with a 2 px accent underline on the selected tab', () => {
    expect(extractBlock(css, '.workspace-tab')).toMatch(/height:\s*34px/);
    expect(extractBlock(css, ".workspace-tab[aria-selected='true']")).toMatch(
      /border-bottom-color:\s*var\(--accent\)/,
    );
    expect(extractBlock(css, '.workspace-tab')).toMatch(/border-bottom:\s*2px solid transparent/);
  });

  it('keeps every tab reachable by scrolling, never by wrapping or hiding', () => {
    expect(extractBlock(css, '.workspace-tablist')).toMatch(/overflow-x:\s*auto/);
    expect(extractBlock(css, '.workspace-tab')).toMatch(/white-space:\s*nowrap/);
  });
});

describe('S-02 attention queue (UI_SPEC §6.2)', () => {
  it('uses 48 px rows, a 12 px gap and the panel surface for each card', () => {
    const row = extractBlock(css, '.attention-row');
    expect(row).toMatch(/min-height:\s*var\(--s-11\)/);
    expect(row).toMatch(/gap:\s*var\(--s-5\)/);
    expect(extractBlock(css, '.attention-card')).toMatch(/background:\s*var\(--surface-panel\)/);
    expect(extractBlock(css, '.attention-card')).toMatch(/border-radius:\s*var\(--r-3\)/);
  });

  it('encodes a row state with a left bar as well as the reason text (§3.1)', () => {
    expect(extractBlock(css, ".attention-row[data-stage-state='failed']")).toMatch(
      /box-shadow:\s*inset 3px 0 0 var\(--danger\)/,
    );
    expect(extractBlock(css, ".attention-row[data-stage-state='blocked']")).toMatch(
      /box-shadow:\s*inset 3px 0 0 var\(--warning\)/,
    );
    expect(extractBlock(css, ".attention-row[data-stage-state='stale']")).toMatch(
      /box-shadow:\s*inset 3px 0 0 var\(--stale\)/,
    );
  });

  it('keeps the row action at the 24 px minimum target (AX-17)', () => {
    expect(extractBlock(css, '.attention-open')).toMatch(/min-height:\s*var\(--target-min\)/);
  });
});

describe('responsive bands (UI_SPEC §7.1/§7.2)', () => {
  it('compacts the rail to 44 px nodes and scrolls it, never wrapping, below 1024 px', () => {
    const compact = mediaBlocks(css).find((block) => block.query === '(max-width: 1023px)');
    expect(compact).toBeDefined();
    expect(compact?.body).toMatch(/\.stage-list\s*{[^}]*overflow-x:\s*auto/s);
    expect(compact?.body).toMatch(/\.stage-node\s*{[^}]*flex:\s*0 0 44px/s);
    expect(compact?.body).toMatch(/\.stage-node\s*{[^}]*min-width:\s*44px/s);
    // The state word moves into the accessible name rather than disappearing.
    expect(compact?.body).toMatch(/\.stage-state-word\s*{[^}]*clip-path:\s*inset\(50%\)/s);
  });

  it('stacks the attention rows below 768 px so nothing scrolls sideways (AX-14)', () => {
    const monitor = mediaBlocks(css).find((block) => block.query === '(max-width: 767px)');
    expect(monitor).toBeDefined();
    expect(monitor?.body).toMatch(
      /\.attention-row\s*{[^}]*grid-template-columns:\s*var\(--s-11\) minmax\(0, 1fr\)/s,
    );
  });
});

describe('token discipline', () => {
  it('declares no raw hex colour — every value comes from tokens.css', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('uses no zebra striping and no page-level horizontal scroll', () => {
    expect(css).not.toMatch(/nth-child\((odd|even)\)/);
    expect(css).not.toMatch(/body\s*{[^}]*overflow-x/s);
  });
});
