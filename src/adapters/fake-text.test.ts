import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakePersistedRun, FIXED_RUN_ID } from '../../tests/helpers/runs.js';
import { SCRIPT_FRAME_PART, SCRIPT_NARRATION_PART } from '../domain/script-generation.js';
import { ProviderHttpError, ProviderSchemaError, ProviderTimeoutError } from './errors.js';
import { FakeTextAdapter } from './fake-text.js';
import { QUIET_MACHINES_FIXTURES } from './text-fixtures.js';
import { TEXT_SCHEMAS, type TextSchema } from './text-schemas.js';
import type { ChatMessage } from './text.js';

/** B-04 Signal, part 2: the fake is deterministic and never touches a socket. */
const MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: 'generate' }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FakeTextAdapter (TECH_DESIGN §6: deterministic, in-memory)', () => {
  it('returns the same bytes for the same run, schema and messages', async () => {
    const fake = new FakeTextAdapter();
    const request = { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES } as const;
    const run = fakePersistedRun({ stage: 'SC' });

    const first = await fake.generate(request, run);
    const second = await new FakeTextAdapter().generate(request, run);

    expect(second).toEqual(first);
    expect(first.provider_request_id).toBe(`fake-${FIXED_RUN_ID.slice(0, 8)}-script.v2`);
    expect(first.content).toEqual(QUIET_MACHINES_FIXTURES.script);
  });

  it('derives a different provider request id for a different run', async () => {
    const fake = new FakeTextAdapter();
    const request = { stage: 'T', schema: TEXT_SCHEMAS.topic, messages: MESSAGES } as const;

    const a = await fake.generate(request, fakePersistedRun({ stage: 'T', id: 'run-a' }));
    const b = await fake.generate(request, fakePersistedRun({ stage: 'T', id: 'run-b' }));

    expect(a.provider_request_id).not.toBe(b.provider_request_id);
    expect(a.content).toEqual(b.content);
  });

  it('serves a conformant fixture for every text stage', async () => {
    const fake = new FakeTextAdapter();
    const schemas: readonly TextSchema<unknown>[] = [
      TEXT_SCHEMAS.topic,
      TEXT_SCHEMAS.script,
      TEXT_SCHEMAS.storyboard,
    ];
    for (const schema of schemas) {
      const result = await fake.generate(
        { stage: schema.stage, schema, messages: MESSAGES },
        fakePersistedRun({ stage: schema.stage }),
      );
      expect(() => schema.schema.parse(result.content)).not.toThrow();
      expect(result.http_status).toBe(200);
      expect(result.model).toBe('fake-text');
    }
  });

  it('serves fixtures for the internal two-phase script parts', async () => {
    const fake = new FakeTextAdapter();
    for (const part of [SCRIPT_FRAME_PART, SCRIPT_NARRATION_PART]) {
      const result = await fake.generate(
        {
          stage: 'SC',
          schema: part as unknown as TextSchema<unknown>,
          messages: MESSAGES,
        },
        fakePersistedRun({ stage: 'SC' }),
      );
      expect(() => part.schema.parse(result.content)).not.toThrow();
    }
  });
  it.each([SCRIPT_FRAME_PART as TextSchema<unknown>, SCRIPT_NARRATION_PART as TextSchema<unknown>])(
    'serves a conformant default fixture for $name with no scripted responses',
    async (schema) => {
      const fake = new FakeTextAdapter({ responses: [] });
      const result = await fake.generate(
        { stage: schema.stage, schema, messages: MESSAGES },
        fakePersistedRun({ stage: schema.stage }),
      );

      expect(result.content).toBeDefined();
      expect(() => schema.parse(result.content)).not.toThrow();
      expect(result.http_status).toBe(200);
      expect(result.model).toBe('fake-text');
    },
  );

  it('never calls fetch — a stubbed global fetch that throws is irrelevant', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('a test reached the network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const fake = new FakeTextAdapter();
    await fake.generate(
      { stage: 'SB', schema: TEXT_SCHEMAS.storyboard, messages: MESSAGES },
      fakePersistedRun({ stage: 'SB' }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records each call for assertions', async () => {
    const fake = new FakeTextAdapter();
    const run = fakePersistedRun({ stage: 'SC', id: 'run-recorded' });
    await fake.generate({ stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES }, run);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      runId: 'run-recorded',
      stage: 'SC',
      schemaName: 'script',
      schemaVersion: 'script.v2',
    });
  });

  it('can be scripted to fail like the provider would, deterministically', async () => {
    const fake = new FakeTextAdapter({
      responses: [
        { kind: 'http', status: 503 },
        { kind: 'timeout' },
        { kind: 'invalid-schema', content: { ...QUIET_MACHINES_FIXTURES.script, script: 42 } },
      ],
    });
    const request = { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES } as const;
    const run = fakePersistedRun({ stage: 'SC' });

    const http = await fake.generate(request, run).catch((error: unknown) => error);
    expect(http).toBeInstanceOf(ProviderHttpError);
    expect((http as ProviderHttpError).errorClass).toBe('transient');
    expect((http as ProviderHttpError).httpStatus).toBe(503);

    const timeout = await fake.generate(request, run).catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(ProviderTimeoutError);
    expect((timeout as ProviderTimeoutError).mayHaveBilled).toBe(true);

    const schema = await fake.generate(request, run).catch((error: unknown) => error);
    expect(schema).toBeInstanceOf(ProviderSchemaError);
    expect((schema as ProviderSchemaError).errorClass).toBe('non_retryable');

    // The script is exhausted: the fake returns to its deterministic fixture.
    const ok = await fake.generate(request, run);
    expect(ok.content).toEqual(QUIET_MACHINES_FIXTURES.script);
  });

  it('can return a caller-supplied valid document, e.g. to test the word budget', async () => {
    const tooShort = {
      ...QUIET_MACHINES_FIXTURES.script,
      script: 'One short sentence only.',
    };
    const fake = new FakeTextAdapter({ responses: [{ kind: 'content', content: tooShort }] });

    const result = await fake.generate(
      { stage: 'SC', schema: TEXT_SCHEMAS.script, messages: MESSAGES },
      fakePersistedRun({ stage: 'SC' }),
    );
    expect(result.content).toEqual(tooShort);
  });

  it('exposes the same adapter surface as the real one', async () => {
    const fake = new FakeTextAdapter();
    expect(fake.provider).toBe('deepseek');
    expect(fake.idempotencyProtected).toBe(false);

    const bound = fake.forRequest({
      stage: 'T',
      schema: TEXT_SCHEMAS.topic,
      messages: MESSAGES,
    });
    expect(bound.stage).toBe('T');
    const result = await bound.execute(fakePersistedRun({ stage: 'T' }));
    expect(result.content).toEqual(QUIET_MACHINES_FIXTURES.topic);
  });
});
