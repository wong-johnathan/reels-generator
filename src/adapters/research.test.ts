import { describe, expect, it, vi } from 'vitest';

import { AdapterStageMismatchError } from '../domain/generation-run.js';
import { validateEnv } from '../config/env.js';
import { FakeResearchAdapter, fakeSource } from './research-fake.js';
import {
  RESEARCH_DEFAULT_COUNT,
  RESEARCH_QUALIFICATION_CLAIMS,
  RESEARCH_QUALIFICATION_MIN_RESOLVED,
  RESEARCH_RERANK_THRESHOLD,
  ResearchProviderConfigError,
  ResearchRunRequiredError,
  classifyHttpStatus,
  createHttpUrlResolver,
  createResearchAdapter,
  createResearchAdapterFromEnv,
  isAcceptedSource,
  partitionSources,
  qualifyResearch,
  resolveResearchProvider,
} from './research.js';

describe('source acceptance gate (R-008-3 / QUALIFICATION 3)', () => {
  it('accepts rerank_score >= 1.5 with a non-empty absolute URL', () => {
    expect(RESEARCH_RERANK_THRESHOLD).toBe(1.5);
    expect(isAcceptedSource(fakeSource({ rerank_score: 1.5 }))).toBe(true);
    expect(isAcceptedSource(fakeSource({ rerank_score: 1.52 }))).toBe(true);
    expect(isAcceptedSource(fakeSource({ rerank_score: 1.49 }))).toBe(false);
    expect(isAcceptedSource(fakeSource({ rerank_score: 0 }))).toBe(false);
  });

  it('rejects an accepted-looking score with no usable URL', () => {
    for (const url of ['', '   ', 'not-a-url', 'ftp://fixture.reels.test/a']) {
      expect(isAcceptedSource(fakeSource({ url, rerank_score: 2.4 })), url).toBe(false);
    }
  });

  it('rejects a non-finite score instead of trusting NaN comparisons', () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isAcceptedSource(fakeSource({ rerank_score: score })), String(score)).toBe(false);
    }
  });

  it('partitions without reordering, so provider rank order survives', () => {
    const results = [
      fakeSource({ url: 'https://a.example/1', rerank_score: 1.52 }),
      fakeSource({ url: 'https://b.example/2', rerank_score: 1.1 }),
      fakeSource({ url: 'https://c.example/3', rerank_score: 1.8 }),
    ];
    const { accepted, rejected } = partitionSources(results);
    expect(accepted.map((s) => s.url)).toEqual(['https://a.example/1', 'https://c.example/3']);
    expect(rejected.map((s) => s.url)).toEqual(['https://b.example/2']);
  });
});

