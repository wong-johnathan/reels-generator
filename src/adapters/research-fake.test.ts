import { describe, expect, it } from 'vitest';

import { FakeResearchAdapter, fakeSource } from './research-fake.js';
import { partitionSources } from './research.js';

const run = { id: 'run-fixture-1', stage: 'RS' } as const;

describe('FakeResearchAdapter determinism (TECH_DESIGN §12: providers are never called in tests)', () => {
  it('returns the same sources for the same query across calls and instances', async () => {
    const a = new FakeResearchAdapter();
    const b = new FakeResearchAdapter();

    const first = await a.search({ query: 'singapore chewing gum ban' }, run);
    const second = await a.search({ query: 'singapore chewing gum ban' }, run);
    const third = await b.search({ query: 'singapore chewing gum ban' }, run);

    expect(first.results).toEqual(second.results);
    expect(first.results).toEqual(third.results);
    expect(first.results).toHaveLength(5);
    expect(first.provider_request_id).toBe('fake-search-request-1');
  });

  it('differs deterministically per query and honours count', async () => {
    const adapter = new FakeResearchAdapter();
    const one = await adapter.search({ query: 'alpha' }, run);
    const two = await adapter.search({ query: 'beta' }, run);
    const short = await adapter.search({ query: 'alpha', count: 2 }, run);

    expect(one.results.map((r) => r.url)).not.toEqual(two.results.map((r) => r.url));
    expect(short.results).toHaveLength(2);
    expect(short.results).toEqual(one.results.slice(0, 2));
  });

  it('produces source rows that satisfy the schema shape and the acceptance gate', async () => {
    const { results } = await new FakeResearchAdapter().search({ query: 'shape check' }, run);
    expect(results).toHaveLength(5);

    for (const source of results) {
      expect(new URL(source.url).protocol).toBe('https:');
      expect(source.title.length).toBeGreaterThan(0);
      expect(source.summary.length).toBeGreaterThanOrEqual(600);
      expect(source.summary.length).toBeLessThanOrEqual(800);
      expect(typeof source.rerank_score).toBe('number');
      expect(source.content).toBeUndefined();
    }

    const { accepted, rejected } = partitionSources(results);
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    expect([...accepted, ...rejected]).toHaveLength(5);
  });

  it('returns page content only when need_content is requested', async () => {
    const adapter = new FakeResearchAdapter();
    const plain = await adapter.search({ query: 'q', need_content: false }, run);
    const withContent = await adapter.search({ query: 'q', need_content: true }, run);
    expect(plain.results[0]?.content).toBeUndefined();
    expect(withContent.results[0]?.content?.length).toBeGreaterThan(0);
  });

  it('serves deterministic fetch results and records the call', async () => {
    const adapter = new FakeResearchAdapter();
    const url = 'https://fixture.reels.test/page/1';
    const first = await adapter.fetch({ url }, run);
    const second = await new FakeResearchAdapter().fetch({ url }, run);

    expect(first).toEqual(second);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.content_markdown.startsWith('#')).toBe(true);
    expect(adapter.calls).toEqual([{ operation: 'fetch', target: url, runId: 'run-fixture-1' }]);
  });

  it('honours explicit fixtures, including an empty result set', async () => {
    const adapter = new FakeResearchAdapter({
      fixtures: {
        seeded: [fakeSource({ url: 'https://seeded.fixture.test/a', rerank_score: 1.7 })],
        empty: [],
      },
    });
    const seeded = await adapter.search({ query: 'seeded' }, run);
    const empty = await adapter.search({ query: 'empty' }, run);

    expect(seeded.results).toHaveLength(1);
    expect(seeded.results[0]?.url).toBe('https://seeded.fixture.test/a');
    expect(empty.results).toEqual([]);
  });

  it('never touches the network or the clock', async () => {
    const globalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error('the fake must not call fetch');
    }) as typeof globalThis.fetch;
    try {
      const adapter = new FakeResearchAdapter();
      await adapter.search({ query: 'offline' }, run);
      await adapter.fetch({ url: 'https://fixture.reels.test/a' }, run);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = globalFetch;
    }
  });
});
