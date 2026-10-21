import { describe, expect, it } from 'vitest';

import {
  FOCUSABLE_SELECTOR,
  LiveRegion,
  describeFreshness,
  gateAnnouncement,
  isFocusable,
  isTextField,
  nextFocusIndex,
  progressAnnouncement,
  shouldAnnounce,
} from '../../src/web/client/behaviours.js';

/**
 * Shell client behaviour (UI_SPEC §8.5, AX-03, AX-06, AX-08, AX-10, AX-17,
 * AX-27). Pure functions over an injected clock and an injected text target so
 * the announcement budget is testable without a DOM or a real timer.
 */

interface FakeTarget {
  textContent: string;
  readonly writes: string[];
}

function target(): FakeTarget {
  let text = '';
  const writes: string[] = [];
  return {
    writes,
    get textContent(): string {
      return text;
    },
    set textContent(next: string) {
      text = next;
      writes.push(next);
    },
  };
}

describe('polite live region (AX-06, AX-10)', () => {
  it('announces the first message immediately', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('18 of 30 complete. 3 need attention.', 1_000);
    expect(el.textContent).toBe('18 of 30 complete. 3 need attention.');
  });

  it('coalesces a burst to at most one announcement per five seconds, newest wording wins', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('1 of 30 complete.', 0);
    region.announce('2 of 30 complete.', 1_000);
    region.announce('3 of 30 complete.', 2_000);
    expect(el.textContent).toBe('1 of 30 complete.');
    region.poll(4_999);
    expect(el.textContent).toBe('1 of 30 complete.');
    region.poll(5_000);
    expect(el.textContent).toBe('3 of 30 complete.');
  });

  it('never drops the latest state: a pending message flushes at the next allowed slot', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('4 of 30 complete.', 10_000);
    region.announce('5 of 30 complete.', 10_500);
    region.poll(15_000);
    expect(el.textContent).toBe('5 of 30 complete.');
  });

  it('empties itself after ten seconds so a repeated identical message is re-announced', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('Service ready. The database is reachable again.', 0);
    region.poll(9_999);
    expect(el.textContent).not.toBe('');
    region.poll(10_000);
    expect(el.textContent).toBe('');
    region.announce('Service ready. The database is reachable again.', 10_100);
    expect(el.textContent).toBe('Service ready. The database is reachable again.');
  });

  it('ignores an empty message instead of writing whitespace to the region', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('   ', 0);
    expect(el.textContent).toBe('');
    expect(el.writes).toEqual([]);
  });
});

describe('assertive live region (AX-27, §8.5)', () => {
  it('announces urgent messages immediately, bypassing the polite budget', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('Service degraded — database unreachable.', 0, { urgent: true });
    region.announce('Service degraded — database unreachable.', 500, { urgent: true });
    expect(el.writes).toEqual([
      'Service degraded — database unreachable.',
      'Service degraded — database unreachable.',
    ]);
  });

  it('still clears an urgent message after ten seconds', () => {
    const el = target();
    const region = new LiveRegion(el);
    region.announce('Your session expired. Your draft is preserved.', 0, { urgent: true });
    region.poll(10_000);
    expect(el.textContent).toBe('');
  });
});

describe('announcement gating (AX-03, §8.5 rules)', () => {
  it('treats inputs, textareas, selects and contenteditable as text fields', () => {
    expect(isTextField({ tagName: 'INPUT' })).toBe(true);
    expect(isTextField({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextField({ tagName: 'SELECT' })).toBe(true);
    expect(isTextField({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextField({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextField(null)).toBe(false);
  });

  it('suppresses non-operator announcements while focus is in a text field', () => {
    expect(shouldAnnounce({ tagName: 'INPUT' }, false)).toBe(false);
    expect(shouldAnnounce({ tagName: 'INPUT' }, true)).toBe(true);
    expect(shouldAnnounce({ tagName: 'BUTTON' }, false)).toBe(true);
    expect(shouldAnnounce(null, false)).toBe(true);
  });
});

describe('exact announcement templates (AX-08, AX-10, §8.5)', () => {
  it('names the video, the gate and the count when a gate opens', () => {
    expect(gateAnnouncement({ position: 7, total: 30, gate: 'script', attentionCount: 4 })).toBe(
      'Video 7 of 30 needs script approval. 4 videos need attention.',
    );
  });

  it('uses singular wording for a single video', () => {
    expect(gateAnnouncement({ position: 1, total: 1, gate: 'script', attentionCount: 1 })).toBe(
      'Video 1 of 1 needs script approval. 1 video needs attention.',
    );
  });

  it('summarises batch progress as counts only', () => {
    expect(progressAnnouncement({ complete: 18, total: 30, attention: 3 })).toBe(
      '18 of 30 complete. 3 need attention.',
    );
  });
});

describe('feed freshness (AX-27)', () => {
  it.each([
    [0, 'last update 0 s ago', false],
    [1_400, 'last update 1 s ago', false],
    [5_000, 'last update 5 s ago', false],
    [20_000, 'last update 20 s ago', false],
    [20_001, 'progress feed delayed — last update 20 s ago', true],
    [22_000, 'progress feed delayed — last update 22 s ago', true],
  ])('%i ms → %s (stale: %s)', (ageMs, text, stale) => {
    expect(describeFreshness(ageMs)).toEqual({ text, stale });
  });

  it('treats a negative age (clock skew) as zero rather than a negative count', () => {
    expect(describeFreshness(-4_000)).toEqual({ text: 'last update 0 s ago', stale: false });
  });
});

describe('focus management primitives (AX-01, AX-02, AX-09, AX-17)', () => {
  it('wraps focus forward and backward inside a dialog, and starts at the first element', () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 2, true)).toBe(1);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it('returns -1 when there is nothing focusable', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });

  it('excludes disabled controls and tabindex="-1" from the tab cycle', () => {
    expect(isFocusable({ tagName: 'BUTTON' })).toBe(true);
    expect(isFocusable({ tagName: 'BUTTON', disabled: true })).toBe(false);
    expect(isFocusable({ tagName: 'A', hasHref: true })).toBe(true);
    expect(isFocusable({ tagName: 'A', hasHref: false })).toBe(false);
    expect(isFocusable({ tagName: 'DIV', tabIndex: -1 })).toBe(false);
    expect(isFocusable({ tagName: 'DIV', tabIndex: 0 })).toBe(true);
  });

  it('publishes a selector that never matches disabled or tabindex="-1" targets', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
