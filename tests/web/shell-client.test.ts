import { afterEach, describe, expect, it } from 'vitest';

import { initShell, type ElementLike, type ShellDocumentLike } from '../../src/web/client/shell.js';

/**
 * Shell enhancement wiring: freshness label (AX-27) and the two live regions
 * (§8.5). A fake document keeps this test free of a browser and of real timers;
 * the rules themselves are covered in client.test.ts.
 */

interface FakeElement extends ElementLike {
  readonly attrs: Map<string, string>;
}

function element(attrs: Record<string, string> = {}): FakeElement {
  const map = new Map(Object.entries(attrs));
  return {
    textContent: '',
    attrs: map,
    getAttribute(name: string): string | null {
      return map.get(name) ?? null;
    },
    setAttribute(name: string, value: string): void {
      map.set(name, value);
    },
  };
}

interface FakeDocument extends ShellDocumentLike {
  activeElement: { tagName?: string; isContentEditable?: boolean } | null;
}

function fakeDocument(options: { updatedAt?: number; active?: { tagName?: string } | null }): {
  doc: FakeDocument;
  freshness: FakeElement;
  status: FakeElement;
  alert: FakeElement;
} {
  const freshness = element(
    options.updatedAt === undefined ? {} : { 'data-updated-at': String(options.updatedAt) },
  );
  const status = element();
  const alert = element();
  const bySelector: Record<string, FakeElement> = {
    '[data-updated-at]': freshness,
    '#live-status': status,
    '#live-alert': alert,
  };
  const doc: FakeDocument = {
    activeElement: options.active ?? null,
    querySelector(selector: string): ElementLike | null {
      return bySelector[selector] ?? null;
    },
  };
  return { doc, freshness, status, alert };
}

afterEach(() => {
  delete (globalThis as { reelsAnnounce?: unknown }).reelsAnnounce;
});

describe('initShell', () => {
  it('returns null when the shell markup is absent', () => {
    const doc: ShellDocumentLike = { querySelector: () => null };
    expect(initShell(doc, { now: () => 0 })).toBeNull();
  });

  it('exposes the announcement surface for later surfaces', () => {
    const { doc, status, alert } = fakeDocument({});
    const enhancer = initShell(doc, { now: () => 0 });
    expect(enhancer).not.toBeNull();
    enhancer?.announceStatus('18 of 30 complete. 3 need attention.');
    expect(status.textContent).toBe('18 of 30 complete. 3 need attention.');
    enhancer?.announceAlert('Service degraded — database unreachable.');
    expect(alert.textContent).toBe('Service degraded — database unreachable.');
    expect((globalThis as { reelsAnnounce?: unknown }).reelsAnnounce).toBe(enhancer);
  });

  it('keeps component background updates quiet while the operator types (AX-03)', () => {
    const { doc, status } = fakeDocument({ active: { tagName: 'INPUT' } });
    const enhancer = initShell(doc, { now: () => 0 });
    enhancer?.announceStatus('18 of 30 complete. 3 need attention.');
    expect(status.textContent).toBe('');
    enhancer?.announceStatus('18 of 30 complete. 3 need attention.', true);
    expect(status.textContent).toBe('18 of 30 complete. 3 need attention.');
  });

  it('recomputes the freshness label and the stalled flag from the update time', () => {
    const { doc, freshness } = fakeDocument({ updatedAt: 1_000 });
    const enhancer = initShell(doc, { now: () => 3_000 });
    expect(freshness.textContent).toBe('last update 2 s ago');
    expect(freshness.attrs.get('data-stale')).toBe('false');

    enhancer?.tick(23_000);
    expect(freshness.textContent).toBe('progress feed delayed — last update 22 s ago');
    expect(freshness.attrs.get('data-stale')).toBe('true');
  });

  it('flushes a coalesced polite message on a later tick', () => {
    const { doc, status } = fakeDocument({});
    let now = 0;
    const enhancer = initShell(doc, { now: () => now });
    enhancer?.announceStatus('1 of 30 complete. 3 need attention.');
    enhancer?.announceStatus('2 of 30 complete. 3 need attention.');
    expect(status.textContent).toBe('1 of 30 complete. 3 need attention.');
    now = 5_000;
    enhancer?.tick(now);
    expect(status.textContent).toBe('2 of 30 complete. 3 need attention.');
  });

  it('schedules exactly one freshness tick per second through the environment', () => {
    const { doc } = fakeDocument({});
    let calls = 0;
    const enhancer = initShell(doc, {
      now: () => 0,
      setInterval: () => {
        calls += 1;
        return 0;
      },
    });
    expect(enhancer).not.toBeNull();
    expect(calls).toBe(1);
  });
});