describe('research provider configuration (TECH_DESIGN 5.2 fallback boundary)', () => {
  it('defaults to DeepSeek: the Gemini grounding fallback is config-selected, never default', () => {
    expect(resolveResearchProvider({})).toBe('deepseek');
    expect(resolveResearchProvider({ RESEARCH_PROVIDER: '' })).toBe('deepseek');
    expect(createResearchAdapter({ apiKey: 'fixture-key' }).provider).toBe('deepseek');
  });

  it('selects the fallback by configuration alone', () => {
    const adapter = createResearchAdapter({
      provider: 'gemini',
      apiKey: 'fixture-gemini-key',
      model: 'fixture-grounding-model',
    });
    expect(adapter.provider).toBe('gemini');
    expect(adapter.model).toBe('fixture-grounding-model');
  });

  it('refuses the grounding fallback without a configured model', () => {
    expect(() => createResearchAdapter({ provider: 'gemini', apiKey: 'k' })).toThrow(
      ResearchProviderConfigError,
    );
    expect(() => createResearchAdapter({ provider: 'gemini', apiKey: 'k' })).toThrow(/model/);
  });

  it('refuses an unknown provider name instead of silently falling back', () => {
    expect(() => resolveResearchProvider({ RESEARCH_PROVIDER: 'bing' })).toThrow(
      ResearchProviderConfigError,
    );
    expect(() =>
      // @ts-expect-error - the config surface is closed; a JS caller can still pass junk.
      createResearchAdapter({ provider: 'bing', apiKey: 'k' }),
    ).toThrow(ResearchProviderConfigError);
  });

  it('builds the adapter from the validator env without echoing key values', () => {
    const adapter = createResearchAdapterFromEnv({ DEEPSEEK_API_KEY: 'fixture-deepseek-key' });
    expect(adapter.provider).toBe('deepseek');

    const fallback = createResearchAdapterFromEnv({
      RESEARCH_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'fixture-gemini-key',
      GEMINI_GROUNDING_MODEL: 'fixture-grounding-model',
    });
    expect(fallback.provider).toBe('gemini');

    expect(() => createResearchAdapterFromEnv({ RESEARCH_PROVIDER: 'gemini' })).toThrow(
      /GEMINI_API_KEY/,
    );
    const error = (() => {
      try {
        createResearchAdapterFromEnv({
          RESEARCH_PROVIDER: 'gemini',
          GEMINI_API_KEY: 'super-secret',
        });
        return null;
      } catch (err) {
        return err as Error;
      }
    })();
    expect(error?.message).toMatch(/GEMINI_GROUNDING_MODEL/);
    expect(error?.message).not.toContain('super-secret');
  });

  it('exposes the provider selection through the startup validator', () => {
    const base = { DEEPSEEK_API_KEY: 'k', GEMINI_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' };
    const issues = (env: Record<string, string>) =>
      validateEnv(env, 'worker').issues.filter((issue) => issue.key === 'RESEARCH_PROVIDER');
    expect(issues({ ...base, RESEARCH_PROVIDER: 'gemini' })).toEqual([]);
    expect(issues({ ...base, RESEARCH_PROVIDER: 'deepseek' })).toEqual([]);
    expect(issues({ ...base, RESEARCH_PROVIDER: 'bing' }).map((i) => i.problem)).toEqual([
      'invalid',
    ]);
    expect(issues(base)).toEqual([]);
  });
});

describe('the adapter cannot run without a persisted-run reference (R-012-1)', () => {
  it('rejects an empty or missing run id before doing any work', async () => {
    const adapter = new FakeResearchAdapter();
    await expect(adapter.search({ query: 'q' }, { id: '', stage: 'RS' })).rejects.toBeInstanceOf(
      ResearchRunRequiredError,
    );
    await expect(
      // @ts-expect-error - a JS caller can omit the run entirely.
      adapter.search({ query: 'q' }),
    ).rejects.toBeInstanceOf(ResearchRunRequiredError);
    expect(adapter.calls).toEqual([]);
  });

  it('rejects a run of the wrong stage', async () => {
    const adapter = new FakeResearchAdapter();
    await expect(
      adapter.search({ query: 'q' }, { id: 'run-1', stage: 'SC' }),
    ).rejects.toBeInstanceOf(AdapterStageMismatchError);
    expect(adapter.calls).toEqual([]);
  });
});

describe('retry classification (TECH_DESIGN 5.1/5.2)', () => {
  it('classifies 429 and 5xx as transient, other 4xx as non-retryable', () => {
    expect(classifyHttpStatus(429)).toBe('transient');
    for (const status of [500, 502, 503, 504]) expect(classifyHttpStatus(status)).toBe('transient');
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyHttpStatus(status)).toBe('non_retryable');
    }
    for (const status of [200, 201, 204, 301]) expect(classifyHttpStatus(status)).toBeNull();
  });
});

