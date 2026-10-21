import { describe, expect, it } from 'vitest';

import { sceneRowPosition, unwrapTextDocument } from './text-stage.js';

/**
 * `runProviderAttempt` hands the adapter's envelope to `onResult`. Reading the
 * envelope as if it were the document cost a CI cycle: SC threw on
 * `undefined.trim()` and T persisted an empty title instead of failing.
 */
describe('unwrapTextDocument', () => {
  it('returns the document inside the adapter envelope', () => {
    const document = { hook: 'h', narration: 'n', ending: 'e' };
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
