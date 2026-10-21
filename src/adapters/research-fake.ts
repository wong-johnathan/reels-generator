/**
 * Deterministic in-memory research adapter — TECH_DESIGN §12 ("providers are
 * never called in tests").
 *
 * It honours the exact `ResearchAdapter` contract, requires a persisted-run
 * reference, and derives every byte from the query (sha256) so two runs, two
 * processes and two test files see identical sources. No clock, no network, no
 * randomness.
 */
import { createHash } from 'node:crypto';

import {
  RESEARCH_DEFAULT_COUNT,
  RESEARCH_RATE_LIMIT_PER_MIN,
  RESEARCH_TIMEOUT_MS,
  ResearchRequestError,
  assertResearchRun,
  type FetchRequest,
  type FetchResponse,
  type ResearchAdapter,
  type ResearchRun,
  type SearchRequest,
  type SearchResponse,
  type SourceResult,
} from './research-core.js';

export interface FakeResearchCall {
  readonly operation: 'search' | 'fetch';
  readonly target: string;
  readonly runId: string;
}

export interface FakeFetchFixture {
  readonly title: string;
  readonly content_markdown: string;
}

export interface FakeResearchOptions {
  /** Exact-query fixtures; a missing query falls back to deterministic derivation. */
  readonly fixtures?: Readonly<Record<string, readonly SourceResult[]>>;
  /** Exact-URL fetch fixtures. */
  readonly fetchFixtures?: Readonly<Record<string, FakeFetchFixture>>;
}

/** Scores chosen to straddle the 1.5 gate: 1.52, 1.10, 0.95, 1.80, 0.40. */
const SCORES = [1.52, 1.1, 0.95, 1.8, 0.4] as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function summaryFor(seed: string): string {
  const unit = `Deterministic fixture summary for ${seed.slice(0, 12)}. `;
  return unit.repeat(Math.ceil(640 / unit.length)).slice(0, 640);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Build one source row with schema-valid defaults, overridable per test. */
export function fakeSource(overrides: Partial<SourceResult> = {}): SourceResult {
  return {
    url: 'https://fixture.reels.test/source/1',
    title: 'Fixture source',
    snippet: 'Fixture snippet.',
    summary: summaryFor('fixture-source-1'),
    date: null,
    rerank_score: 1.52,
    site_name: 'fixture.reels.test',
    authority: 2,
    ...overrides,
  };
}

function deriveSources(query: string, count: number, needContent: boolean): SourceResult[] {
  const hash = digest(query);
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    const score = SCORES[index] ?? round2(0.75 + (index % 4) * 0.35);
    return {
      url: `https://fixture.reels.test/${hash.slice(0, 8)}/${position}`,
      title: `Fixture source ${position} for "${query}"`,
      snippet: `Deterministic fixture snippet ${position}.`,
      summary: summaryFor(`${hash}:${position}`),
      ...(needContent
        ? { content: `# Fixture page ${position}\n\nDeterministic body for "${query}".` }
        : {}),
      date: index % 3 === 2 ? null : `2026-01-0${(index % 9) + 1}T00:00:00Z`,
      rerank_score: score,
      site_name: 'fixture.reels.test',
      authority: index % 5,
    } satisfies SourceResult;
  });
}

export class FakeResearchAdapter implements ResearchAdapter {
  readonly provider = 'fake' as const;
  readonly model = null;
  readonly idempotencyProtected = false as const;
  readonly timeoutMs = RESEARCH_TIMEOUT_MS;
  readonly rateLimitPerMin = RESEARCH_RATE_LIMIT_PER_MIN;

  private readonly fixtures: Readonly<Record<string, readonly SourceResult[]>>;
  private readonly fetchFixtures: Readonly<Record<string, FakeFetchFixture>>;
  private readonly recordedCalls: FakeResearchCall[] = [];
  private searchCount = 0;

  constructor(options: FakeResearchOptions = {}) {
    this.fixtures = options.fixtures ?? {};
    this.fetchFixtures = options.fetchFixtures ?? {};
  }

  /** Every provider call the fake served, in order, for assertions. */
  get calls(): readonly FakeResearchCall[] {
    return this.recordedCalls;
  }

  async search(req: SearchRequest, run: ResearchRun): Promise<SearchResponse> {
    assertResearchRun(run);
    const query = typeof req.query === 'string' ? req.query.trim() : '';
    if (query === '' || query.length > 128) {
      throw new ResearchRequestError('search query must be 1-128 characters', {
        provider: this.provider,
        operation: 'search',
      });
    }
    const count = req.count ?? RESEARCH_DEFAULT_COUNT;
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ResearchRequestError('search count must be an integer 1-50', {
        provider: this.provider,
        operation: 'search',
      });
    }

    this.recordedCalls.push({ operation: 'search', target: query, runId: run.id });
    this.searchCount += 1;

    const fixture = this.fixtures[query];
    const results =
      fixture === undefined
        ? deriveSources(query, count, req.need_content === true)
        : fixture.slice(0, count);

    return { results, provider_request_id: `fake-search-request-${this.searchCount}` };
  }

  async fetch(req: FetchRequest, run: ResearchRun): Promise<FetchResponse> {
    assertResearchRun(run);
    const url = typeof req.url === 'string' ? req.url.trim() : '';
    if (url === '') {
      throw new ResearchRequestError('fetch url is required', {
        provider: this.provider,
        operation: 'fetch',
      });
    }

    this.recordedCalls.push({ operation: 'fetch', target: url, runId: run.id });

    const fixture = this.fetchFixtures[url];
    if (fixture !== undefined) {
      return { ...fixture, provider_request_id: `fake-fetch-request-${this.recordedCalls.length}` };
    }

    const hash = digest(url);
    return {
      title: `Fixture page ${hash.slice(0, 8)}`,
      content_markdown: `# Fixture page ${hash.slice(0, 8)}\n\nDeterministic fetched body for ${url}.`,
      provider_request_id: `fake-fetch-request-${this.recordedCalls.length}`,
    };
  }
}
