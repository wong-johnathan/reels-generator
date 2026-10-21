import { describe, expect, it } from 'vitest';

import { alignmentFromWords } from '../../tests/helpers/alignment.js';
import {
  deriveWordTimings,
  MIN_WORD_COVERAGE,
  validateWordTimings,
  WordTimingAlignmentError,
  alignmentDurationSeconds,
} from './word-timing.js';

/**
 * B-07 / US-022 (word-timing half) / R-008-3.
 *
 * The derived word timings are what the captions and the scene spans are built
 * from, so the unit under test is the transform: characters -> words, with the
 * gate R-008-3 names ("≥99% word coverage and monotonic word timestamps").
 */
describe('deriveWordTimings', () => {
  it('groups characters into words and spans each from its first and last character', () => {
    const alignment = alignmentFromWords(['hello', 'world'], { wordSlotS: 1, speechS: 0.5 });

    const result = deriveWordTimings(alignment);

    expect(result.words).toEqual([
      { word: 'hello', start_ms: 0, end_ms: 500 },
      { word: 'world', start_ms: 1000, end_ms: 1500 },
    ]);
  });

  it('keeps punctuation attached to its word (captions must not split "morning," in two)', () => {
    const alignment = alignmentFromWords(['morning,', 'notebook.'], { wordSlotS: 1, speechS: 0.5 });

    const result = deriveWordTimings(alignment);

    expect(result.words.map((word) => word.word)).toEqual(['morning,', 'notebook.']);
  });

  it('treats runs of whitespace (newlines, tabs) as a single break and emits no empty word', () => {
    const alignment = alignmentFromWords(['a', 'b', 'c'], { wordSlotS: 1, speechS: 0.2 });
    // Turn the single-space separators into a newline+tab run, keeping the timings.
    const characters = alignment.characters.map((character) =>
      character === ' ' ? '\n\t' : character,
    );

    const result = deriveWordTimings({ ...alignment, characters });

    expect(result.words.map((word) => word.word)).toEqual(['a', 'b', 'c']);
    expect(result.coverage.alignment_words).toBe(3);
  });

  it('rounds seconds to integral milliseconds', () => {
    const alignment = alignmentFromWords(['abcd'], { wordSlotS: 1, speechS: 0.1234 });

    const [word] = deriveWordTimings(alignment).words;

    expect(word?.start_ms).toBe(0);
    expect(word?.end_ms).toBe(123);
  });

  it('reports 100% character and word coverage for a complete alignment', () => {
    const words = ['one', 'two', 'three'];
    const alignment = alignmentFromWords(words);

    const result = deriveWordTimings(alignment, { script: words.join(' ') });

    expect(result.coverage).toMatchObject({
      alignment_characters: alignment.characters.length,
      timed_characters: alignment.characters.length,
      character_coverage: 1,
      alignment_words: 3,
      timed_words: 3,
      word_coverage: 1,
      script_words: 3,
      script_coverage: 1,
    });
    expect(result.monotonic).toBe(true);
    expect(result.violations).toEqual([]);
    expect(validateWordTimings(result).ok).toBe(true);
  });

  it('counts untimed characters against coverage and keeps their word out of the caption list', () => {
    const alignment = alignmentFromWords(['hello', 'world'], { untimedWords: [1] });

    const result = deriveWordTimings(alignment);

    expect(result.words.map((word) => word.word)).toEqual(['hello']);
    expect(result.coverage.timed_words).toBe(1);
    expect(result.coverage.word_coverage).toBeCloseTo(0.5, 10);
    expect(result.violations).toEqual([{ kind: 'untimed_word', index: 1, word: 'world' }]);
    expect(validateWordTimings(result).ok).toBe(false);
  });

  it('flags a non-monotonic timestamp with the offending word index', () => {
    const alignment = alignmentFromWords(['hello', 'world']);
    // Move "world" back so it starts before "hello" ends.
    const shift = -900;
    const characters = alignment.characters;
    const starts = [...alignment.character_start_times_seconds];
    const ends = [...alignment.character_end_times_seconds];
    const worldFirstChar = characters.indexOf('w');
    for (let index = worldFirstChar; index < characters.length; index += 1) {
      if (characters[index] === ' ') continue;
      starts[index] = (starts[index] ?? 0) + shift / 1000;
      ends[index] = (ends[index] ?? 0) + shift / 1000;
    }

    const result = deriveWordTimings({
      characters,
      character_start_times_seconds: starts,
      character_end_times_seconds: ends,
    });

    expect(result.monotonic).toBe(false);
    expect(result.violations).toEqual([{ kind: 'non_monotonic', index: 1, word: 'world' }]);
    expect(validateWordTimings(result).failures.join(' ')).toContain('monotonic');
  });

  it('flags a character whose end precedes its start and does not count it as timed', () => {
    const alignment = alignmentFromWords(['hello', 'world'], { reversedWords: [0] });

    const result = deriveWordTimings(alignment);

    expect(result.violations).toEqual([{ kind: 'end_before_start', index: 0, word: 'hello' }]);
    expect(result.coverage.timed_words).toBe(1);
  });

  it('rejects an alignment whose three arrays disagree in length', () => {
    const alignment = alignmentFromWords(['hello']);

    expect(() =>
      deriveWordTimings({
        characters: alignment.characters,
        character_start_times_seconds: alignment.character_start_times_seconds.slice(1),
        character_end_times_seconds: alignment.character_end_times_seconds,
      }),
    ).toThrow(WordTimingAlignmentError);
  });

  it('rejects an empty alignment instead of returning zero words', () => {
    expect(() =>
      deriveWordTimings({
        characters: [],
        character_start_times_seconds: [],
        character_end_times_seconds: [],
      }),
    ).toThrow(WordTimingAlignmentError);
  });

  it('reports script coverage when the provider alignment normalises words away', () => {
    // The script says three words; the alignment carries two (e.g. "1984" spoken as a year).
    const alignment = alignmentFromWords(['one', 'three']);

    const result = deriveWordTimings(alignment, { script: 'one two three' });

    expect(result.coverage.script_words).toBe(3);
    expect(result.coverage.script_coverage).toBeCloseTo(2 / 3, 10);
    expect(validateWordTimings(result).ok).toBe(false);
  });

  it('passes at exactly the 99% coverage threshold and fails one word below it', () => {
    const words = Array.from({ length: 100 }, (_, index) => `w${String(index).padStart(3, '0')}`);

    const atThreshold = deriveWordTimings(alignmentFromWords(words, { untimedWords: [7] }));
    const belowThreshold = deriveWordTimings(alignmentFromWords(words, { untimedWords: [7, 9] }));

    expect(MIN_WORD_COVERAGE).toBe(0.99);
    expect(atThreshold.coverage.word_coverage).toBe(0.99);
    expect(validateWordTimings(atThreshold).ok).toBe(true);
    expect(validateWordTimings(belowThreshold).ok).toBe(false);
  });
});

describe('alignmentDurationSeconds', () => {
  it('is the last character end time, not the word slot count', () => {
    const alignment = alignmentFromWords(['one', 'two'], { wordSlotS: 2, speechS: 0.5 });

    expect(alignmentDurationSeconds(alignment)).toBeCloseTo(2.5, 10);
  });

  it('ignores non-finite character times instead of reporting NaN or Infinity', () => {
    const alignment = {
      characters: ['a', 'b', 'c'],
      character_start_times_seconds: [0, 0.1, 0.2],
      character_end_times_seconds: [0.1, Number.NaN, Number.POSITIVE_INFINITY],
    };

    expect(alignmentDurationSeconds(alignment)).toBeCloseTo(0.1, 10);
  });
});
