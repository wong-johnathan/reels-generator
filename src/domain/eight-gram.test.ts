/**
 * R-003-2 — the automated 8-gram verbatim scan (US-017).
 *
 * Signal (LEAD_PLAN §4/B-09): "a planted 8-word run is detected, a 7-word run is
 * not." Everything else here protects that signal: normalisation must not create
 * a false pass, the reported run must be the maximal one, and the gram length
 * must actually be configurable rather than a constant in disguise.
 */
import { describe, expect, it } from 'vitest';

import { QUIET_MACHINES_FIXTURES } from '../adapters/text-fixtures.js';
import {
  DEFAULT_GRAM_LENGTH,
  normaliseWords,
  scanForVerbatimRuns,
  scanScript,
  scriptFields,
} from './eight-gram.js';

const REFERENCE_TEXT =
  'The quiet machine hums in the corner of the studio while the operator waits for the render to finish.';

const reference = {
  id: 'ref-1',
  title: 'Machine notes',
  source_text: REFERENCE_TEXT,
};

/** Exactly `count` words from the reference, starting at word 0. */
function referenceRun(count: number): string {
  return normaliseWords(REFERENCE_TEXT).slice(0, count).join(' ');
}

describe('normaliseWords', () => {
  it('casefolds, strips punctuation and collapses whitespace', () => {
    expect(normaliseWords('  The quiet, MACHINE — hums!  ')).toEqual([
      'the',
      'quiet',
      'machine',
      'hums',
    ]);
  });

  it('keeps an apostrophe inside a word but drops leading/trailing quotes', () => {
    expect(normaliseWords("\"don't\" 'stop'")).toEqual(["don't", 'stop']);
  });
});

describe('scanForVerbatimRuns — R-003-2 signal', () => {
  it('detects a planted 8-word run at the default gram length', () => {
    const run = referenceRun(8);
    const result = scanForVerbatimRuns(
      [{ field: 'narration', text: `An original opening. ${run} at last.` }],
      [reference],
    );

    expect(result.pass).toBe(false);
    expect(result.gram_length).toBe(DEFAULT_GRAM_LENGTH);
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0]!;
    expect(violation.words).toHaveLength(8);
    expect(violation.reference_id).toBe('ref-1');
    expect(violation.reference_title).toBe('Machine notes');
    expect(violation.field).toBe('narration');
    // "An original opening" is three tokens before the planted run.
    expect(violation.word_index).toBe(3);
    expect(violation.text).toBe(run);
  });

  it('does not flag a 7-word run at the default gram length', () => {
    const run = referenceRun(7);
    const result = scanForVerbatimRuns(
      [{ field: 'narration', text: `An original opening. ${run} at last.` }],
      [reference],
    );

    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('flags that same 7-word run when the gram length is configured to 7', () => {
    const run = referenceRun(7);
    const result = scanForVerbatimRuns(
      [{ field: 'narration', text: `An original opening. ${run} at last.` }],
      [reference],
      { gram: 7 },
    );

    expect(result.gram_length).toBe(7);
    expect(result.pass).toBe(false);
    expect(result.violations[0]!.words).toHaveLength(7);
  });

  it('matches across case, punctuation and line-break differences', () => {
    const run = 'THE QUIET, machine — HUMS in the\ncorner OF';
    const result = scanForVerbatimRuns([{ field: 'narration', text: run }], [reference]);

    expect(result.pass).toBe(false);
    expect(result.violations[0]!.words).toHaveLength(8);
  });

  it('reports exactly one maximal violation for a longer matching run', () => {
    const run = referenceRun(10);
    const result = scanForVerbatimRuns([{ field: 'narration', text: run }], [reference]);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.words).toHaveLength(10);
  });

  it('reports the same run once per matching reference', () => {
    const other = { id: 'ref-2', title: 'Second note', source_text: referenceRun(9) };
    const result = scanForVerbatimRuns(
      [{ field: 'narration', text: referenceRun(9) }],
      [reference, other],
    );

    expect(result.violations.map((violation) => violation.reference_id)).toEqual([
      'ref-1',
      'ref-2',
    ]);
  });

  it('does not join words across a field boundary', () => {
    const words = referenceRun(8).split(' ');
    const result = scanForVerbatimRuns(
      [
        { field: 'hook', text: words.slice(0, 4).join(' ') },
        { field: 'ending', text: words.slice(4).join(' ') },
      ],
      [reference],
    );

    expect(result.pass).toBe(true);
  });

  it('surfaces a human-readable violation string for each run', () => {
    const run = referenceRun(8);
    const result = scanForVerbatimRuns([{ field: 'narration', text: run }], [reference]);

    expect(result.violation_strings).toHaveLength(1);
    expect(result.violation_strings[0]).toContain('8-word');
    expect(result.violation_strings[0]).toContain('narration');
    expect(result.violation_strings[0]).toContain('Machine notes');
  });

  it('treats an empty reference as nothing to compare against', () => {
    const result = scanForVerbatimRuns(
      [{ field: 'narration', text: referenceRun(12) }],
      [{ id: 'empty', title: null, source_text: '   \n ' }],
    );

    expect(result.pass).toBe(true);
    expect(result.references_scanned).toBe(1);
  });

  it('rejects a gram length that is not a positive integer', () => {
    expect(() => scanForVerbatimRuns([], [reference], { gram: 0 })).toThrow(RangeError);
    expect(() => scanForVerbatimRuns([], [reference], { gram: -8 })).toThrow(RangeError);
    expect(() => scanForVerbatimRuns([], [reference], { gram: 2.5 })).toThrow(RangeError);
  });
});

describe('scanScript — all final generated text', () => {
  it('scans the script, title, description and hashtags', () => {
    const fields = scriptFields({
      script: 'An original hook. Original narration words only. An original ending.',
      title: 'An original title',
      description: 'An original description with no borrowed run at all.',
      hashtags: ['#original', '#prose'],
    });
    expect(fields.map((field) => field.field)).toEqual([
      'script',
      'title',
      'description',
      'hashtags',
    ]);
  });

  it('flags a run planted in any script field, naming that field', () => {
    const script = { ...QUIET_MACHINES_FIXTURES.script };
    script.description = `${script.description} ${referenceRun(9)}`;

    const result = scanScript(script, [reference]);

    expect(result.pass).toBe(false);
    expect(result.violations.every((violation) => violation.field === 'description')).toBe(true);
  });

  it('passes the canonical fixture, which is original prose', () => {
    const result = scanScript(QUIET_MACHINES_FIXTURES.script, [reference]);
    expect(result.pass).toBe(true);
  });
});
