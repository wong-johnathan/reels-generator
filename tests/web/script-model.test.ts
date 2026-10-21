import { describe, expect, it } from 'vitest';

import { ScriptViewSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  approvalView,
  claimsView,
  eightGramView,
  scriptStatusView,
  wordBudgetView,
  type ScriptView,
} from '../../src/web/script/model.js';

/**
 * S-10 view model (UI_SPEC §6.6 W-05, §5 UC-06, C-09/C-10/C-11, R-003-2,
 * R-027-3, R-005-2). Pure derivations from the frozen `ScriptViewSchema`; no
 * provider, no clock, no network.
 */

const base = ScriptViewSchema.parse(FIXTURES['script.get']);

function script(patch: Partial<ScriptView>): ScriptView {
  return ScriptViewSchema.parse({ ...base, ...patch });
}

type Claim = ScriptView['claims'][number];

function claim(patch: Partial<Claim>): Claim {
  const [first] = base.claims;
  if (first === undefined) throw new Error('fixture has no claims');
  return { ...first, ...patch };
}

describe('wordBudgetView — C-11 and the W-05 budget bar', () => {
  it('renders the measured rate and the band exactly as UI_SPEC §6.6 states', () => {
    const view = wordBudgetView(base);
    expect(view.wordsLine).toBe('228 words → 75.1 s @ 3.035 w/s');
    expect(view.bandLine).toBe('band 216–239 words (71.2–78.7 s)');
    expect(view.withinBand).toBe(true);
    expect(view.warning).toBeNull();
  });

  it('warns in the operator words when the count leaves the band', () => {
    const view = wordBudgetView(
      script({
        word_count: 240,
        estimated_runtime_s: 79.1,
        budget: { target_words: 228, min_words: 216, max_words: 239, within_band: false },
      }),
    );
    expect(view.withinBand).toBe(false);
    expect(view.warning).toBe(
      'Outside the band, narration will most likely miss the ±5% duration check and return here after one TTS call.',
    );
  });

  it('takes within_band from the server, never from a local comparison', () => {
    const view = wordBudgetView(
      script({
        word_count: 230,
        budget: { target_words: 228, min_words: 216, max_words: 239, within_band: false },
      }),
    );
    expect(view.withinBand).toBe(false);
  });
});

describe('eightGramView — R-003-2', () => {
  it('renders the pass wording and a done chip', () => {
    const view = eightGramView(base);
    expect(view.pass).toBe(true);
    expect(view.chipState).toBe('done');
    expect(view.label).toBe('8-gram');
    expect(view.text).toBe(
      '8-gram scan: PASS — no run of 8 or more words matches a stored reference.',
    );
  });

  it('names the matching reference on a fail', () => {
    const view = eightGramView(
      script({ eight_gram: { pass: false, violations: ['reference 2'] } }),
    );
    expect(view.pass).toBe(false);
    expect(view.chipState).toBe('failed');
    expect(view.text).toBe(
      '8-gram scan: FAIL — a run of 8 or more words matches reference 2. Reword before approval.',
    );
  });

  it('never leaks a reference body into the copy, only the label', () => {
    const view = eightGramView(
      script({
        eight_gram: {
          pass: false,
          violations: ['reference 2: "the quick brown fox jumps over the lazy dog again"'],
        },
      }),
    );
    expect(view.text).not.toContain('quick brown fox');
    expect(view.text).toContain('reference 2');
  });
});

describe('claimsView — claim rows and the C-10 counts', () => {
  it('counts factual, sourced and unresolved claims from the contract statuses', () => {
    const view = claimsView(base);
    expect(view.summary).toBe('CLAIMS (2 factual · 1 sourced · 1 unsourced)');
    expect(view.rows).toHaveLength(2);
    expect(view.rows[0]?.sourceLabel).toBe('example.org ok');
    expect(view.rows[0]?.unresolved).toBe(false);
    expect(view.rows[1]?.sourceLabel).toBe('-- !');
    expect(view.rows[1]?.unresolved).toBe(true);
    expect(view.sourced).toBe(1);
    expect(view.unresolved).toBe(1);
  });

  it('treats an unreachable URL as unresolved and shows the HTTP status', () => {
    const view = claimsView(
      script({
        claims: [
          claim({
            status: 'url_unreachable',
            url_status: 404,
            source: {
              id: '11111111-1111-4111-8111-111111111111',
              url: 'https://example.org/gone',
              title: null,
              domain: 'example.org',
              rerank_score: 2.1,
            },
          }),
        ],
      }),
    );
    expect(view.rows[0]?.sourceLabel).toBe('404 !');
    expect(view.rows[0]?.unresolved).toBe(true);
    expect(view.summary).toBe('CLAIMS (1 factual · 0 sourced · 1 unsourced)');
  });

  it('marks an acknowledged claim as resolved but keeps it visible', () => {
    const view = claimsView(
      script({ claims: [claim({ status: 'acknowledged_unsourced', source: null })] }),
    );
    expect(view.rows[0]?.sourceLabel).toBe('acknowledged');
    expect(view.rows[0]?.unresolved).toBe(false);
    expect(view.acknowledged).toBe(1);
  });

  it('does not count a non-factual claim as factual', () => {
    const view = claimsView(
      script({ claims: [claim({ status: 'non_factual', is_factual: false })] }),
    );
    expect(view.factual).toBe(0);
    expect(view.summary).toBe('CLAIMS (0 factual · 0 sourced · 0 unsourced)');
  });
});

