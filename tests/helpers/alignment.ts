/**
 * Builds `CharacterAlignment` payloads for the word-timing tests.
 *
 * The shape is TECH_DESIGN §5.4: three parallel arrays (characters plus start/end
 * times in seconds). The helper lays words out on a fixed slot so a test can
 * assert exact millisecond spans, and can deliberately break a payload
 * (`untimedWords`, `reversedWords`) to prove the validator catches it.
 */
import type { CharacterAlignment } from '../../src/domain/word-timing.js';

export interface AlignmentBuildOptions {
  /** Start-to-start spacing between words, in seconds. */
  readonly wordSlotS?: number;
  /** Spoken length of each word, in seconds (must be < wordSlotS). */
  readonly speechS?: number;
  /** Word indexes with no timing at all (simulates missing characters). */
  readonly untimedWords?: readonly number[];
  /** Word indexes whose first character gets an end time before its start. */
  readonly reversedWords?: readonly number[];
}

export function alignmentFromWords(
  words: readonly string[],
  options: AlignmentBuildOptions = {},
): CharacterAlignment {
  const wordSlotS = options.wordSlotS ?? 1;
  const speechS = options.speechS ?? 0.5;
  const untimed = new Set(options.untimedWords ?? []);
  const reversed = new Set(options.reversedWords ?? []);

  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  words.forEach((word, wordIndex) => {
    const wordStart = wordIndex * wordSlotS;
    const step = speechS / word.length;
    [...word].forEach((character, charIndex) => {
      const start = wordStart + charIndex * step;
      const end = wordStart + (charIndex + 1) * step;
      characters.push(character);
      if (untimed.has(wordIndex)) {
        starts.push(Number.NaN);
        ends.push(Number.NaN);
      } else if (reversed.has(wordIndex) && charIndex === 0) {
        starts.push(start);
        ends.push(start - 0.05);
      } else {
        starts.push(start);
        ends.push(end);
      }
    });

    const nextWordStart = (wordIndex + 1) * wordSlotS;
    if (wordIndex < words.length - 1) {
      characters.push(' ');
      starts.push(wordStart + speechS);
      ends.push(nextWordStart);
    }
  });

  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}
