import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  withSecondConnection,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { FakeTextAdapter, type FakeTextResponse } from '../adapters/fake-text.js';
import { QUIET_MACHINES_FIXTURES } from '../adapters/text-fixtures.js';
import { buildChatRequestBody, type TextRequest } from '../adapters/text.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';
import { FakeTtsAdapter } from '../adapters/tts.js';
import { InMemoryImageQualificationStore } from '../adapters/image-qualification.js';
import { runMigrations } from '../db/runner.js';
import * as authoring from '../domain/authoring.js';
import { countWords, stripForbiddenDashes } from '../domain/authoring.js';
import {
  assembleScript,
  freezeFrame,
  narrationRepairDelta,
  narrationWordTarget,
} from '../domain/script-generation.js';
import { advanceAfterStage, runStage, type OrchestratorDeps } from '../worker/orchestrator.js';
import { SharedBlobStore } from '../worker/blobs.js';
import { createPostgresSceneGateway } from '../web/scenes/postgres.js';
import { InMemoryBlobStore } from './asset-store.js';

import { TEXT_SCHEMAS } from '../adapters/text-schemas.js';
import {
  normalizeDocument,
  MAX_SCRIPT_QUERIES,
  runTextStage,
  sceneRowPosition,
  scriptTextOf,
  systemPrompt,
  unwrapTextDocument,
  withRepairFeedback,
} from './text-stage.js';

/**
 * `runProviderAttempt` hands the adapter's envelope to `onResult`. Reading the
 * envelope as if it were the document cost a CI cycle: SC threw on
 * `undefined.trim()` and T persisted an empty title instead of failing.
 */