describe('qualification gate (R-008-3 research threshold)', () => {
  const claims = ['claim one', 'claim two', 'claim three', 'claim four', 'claim five'];

  function fixtures(resolvableHosts: readonly string[]) {
    const host = (n: number) => `${resolvableHosts[n] ?? `none${n}`}.fixture.test`;
    return {
      'claim one': [fakeSource({ url: `https://${host(0)}/a`, rerank_score: 1.52 })],
      'claim two': [fakeSource({ url: `https://${host(1)}/b`, rerank_score: 1.8 })],
      'claim three': [
        fakeSource({ url: `https://${host(2)}/c`, rerank_score: 1.6 }),
        fakeSource({ url: 'https://low-score.fixture.test/d', rerank_score: 1.1 }),
      ],
      'claim four': [fakeSource({ url: `https://${host(3)}/d`, rerank_score: 1.1 })],
      'claim five': [],
    } satisfies Record<string, ReturnType<typeof fakeSource>[]>;
  }

  it('enumerates exactly five factual claims for the qualification sample', () => {
    expect(RESEARCH_QUALIFICATION_CLAIMS).toHaveLength(5);
    expect(new Set(RESEARCH_QUALIFICATION_CLAIMS).size).toBe(5);
    expect(RESEARCH_QUALIFICATION_MIN_RESOLVED).toBe(3);
  });

  it('passes at 3 of 5 resolvable claims, checking only accepted sources', async () => {
    const adapter = new FakeResearchAdapter({
      fixtures: fixtures(['one', 'two', 'three', 'ignored-low-score', 'unused']),
    });
    const resolved: string[] = [];
    const result = await qualifyResearch(adapter, {
      run: (operation, index) => ({ id: `qual-${operation}-${index}`, stage: 'RS' }),
      resolveUrl: async (url) => {
        resolved.push(url);
        return true;
      },
      claims,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
    });

    expect(result.passed).toBe(true);
    expect(result.recorded).toBe(false);
    expect(result.details.claims_resolved).toBe(3);
    expect(result.details.claims_total).toBe(5);
    expect(result.details.threshold).toBe(3);
    expect(result.details.acceptance_threshold).toBe(1.5);
    expect(result.details.checked_at).toBe('2026-10-21T00:00:00.000Z');
    expect(result.details.claims.map((c) => c.passed)).toEqual([true, true, true, false, false]);
    // The below-threshold result on claim three is never checked for reachability.
    expect(resolved).not.toContain('https://low-score.fixture.test/d');
    expect(resolved).toHaveLength(3);
  });

  it('fails when only 2 of 5 claims resolve, even though the searches returned sources', async () => {
    const adapter = new FakeResearchAdapter({
      fixtures: fixtures(['one', 'two', 'unreachable', 'ignored-low-score', 'unused']),
    });
    const result = await qualifyResearch(adapter, {
      run: (_operation, index) => ({ id: `qual-run-${index}`, stage: 'RS' }),
      resolveUrl: async (url) => !url.includes('unreachable'),
      claims,
    });

    expect(result.passed).toBe(false);
    expect(result.details.claims_resolved).toBe(2);
    expect(result.details.claims.map((c) => c.resolved_urls.length)).toEqual([1, 1, 0, 0, 0]);
  });

  it('opens one persisted run per provider search and asks for the design default count', async () => {
    const adapter = new FakeResearchAdapter({ fixtures: fixtures(['a', 'b', 'c', 'd', 'e']) });
    const opened: string[] = [];
    await qualifyResearch(adapter, {
      run: (operation, index) => {
        opened.push(`${operation}:${index}`);
        return { id: `qual-run-${index}`, stage: 'RS' };
      },
      resolveUrl: async () => true,
      claims,
    });

    expect(opened).toEqual(['search:0', 'search:1', 'search:2', 'search:3', 'search:4']);
    expect(adapter.calls.every((call) => call.runId.startsWith('qual-run-'))).toBe(true);
    expect(adapter.calls.every((call) => call.operation === 'search')).toBe(true);
    expect(RESEARCH_DEFAULT_COUNT).toBe(5);
  });

  it('records a passing qualification row when given a recorder sink', async () => {
    const write = vi.fn(async (input: Record<string, unknown>) => ({
      id: 'row-1',
      run_at: new Date('2026-10-21T00:00:00.000Z'),
      ...input,
    }));
    const adapter = new FakeResearchAdapter({ fixtures: fixtures(['a', 'b', 'c', 'd', 'e']) });
    const result = await qualifyResearch(adapter, {
      run: (_operation, index) => ({ id: `qual-run-${index}`, stage: 'RS' }),
      resolveUrl: async () => true,
      claims,
      record: write as never,
    });

    expect(result.recorded).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const input = write.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.provider).toBe('fake');
    expect(input.adapter).toBe('research');
    expect(input.passed).toBe(true);
    expect((input.details as { claims_resolved: number }).claims_resolved).toBe(3);
  });
});

describe('the default HTTP resolver never throws and never trusts a non-HTTP URL', () => {
  it('returns false for unusable URLs without opening a socket', async () => {
    const fetchImpl = vi.fn();
    const resolve = createHttpUrlResolver({ fetchImpl: fetchImpl as never });
    for (const url of ['', 'not-a-url', 'ftp://x.test/a', 'file:///etc/passwd']) {
      await expect(resolve(url)).resolves.toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts 2xx/3xx, follows no redirects, and treats 4xx/errors as unresolvable', async () => {
    const seen: { method?: string; redirect?: string }[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { method?: string; redirect?: string }) => {
      seen.push({ method: init.method, redirect: init.redirect });
      return new Response(null, { status: 302 });
    });
    const resolve = createHttpUrlResolver({ fetchImpl: fetchImpl as never });
    await expect(resolve('https://fixture.test/ok')).resolves.toBe(true);
    expect(seen[0]).toEqual({ method: 'HEAD', redirect: 'manual' });

    fetchImpl.mockImplementation(async () => new Response(null, { status: 404 }));
    await expect(resolve('https://fixture.test/missing')).resolves.toBe(false);

    fetchImpl.mockImplementation(async () => {
      throw new Error('socket hang up');
    });
    await expect(resolve('https://fixture.test/down')).resolves.toBe(false);
  });
});
