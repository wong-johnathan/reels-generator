/**
 * R-004-1 / R-004-2 — versioned schema validation and the 3-attempt ceiling
 * (US-014, US-017, US-018).
 *
 * Signal (LEAD_PLAN §4/B-09): "malformed payload retries 3× then surfaces failing
 * field + schema version + retry count". The tests below also pin the cost rule:
 * a document only exists on the success branch, so nothing downstream can be
 * enqueued from a failed validation.
 */
import { describe, expect, it, vi } from 'vitest';

import { QUIET_MACHINES_FIXTURES } from '../adapters/text-fixtures.js';
import {
  SCRIPT_DOCUMENT_VERSION,
  STORYBOARD_DOCUMENT_VERSION,
  TEXT_SCHEMAS,
  TOPIC_DOCUMENT_VERSION,
} from '../adapters/text-schemas.js';
import {
  DOCUMENT_SCHEMAS,
  MAX_SCHEMA_ATTEMPTS,
  SchemaRetryExhaustedError,
  blockedStagesAfter,
  surfacingFor,
  validateAttempt,
  validateWithRetry,
} from './validation.js';

/** The canonical script fixture with `script` removed — a malformed payload. */
function withoutScriptBody(): Record<string, unknown> {
  const payload = structuredClone(QUIET_MACHINES_FIXTURES.script) as unknown as Record<
    string,
    unknown
  >;
  delete payload.script;
  return payload;
}

/** A storyboard payload whose third scene has a valid-but-empty image prompt. */
function storyboardWithBadPrompt(): Record<string, unknown> {
  const payload = structuredClone(QUIET_MACHINES_FIXTURES.storyboard) as unknown as {
    scenes: Record<string, unknown>[];
  };
  payload.scenes[2]!.image_prompt = '';
  return payload as unknown as Record<string, unknown>;
}

describe('DOCUMENT_SCHEMAS — one version authority for the three text stages', () => {
  it('binds topic/script/storyboard to the versioned schemas B-04 owns', () => {
    expect(DOCUMENT_SCHEMAS.topic.version).toBe(TOPIC_DOCUMENT_VERSION);
    expect(DOCUMENT_SCHEMAS.script.version).toBe(SCRIPT_DOCUMENT_VERSION);
    expect(DOCUMENT_SCHEMAS.storyboard.version).toBe(STORYBOARD_DOCUMENT_VERSION);
    expect(DOCUMENT_SCHEMAS.script).toBe(TEXT_SCHEMAS.script);
  });

  it('accepts the canonical fixtures for all three stages', () => {
    expect(validateAttempt(DOCUMENT_SCHEMAS.topic, QUIET_MACHINES_FIXTURES.topic, 1).ok).toBe(true);
    expect(validateAttempt(DOCUMENT_SCHEMAS.script, QUIET_MACHINES_FIXTURES.script, 1).ok).toBe(
      true,
    );
    expect(
      validateAttempt(DOCUMENT_SCHEMAS.storyboard, QUIET_MACHINES_FIXTURES.storyboard, 1).ok,
    ).toBe(true);
  });
});

describe('validateAttempt — a failing field and its version, never the payload', () => {
  it('names the failing top-level field', () => {
    const outcome = validateAttempt(TEXT_SCHEMAS.script, withoutScriptBody(), 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a validation failure');
    expect(outcome.failure.code).toBe('schema_invalid');
    expect(outcome.failure.failing_field).toBe('script');
    expect(outcome.failure.schema_name).toBe('script');
    expect(outcome.failure.schema_version).toBe('script.v2');
    expect(outcome.failure.stage).toBe('SC');
    expect(outcome.failure.retry_count).toBe(1);
    expect(outcome.failure.field_errors.length).toBeGreaterThan(0);
  });

  it('names a nested field with an indexed path', () => {
    const outcome = validateAttempt(TEXT_SCHEMAS.storyboard, storyboardWithBadPrompt(), 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a validation failure');
    expect(outcome.failure.failing_field).toBe('scenes[2].image_prompt');
  });

  it('carries field paths and codes only — no model content', () => {
    const outcome = validateAttempt(TEXT_SCHEMAS.script, withoutScriptBody(), 1);
    if (outcome.ok) throw new Error('expected a validation failure');

    expect(Object.keys(outcome.failure).sort()).not.toContain('payload');
    for (const issue of outcome.failure.field_errors) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'field', 'message']);
    }
  });

  it('marks the producing stages that a failure stops, and zero downstream billable calls', () => {
    const outcome = validateAttempt(TEXT_SCHEMAS.script, withoutScriptBody(), 3);
    if (outcome.ok) throw new Error('expected a validation failure');

    expect(outcome.failure.blocked_stages).toEqual(['SB', 'IM', 'NA', 'TC', 'RE', 'QC']);
    expect(outcome.failure.billable_downstream_calls).toBe(0);
  });
});

