import { describe, expect, it } from 'vitest';

import { TEXT_SCHEMAS } from '../adapters/text-schemas.js';
import {
  normalizeDocument,
  sceneRowPosition,
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
        usage: {},
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
