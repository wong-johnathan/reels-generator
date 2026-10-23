import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

const css = readFileSync(new URL('../../src/web/styles/shell.css', import.meta.url), 'utf8');

describe('AX-17 shell navigation targets', () => {
  it.each(['.status-cause', '.rail-signout-button'])(
    'gives %s a centred 24 px minimum target, not a review-control size',
    (selector) => {
      const block = extractBlock(css, selector);
      expect(block).toContain('display: inline-flex');
      expect(block).toContain('align-items: center');
      expect(block).toContain('min-height: var(--target-min)');
      expect(block).toContain('min-width: var(--target-min)');
      expect(block).not.toContain('var(--target-review)');
    },
  );

  it('preserves the hidden status cause and rail below 1024', () => {
    const narrow = mediaBlocks(css).find((block) => block.query === '(max-width: 1023px)');
    expect(extractBlock(narrow?.body ?? '', '.status-cause')).toContain('display: none');
    expect(extractBlock(narrow?.body ?? '', '.rail')).toContain('display: none');
  });
});