describe('blockedStagesAfter — pipeline order, gates excluded', () => {
  it('stops every producing stage after the failed one', () => {
    expect(blockedStagesAfter('T')).toEqual(['RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC']);
    expect(blockedStagesAfter('SC')).toEqual(['SB', 'IM', 'NA', 'TC', 'RE', 'QC']);
    expect(blockedStagesAfter('SB')).toEqual(['IM', 'NA', 'TC', 'RE', 'QC']);
  });
});

describe('validateWithRetry — R-004-2 signal', () => {
  it('retries a malformed payload three times then surfaces field + version + retry count', async () => {
    const generate = vi.fn(async () => withoutScriptBody());

    const outcome = await validateWithRetry({
      schema: TEXT_SCHEMAS.script,
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(MAX_SCHEMA_ATTEMPTS);
    expect(MAX_SCHEMA_ATTEMPTS).toBe(3);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected exhausted validation');
    expect(outcome.failure.retry_count).toBe(3);
    expect(outcome.failure.failing_field).toBe('script');
    expect(outcome.failure.schema_version).toBe('script.v2');
    expect(outcome.failures).toHaveLength(3);
    expect(outcome.failures.map((failure) => failure.retry_count)).toEqual([1, 2, 3]);
    // No document on the failure branch, so no downstream stage can be enqueued.
    expect(Object.hasOwn(outcome, 'document')).toBe(false);
  });

  it('stops on the first valid payload and counts the attempts it took', async () => {
    let call = 0;
    const generate = vi.fn(async () => {
      call += 1;
      return call < 3 ? withoutScriptBody() : structuredClone(QUIET_MACHINES_FIXTURES.script);
    });

    const outcome = await validateWithRetry({ schema: TEXT_SCHEMAS.script, generate });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a validated document');
    expect(outcome.attempts).toBe(3);
    expect(outcome.schema_version).toBe('script.v2');
    expect(outcome.failures).toHaveLength(2);
    expect(outcome.document.script.length).toBeGreaterThan(0);
  });

  it('reports each invalid attempt to the caller on the way (the UI counter)', async () => {
    const seen: number[] = [];
    const outcome = await validateWithRetry({
      schema: TEXT_SCHEMAS.script,
      generate: async () => withoutScriptBody(),
      onInvalid: (failure) => {
        seen.push(failure.retry_count);
      },
    });

    expect(outcome.ok).toBe(false);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('refuses to raise the ceiling above three', async () => {
    await expect(
      validateWithRetry({
        schema: TEXT_SCHEMAS.script,
        generate: async () => withoutScriptBody(),
        maxAttempts: 4,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('refuses a non-positive attempt count', async () => {
    await expect(
      validateWithRetry({
        schema: TEXT_SCHEMAS.script,
        generate: async () => withoutScriptBody(),
        maxAttempts: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('lets a transport failure propagate — it is B-08 retry policy, not a schema failure', async () => {
    const generate = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    await expect(validateWithRetry({ schema: TEXT_SCHEMAS.script, generate })).rejects.toThrow(
      'socket hang up',
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('surfacingFor — what the UI shows on the 3rd failure', () => {
  it('returns the failing field, schema version and retry count verbatim', async () => {
    const outcome = await validateWithRetry({
      schema: TEXT_SCHEMAS.script,
      generate: async () => withoutScriptBody(),
    });
    if (outcome.ok) throw new Error('expected exhausted validation');

    const surface = surfacingFor(outcome.failure);

    expect(surface.failing_field).toBe('script');
    expect(surface.schema_version).toBe('script.v2');
    expect(surface.retry_count).toBe(3);
    expect(surface.max_attempts).toBe(3);
    expect(surface.message).toContain('script');
    expect(surface.message).toContain('script.v2');
    expect(surface.message).toContain('3 of 3');
    expect(surface.message).toContain('No downstream billable stage ran');
  });

  it('wraps the same failure for callers that prefer an exception', async () => {
    const outcome = await validateWithRetry({
      schema: TEXT_SCHEMAS.script,
      generate: async () => withoutScriptBody(),
    });
    if (outcome.ok) throw new Error('expected exhausted validation');

    const error = new SchemaRetryExhaustedError(outcome.failure);

    expect(error).toBeInstanceOf(Error);
    expect(error.failure).toBe(outcome.failure);
    expect(error.message).toContain('script.v2');
    expect(error.message).toContain('script');
  });
});