describe('approvalView — the mandatory script gate (R-005-2)', () => {
  const detail = { scene_count: 17 };

  it('replaces the control with a record line once approved', () => {
    const view = approvalView(base, detail);
    expect(view.approved).toBe(true);
    expect(view.canApprove).toBe(false);
    expect(view.record).toBe('Approved rev 4 · operator · 2026-10-20T09:41:12Z');
    expect(view.record).toContain('operator');
    expect(view.reasons).toEqual([]);
  });

  it('blocks approval with the exact C-10 sentence and wires the description', () => {
    const view = approvalView(
      script({
        status: 'draft',
        approved_at: null,
        claims: [
          claim({ id: '22222222-2222-4222-8222-222222222222', status: 'unsourced', source: null }),
          claim({ id: '33333333-3333-4333-8333-333333333333', status: 'sourced' }),
        ],
      }),
      detail,
    );
    expect(view.approved).toBe(false);
    expect(view.canApprove).toBe(false);
    expect(view.reasons).toEqual([
      'Script approval is blocked: 1 of 2 factual claims has no resolvable source. Source, reword or acknowledge it first.',
    ]);
    expect(view.describedBy).toBe('script-approve-reason');
  });

  it('counts every unresolved claim in the C-10 sentence', () => {
    const view = approvalView(
      script({
        status: 'draft',
        approved_at: null,
        claims: [
          claim({ id: '22222222-2222-4222-8222-222222222222', status: 'unsourced', source: null }),
          claim({
            id: '33333333-3333-4333-8333-333333333333',
            status: 'url_unreachable',
            url_status: 404,
          }),
          claim({ id: '44444444-4444-4444-8444-444444444444', status: 'sourced' }),
        ],
      }),
      detail,
    );
    expect(view.reasons[0]).toBe(
      'Script approval is blocked: 2 of 3 factual claims have no resolvable source. Source, reword or acknowledge all 2 first.',
    );
  });

  it('blocks a failed 8-gram scan before anything else', () => {
    const view = approvalView(
      script({
        status: 'draft',
        approved_at: null,
        eight_gram: { pass: false, violations: ['reference 2'] },
      }),
      detail,
    );
    expect(view.canApprove).toBe(false);
    expect(view.reasons[0]).toBe(
      '8-gram scan: FAIL — a run of 8 or more words matches reference 2. Reword before approval.',
    );
  });

  it('states what approval unlocks (C-09) and enables the gate when clean', () => {
    const view = approvalView(
      script({
        status: 'draft',
        approved_at: null,
        claims: [claim({ status: 'sourced' })],
      }),
      detail,
    );
    expect(view.canApprove).toBe(true);
    expect(view.describedBy).toBeNull();
    expect(view.reasons).toEqual([]);
    expect(view.unlockLine).toBe(
      'Approving the script unlocks 17 image calls and 1 TTS call for this video. Nothing runs until you approve.',
    );
  });

  it('allows approval with acknowledged claims and says so (R-027-3, OQ-1)', () => {
    const view = approvalView(
      script({
        status: 'draft',
        approved_at: null,
        claims: [
          claim({ status: 'acknowledged_unsourced', source: null }),
          claim({ id: '33333333-3333-4333-8333-333333333333', status: 'sourced' }),
        ],
      }),
      detail,
    );
    expect(view.canApprove).toBe(true);
    expect(view.note).toBe(
      'Approval is allowed. 1 claim is acknowledged as unsourced and is listed in the export source manifest.',
    );
  });
});

describe('scriptStatusView — the S-10 status bar', () => {
  it('reports the revision and the unsaved marker', () => {
    const clean = scriptStatusView(base, { dirty: false });
    expect(clean.line).toBe('Script rev 4');
    expect(clean.revision).toBe(4);
    expect(clean.dirty).toBe(false);

    const dirty = scriptStatusView(base, { dirty: true });
    expect(dirty.line).toBe('Script rev 4 (unsaved changes)');
    expect(dirty.dirty).toBe(true);
  });
});