describe('unwrapTextDocument', () => {
  it('returns the document inside the adapter envelope', () => {
    const document = { script: 's' };
    expect(
      unwrapTextDocument({
        content: document,
        raw: { id: 'x' },
        provider_request_id: 'x',
        model: 'm',
        http_status: 200,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    ).toBe(document);
  });

  it('throws rather than returning an undefined document', () => {
    expect(() => unwrapTextDocument({ raw: {}, usage: {} })).toThrow(/no content envelope/);
  });

  it('throws on a non-object result', () => {
    expect(() => unwrapTextDocument(null)).toThrow(/no content envelope/);
    expect(() => unwrapTextDocument('a script')).toThrow(/no content envelope/);
  });
});

describe('scriptTextOf', () => {
  it('reads the single script field used by script.v2', () => {
    expect(
      scriptTextOf({
        content: { script: 'A short draft.', title: 't', description: 'd', hashtags: [] },
        raw: {},
        provider_request_id: 'x',
        model: 'm',
        http_status: 200,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    ).toBe('A short draft.');
  });

  it('does not fall back to the removed narration field', () => {
    expect(
      scriptTextOf({
        content: { narration: 'old shape' },
        raw: {},
        provider_request_id: 'x',
        model: 'm',
        http_status: 200,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    ).toBeNull();
  });
});
describe('sceneRowPosition', () => {
  it("maps the planner's 0-based position onto the 1-based row", () => {
    // scene_position_check requires >= 1, and the checkpoint filter reads 1..3.
    expect(sceneRowPosition(0)).toBe(1);
    expect(sceneRowPosition(16)).toBe(17);
  });
});

/**
 * Real providers reply with *some* JSON, not our JSON: without the schema in the
 * prompt DeepSeek invented its own keys and T failed topic.v1 on every live run.
 * These two shapes are unambiguous, so they are unwrapped rather than failed.
 */
describe('normalizeDocument', () => {
  it('unwraps a one-key envelope around the document', () => {
    expect(normalizeDocument({ topic: { title: 't', description: 'd', rationale: null } })).toEqual(
      { title: 't', description: 'd', rationale: null },
    );
  });

  it('parses a fenced code block', () => {
    const fenced = '```json\n{ "title": "t", "description": "d", "rationale": null }\n```';
    expect(normalizeDocument(fenced)).toEqual({
      title: 't',
      description: 'd',
      rationale: null,
    });
  });

  it('leaves a real document untouched', () => {
    const doc = { title: 't', description: 'd', rationale: 'because' };
    expect(normalizeDocument(doc)).toBe(doc);
  });

  it('leaves the storyboard document alone: its only key holds an array', () => {
    const storyboard = { scenes: [{ index: 1, narration: 'x' }] };
    expect(normalizeDocument(storyboard)).toBe(storyboard);
  });

  it('does not guess at arbitrary nesting', () => {
    const nested = { a: { b: 1 }, c: 2 };
    expect(normalizeDocument(nested)).toBe(nested);
  });
});

describe('systemPrompt', () => {
  it('sends the schema version and its fields, not just the phrase "the schema"', () => {
    const prompt = systemPrompt(TEXT_SCHEMAS.topic as never);
    expect(prompt).toContain('topic.v1');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"rationale"');
  });

  it('names the stage schema, so a script call cannot be answered with a topic', () => {
    expect(systemPrompt(TEXT_SCHEMAS.script as never)).toContain('script.v2');
  });
});

describe('withRepairFeedback', () => {
  it('carries the rejection into the next request instead of repeating it', () => {
    const base = [{ role: 'system' as const, content: 'sys' }];
    const next = withRepairFeedback(base, 'scene count 11 is outside 14–20');
    expect(next).toHaveLength(2);
    expect(next[1]!.content).toContain('scene count 11 is outside 14–20');
    expect(next[1]!.content).toContain('corrected JSON object');
    // The original messages are untouched: a repair is an addition, not a rewrite.
    expect(base).toHaveLength(1);
  });
});

// Missing infrastructure is BLOCKED evidence, not a passing wiring test.
if (!testDatabaseUrl()) console.warn(`[SC wiring/ordering BLOCKED] ${SKIP_REASON}`);

describe.skipIf(!testDatabaseUrl())('SC worker wiring on disposable Postgres', () => {
  let db: TestDatabase;
  let seeded: SeededProject;
  let jobId: string;
  let blobs: InMemoryBlobStore;
  const frame = QUIET_MACHINES_FIXTURES.frame;
  const frozen = freezeFrame(frame);
  const middle = (words: number) => Array.from({ length: words }, (_, i) => `detail${i}`).join(' ');
  const inBand = middle(narrationWordTarget(frozen, 75));
  const content = (value: unknown): FakeTextResponse => ({ kind: 'content', content: value });

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 240_000);
  beforeEach(async () => {
    seeded = await seedProject(db.pool);
    await db.pool.query(`UPDATE project SET current_stage = 'SC' WHERE id = $1`, [
      seeded.projectId,
    ]);
    await db.pool.query(`UPDATE job SET stage = 'SC' WHERE id = $1`, [seeded.jobId]);
    jobId = seeded.jobId;
    for (const stage of ['SC', 'SB', 'IM', 'NA']) {
      await db.pool.query(`INSERT INTO video_stage (project_id, stage) VALUES ($1, $2)`, [
        seeded.projectId,
        stage,
      ]);
    }
    blobs = new InMemoryBlobStore();
    vi.spyOn(blobs, 'put');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db?.close();
  });

  // Observe actual worker-built requests using the existing scripted provider.
  // A fresh session proves that every ledger row is committed BEFORE execute.
  function provider(responses: readonly FakeTextResponse[]) {
    const text = new FakeTextAdapter({ responses });
    const requests: TextRequest<unknown>[] = [];
    const ids: string[] = [];
    const original = text.generate.bind(text);
    vi.spyOn(text, 'generate').mockImplementation(async (request, run) => {
      requests.push(request);
      ids.push(run.id);
      const expectedHash = createHash('sha256')
        .update(JSON.stringify(request.messages))
        .digest('hex');
      expect(run.promptHash).toBe(expectedHash);
      await withSecondConnection(db.pool, async (client) => {
        const ledger = await client.query(
          `SELECT status, charge_status, prompt_hash, job_attempt_id FROM generation_run WHERE id = $1`,
          [run.id],
        );
        expect(ledger.rows).toEqual([
          {
            status: 'pending',
            charge_status: 'pending',
            prompt_hash: expectedHash,
            job_attempt_id: run.jobAttemptId,
          },
        ]);
        const scripts = await client.query(`SELECT id FROM script_revision WHERE project_id = $1`, [
          seeded.projectId,
        ]);
        if (request.stage === 'SC') {
          expect(scripts.rows).toHaveLength(0);
          const downstream = await client.query(
            `SELECT id FROM job WHERE project_id = $1 AND stage IN ('SB', 'IM', 'NA')`,
            [seeded.projectId],
          );
          expect(downstream.rows).toHaveLength(0);
        }
      });
      return original(request, run);
    });
    return { text, requests, ids };
  }
  async function run(text: FakeTextAdapter) {
    return runTextStage({ pool: db.pool, text, blobs }, 'SC', {
      jobId,
      projectId: seeded.projectId,
      attemptNo: 1,
    });
  }
  function user(request: TextRequest<unknown>) {
    return JSON.parse(request.messages[1]!.content) as {
      instruction: string;
      hook?: string;
      ending?: string;
    };
  }
  async function assertLedger(ids: readonly string[], statuses: readonly string[]) {
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, id] of ids.entries()) {
      const result = await db.pool.query(
        `SELECT status, charge_status, ended_at FROM generation_run WHERE id = $1`,
        [id],
      );
      expect(result.rows[0]).toMatchObject({ status: statuses[index] });
      expect(result.rows[0]!.charge_status).not.toBe('pending');
      expect(result.rows[0]!.ended_at).not.toBeNull();
    }
    const all = await db.pool.query<{ id: string }>(
      `SELECT id FROM generation_run WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(all.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
  }
  async function assertNoAdvance() {
    const scripts = await db.pool.query(`SELECT id FROM script_revision WHERE project_id = $1`, [
      seeded.projectId,
    ]);
    expect(scripts.rows).toHaveLength(0);
    expect(blobs.size).toBe(0);
    expect(blobs.put).not.toHaveBeenCalled();
    const stage = await db.pool.query(
      `SELECT state, last_event FROM video_stage WHERE project_id = $1 AND stage = 'SC'`,
      [seeded.projectId],
    );
    expect(stage.rows[0]!.state).not.toBe('done');
    expect(stage.rows[0]!.last_event).not.toBe('succeed');
    const project = await db.pool.query(`SELECT current_stage FROM project WHERE id = $1`, [
      seeded.projectId,
    ]);
    expect(project.rows[0]!.current_stage).toBe('SC');
    // Even a recovered advance must refuse a failed/running SC stage.
    expect(
      await advanceAfterStage(db.pool, {
        id: jobId,
        projectId: seeded.projectId,
        stage: 'SC',
        sceneId: null,
        priority: 2,
      }),
    ).toBeNull();
    const downstream = await db.pool.query(
      `SELECT id FROM job WHERE project_id = $1 AND stage IN ('SB', 'IM', 'NA')`,
      [seeded.projectId],
    );
    expect(downstream.rows).toHaveLength(0);
  }

  it('frame → short middle → in-band repair persists exact endpoints/metadata and forwards every token ceiling', async () => {
    const short = middle(20);
    const h = provider([
      content(frame),
      content({ narration: short }),
      content({ narration: inBand }),
    ]);
    expect((await run(h.text)).status).toBe('succeeded');
    expect(h.requests.map((req) => req.schema.version)).toEqual([
      'script-frame.v1',
      'script-narration.v1',
      'script-narration.v1',
    ]);
    expect(h.requests.map((req) => req.max_tokens)).toEqual([1024, 1536, 1536]);
    expect(h.requests.map((req) => buildChatRequestBody(req, h.text.model).max_tokens)).toEqual([
      1024, 1536, 1536,
    ]);
    for (const req of h.requests) {
      expect(buildChatRequestBody(req, h.text.model).messages).toEqual(req.messages);
      expect(req.messages[0]!.content).toContain(req.schema.version);
    }
    const repair = user(h.requests[2]!);
    const currentWords = countWords(assembleScript(frozen, short).script);
    expect(repair.instruction).toContain(`at ${currentWords} words`);
    expect(repair.instruction).toContain(
      `Add about ${narrationRepairDelta(currentWords, 75)} more words`,
    );
    expect(repair.instruction).toContain(`about ${narrationWordTarget(frozen, 75)} words`);
    for (const req of h.requests.slice(1)) {
      expect(user(req)).toMatchObject({ hook: frozen.hook, ending: frozen.ending });
      expect(user(req).instruction).toContain('ONLY the middle');
      expect(req.schema.jsonSchema).toMatchObject({ required: ['narration'] });
    }
    const saved = await db.pool.query(
      `SELECT content, word_count, status FROM script_revision WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(saved.rows).toEqual([
      {
        content: assembleScript(frozen, inBand),
        word_count: countWords(assembleScript(frozen, inBand).script),
        status: 'approved',
      },
    ]);
    expect(blobs.size).toBe(1);
    expect(blobs.put).toHaveBeenCalledTimes(1);
    expect(saved.rows[0]!.content).toEqual({
      script: `${frame.hook} ${inBand} ${frame.ending}`,
      title: frame.title,
      description: frame.description,
      hashtags: frame.hashtags,
    });
    const stage = await db.pool.query(
      `SELECT state, last_event FROM video_stage WHERE project_id = $1 AND stage = 'SC'`,
      [seeded.projectId],
    );
    expect(stage.rows).toEqual([{ state: 'done', last_event: 'succeed' }]);
    const bytes = await blobs.get(blobs.keys()[0]!);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(assembleScript(frozen, inBand));
    await assertLedger(h.ids, ['succeeded', 'succeeded', 'succeeded']);
    const hashes = h.requests.map((req) =>
      createHash('sha256').update(JSON.stringify(req.messages)).digest('hex'),
    );
    expect(new Set(hashes).size).toBe(3);
  }, 120_000);

  it('cuts a long middle without regenerating the frame', async () => {
    const long = middle(300);
    const h = provider([
      content(frame),
      content({ narration: long }),
      content({ narration: inBand }),
    ]);
    expect((await run(h.text)).status).toBe('succeeded');
    const words = countWords(assembleScript(frozen, long).script);
    expect(user(h.requests[2]!).instruction).toContain(
      `Cut about ${-narrationRepairDelta(words, 75)} words`,
    );
    expect(user(h.requests[2]!)).toMatchObject({ hook: frozen.hook, ending: frozen.ending });
    expect(h.requests.filter((req) => req.schema.version === 'script-frame.v1')).toHaveLength(1);
    await assertLedger(h.ids, ['succeeded', 'succeeded', 'succeeded']);
  }, 120_000);

  it.each([20, 300])(
    'exhausts MAX_SCRIPT_QUERIES with %i-word middles without persisting, uploading or queuing SB',
    async (words) => {
      const h = provider([
        content(frame),
        ...Array.from({ length: MAX_SCRIPT_QUERIES }, () => content({ narration: middle(words) })),
      ]);
      const result = await run(h.text);
      expect(result.status).toBe('failed');
      expect(result.attempt.failure?.message).toContain(
        `after ${MAX_SCRIPT_QUERIES} narration queries`,
      );
      expect(h.requests).toHaveLength(1 + MAX_SCRIPT_QUERIES);
      await assertNoAdvance();
      await assertLedger(h.ids, ['failed', ...Array<string>(MAX_SCRIPT_QUERIES).fill('succeeded')]);
    },
    120_000,
  );

  it('authoritatively rejects an out-of-band assembled output before any persistence', async () => {
    // Fault injection at the earlier acceptance check proves the independent
    // onResult guard, not just the repair loop's normal rejection path.
    const check = authoring.checkWordBudget;
    vi.spyOn(authoring, 'checkWordBudget').mockImplementationOnce((script, duration) => ({
      ...check(script, duration),
      within_band: true,
    }));
    const h = provider([content(frame), content({ narration: middle(20) })]);
    const result = await run(h.text);
    expect(result.status).toBe('failed');
    expect(result.attempt.failure?.message).toContain('R-009-1');
    expect(h.requests).toHaveLength(2);
    await assertNoAdvance();
    await assertLedger(h.ids, ['failed', 'succeeded']);
  }, 120_000);

  it.each([
    [
      'malformed frame',
      [{ kind: 'invalid-schema', content: { hook: 'missing fields' } }],
      ['failed'],
    ],
    [
      'malformed narration',
      [content(frame), { kind: 'invalid-schema', content: { narration: 42 } }],
      ['failed', 'failed'],
    ],
    [
      'provider failure during repair',
      [content(frame), content({ narration: middle(20) }), { kind: 'http', status: 503 }],
      ['failed', 'succeeded', 'failed'],
    ],
  ] as const)(
    '%s never persists or advances and closes every opened run',
    async (_label, responses, statuses) => {
      const h = provider(responses);
      expect((await run(h.text)).status).toBe('failed');
      expect(h.requests).toHaveLength(responses.length);
      await assertNoAdvance();
      await assertLedger(h.ids, statuses);
    },
    120_000,
  );

  it('repairs duplicate hooks even when in band, sanitizes dashes and preserves endpoint identity', async () => {
    const dirtyFrame = {
      ...frame,
      hook: 'Opening—identity stays.',
      ending: 'Closing–identity stays.',
    };
    const clean = freezeFrame(dirtyFrame);
    const target = narrationWordTarget(clean, 75);
    const duplicate = `${clean.hook} ${middle(target - countWords(clean.hook))}`;
    expect(authoring.checkWordBudget(assembleScript(clean, duplicate).script, 75).within_band).toBe(
      true,
    );
    const dirtyMiddle = `${middle(target - 2)} detail—one detail–two`;
    const h = provider([
      content(dirtyFrame),
      content({ narration: duplicate }),
      content({ narration: dirtyMiddle }),
    ]);
    expect((await run(h.text)).status).toBe('succeeded');
    expect(h.requests).toHaveLength(3);
    expect(user(h.requests[2]!)).toMatchObject({ hook: clean.hook, ending: clean.ending });
    const saved = await db.pool.query(`SELECT content FROM script_revision WHERE project_id = $1`, [
      seeded.projectId,
    ]);
    expect(saved.rows[0]!.content).toEqual(
      assembleScript(clean, stripForbiddenDashes(dirtyMiddle)),
    );
    expect(saved.rows[0]!.content.script).not.toMatch(/[—–]/);
    await assertLedger(h.ids, ['succeeded', 'succeeded', 'succeeded']);
  }, 120_000);

  it('orders SC repair/persistence → SB → storyboard approval before media work is queued', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'false');
    const h = provider([
      content(frame),
      content({ narration: middle(20) }),
      content(QUIET_MACHINES_FIXTURES.narration),
    ]);
    const store = new SharedBlobStore();
    const tts = new FakeTtsAdapter();
    const image = new FakeImageAdapter();
    const ttsCall = vi.spyOn(tts, 'convert');
    const imageCall = vi.spyOn(image, 'generate');
    const deps: OrchestratorDeps = {
      pool: db.pool,
      text: h.text,
      tts,
      image,
      qualification: new InMemoryImageQualificationStore(),
      contentBlobs: store.asset,
      renderBlobs: store.content,
      runner: {
        run: async () => {
          throw new Error('no render before approval');
        },
        probe: async () => {
          throw new Error('no probe before approval');
        },
        analyse: async () => {
          throw new Error('no analysis before approval');
        },
      },
    };
    const scJob = {
      id: jobId,
      projectId: seeded.projectId,
      stage: 'SC' as const,
      sceneId: null,
      priority: 2,
    };
    expect((await runStage(deps, scJob)).status).toBe('succeeded');
    const saved = await db.pool.query(`SELECT content FROM script_revision WHERE project_id = $1`, [
      seeded.projectId,
    ]);
    expect(saved.rows[0]!.content).toEqual(QUIET_MACHINES_FIXTURES.script);
    expect(await advanceAfterStage(db.pool, scJob)).toBe('SB');
    const queued = await db.pool.query(
      `SELECT id, stage FROM job WHERE project_id = $1 AND stage IN ('SB', 'IM', 'NA')`,
      [seeded.projectId],
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]!.stage).toBe('SB');
    const sbJob = { ...scJob, id: queued.rows[0]!.id as string, stage: 'SB' as const };
    expect((await runStage(deps, sbJob)).status).toBe('succeeded');
    expect(await advanceAfterStage(db.pool, sbJob)).toBeNull();
    const sb = await db.pool.query(
      `SELECT state FROM video_stage WHERE project_id = $1 AND stage = 'SB'`,
      [seeded.projectId],
    );
    expect(sb.rows[0]!.state).toBe('awaiting_approval');
    const media = await db.pool.query(
      `SELECT id FROM job WHERE project_id = $1 AND stage IN ('IM', 'NA')`,
      [seeded.projectId],
    );
    expect(media.rows).toHaveLength(0);
    expect(ttsCall).not.toHaveBeenCalled();
    expect(imageCall).not.toHaveBeenCalled();
    expect(h.requests.at(-1)!.stage).toBe('SB');
    expect(h.requests.at(-1)!.messages[1]!.content).toContain(
      QUIET_MACHINES_FIXTURES.script.script,
    );
    const gateway = createPostgresSceneGateway(db.pool);
    const board = await gateway.storyboard(seeded.projectId);
    expect(board).not.toBeNull();
    await gateway.approveStoryboard(seeded.projectId, { revision: board!.revision });
    const released = await db.pool.query(
      `SELECT stage, status FROM job WHERE project_id = $1 AND stage IN ('IM', 'NA')`,
      [seeded.projectId],
    );
    expect(released.rows).toEqual([{ stage: 'IM', status: 'queued' }]);
    expect(ttsCall).not.toHaveBeenCalled();
    expect(imageCall).not.toHaveBeenCalled();
  }, 180_000);
});
