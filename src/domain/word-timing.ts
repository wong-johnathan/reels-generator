/**
 * Character alignment -> word timings — US-022 (word-timing half), R-008-3.
 *
 * ElevenLabs `convert-with-timestamps` returns a character-level alignment
 * (TECH_DESIGN §5.4). Captions, scene spans and the S-14 word-timing display are
 * built from *word* timings, so this module is the single transform between the
 * two — no other code groups characters.
 *
 * The quality gate is R-008-3's: "character-level alignment on a ≥60 s sample
 * with **≥99% word coverage** and **monotonic word timestamps**". Two coverage
 * numbers are reported on purpose, because they fail differently:
 *
 * - `character_coverage` — timed characters / aligned characters. This is what
 *   QUALIFICATION §2 measured ("100.0%, 1,311 of 1,311 characters").
 * - `word_coverage` — words that received a span / words present in the
 *   alignment.
 * - `script_coverage` — words that received a span / words in the script the
 *   operator approved. A provider that silently normalises text ("1984" spoken
 *   as "nineteen eighty-four") can score 100% on the first two and still lose
 *   script words; reporting it against the script is what catches that. It is
 *   `null` when no script text is supplied.
 *
 * A miss fails validation and returns the video to script/voice review
 * (R-009-4). Nothing here time-stretches or invents a timestamp: an untimed word
 * is dropped from the caption list and counted against coverage.
 */

/** The provider payload of TECH_DESIGN §5.4, unchanged. */
export interface CharacterAlignment {
  readonly characters: readonly string[];
  readonly character_start_times_seconds: readonly number[];
  readonly character_end_times_seconds: readonly number[];
}

/** The shape the frozen `WordTimingSchema` in `contract/api.ts` expects. */
export interface WordTiming {
  readonly word: string;
  readonly start_ms: number;
  readonly end_ms: number;
}

/** R-008-3: at least 99% of words must carry a timestamp. */
export const MIN_WORD_COVERAGE = 0.99;

/** R-008-3: the qualification sample must be at least 60 s of speech. */
export const MIN_QUALIFICATION_SAMPLE_S = 60;

export type WordTimingViolationKind =
  'untimed_word' | 'end_before_start' | 'negative_time' | 'non_monotonic';

export interface WordTimingViolation {
  readonly kind: WordTimingViolationKind;
  /** Index into the derived word list (`words`, for ordering violations) or the aligned words. */
  readonly index: number;
  readonly word: string;
}

export interface AlignmentCoverage {
  readonly alignment_characters: number;
  readonly timed_characters: number;
  readonly character_coverage: number;
  readonly alignment_words: number;
  readonly timed_words: number;
  readonly word_coverage: number;
  readonly script_words: number | null;
  readonly script_coverage: number | null;
}

export interface WordTimingResult {
  /** Only words with a complete, ordered span — safe to caption. */
  readonly words: readonly WordTiming[];
  readonly coverage: AlignmentCoverage;
  /** True when no ordering violation was found among the emitted words. */
  readonly monotonic: boolean;
  readonly violations: readonly WordTimingViolation[];
}

export interface WordTimingValidation {
  readonly ok: boolean;
  /** Named, printable failures — surfaced to the operator, one per broken rule. */
  readonly failures: readonly string[];
}

export class WordTimingAlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WordTimingAlignmentError';
  }
}

const WHITESPACE = /^\s+$/;

/** Words in a script, by the same whitespace rule the alignment grouping uses. */
export function countTextWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function toMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000);
}

function isTimed(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end);
}

interface AccumulatedWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly violation: 'end_before_start' | 'negative_time' | null;
}

/**
 * Group the alignment into words. A word breaks on whitespace; its span is the
 * first character's start to the last character's end. Punctuation stays with
 * its word ("morning," is one caption token).
 */
function accumulateWords(alignment: CharacterAlignment): AccumulatedWord[] {
  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment;

  if (characters.length === 0) {
    throw new WordTimingAlignmentError('alignment carries no characters');
  }
  if (characters.length !== starts.length || characters.length !== ends.length) {
    throw new WordTimingAlignmentError(
      `alignment arrays disagree in length: characters=${characters.length}, ` +
        `character_start_times_seconds=${starts.length}, character_end_times_seconds=${ends.length}`,
    );
  }

  const words: AccumulatedWord[] = [];
  let text = '';
  let wordStart = Number.NaN;
  let wordEnd = Number.NaN;
  let violation: AccumulatedWord['violation'] = null;

  const flush = (): void => {
    if (text === '') return;
    words.push({ text, start: wordStart, end: wordEnd, violation });
    text = '';
    wordStart = Number.NaN;
    wordEnd = Number.NaN;
    violation = null;
  };

  characters.forEach((character, index) => {
    if (WHITESPACE.test(character)) {
      flush();
      return;
    }
    const start = starts[index] ?? Number.NaN;
    const end = ends[index] ?? Number.NaN;

    if (text === '') {
      wordStart = start;
      if (!isTimed(start, end)) {
        violation = null;
      } else if (end < start) {
        violation = 'end_before_start';
      } else if (start < 0) {
        violation = 'negative_time';
      }
    }
    text += character;
    if (isTimed(start, end)) {
      wordEnd = end;
    }
  });
  flush();

  return words;
}

/**
 * Derive caption-ready word timings from a character alignment.
 *
 * Pass `script` whenever the approved narration text is available: it adds
 * `script_coverage`, which is the only number that notices words the provider
 * never aligned.
 */
export function deriveWordTimings(
  alignment: CharacterAlignment,
  options: { readonly script?: string } = {},
): WordTimingResult {
  const accumulated = accumulateWords(alignment);
  const words: WordTiming[] = [];
  const violations: WordTimingViolation[] = [];

  let timedCharacters = 0;
  for (let index = 0; index < alignment.characters.length; index += 1) {
    const start = alignment.character_start_times_seconds[index] ?? Number.NaN;
    const end = alignment.character_end_times_seconds[index] ?? Number.NaN;
    if (isTimed(start, end) && end >= start && start >= 0) timedCharacters += 1;
  }

  accumulated.forEach((word, alignedWordIndex) => {
    const timed =
      word.violation === null &&
      isTimed(word.start, word.end) &&
      word.end >= word.start &&
      word.start >= 0;

    if (timed) {
      words.push({
        word: word.text,
        start_ms: toMilliseconds(word.start),
        end_ms: toMilliseconds(word.end),
      });
      return;
    }

    const kind: WordTimingViolationKind =
      word.violation === 'end_before_start'
        ? 'end_before_start'
        : word.violation === 'negative_time'
          ? 'negative_time'
          : 'untimed_word';
    violations.push({ kind, index: alignedWordIndex, word: word.text });
  });

  let monotonic = true;
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1]!;
    const current = words[index]!;
    if (current.start_ms < previous.end_ms) {
      monotonic = false;
      violations.push({ kind: 'non_monotonic', index, word: current.word });
    }
  }

  const scriptWords = options.script === undefined ? null : countTextWords(options.script);
  const alignmentWords = accumulated.length;

  return {
    words,
    coverage: {
      alignment_characters: alignment.characters.length,
      timed_characters: timedCharacters,
      character_coverage:
        alignment.characters.length === 0 ? 0 : timedCharacters / alignment.characters.length,
      alignment_words: alignmentWords,
      timed_words: words.length,
      word_coverage: alignmentWords === 0 ? 0 : words.length / alignmentWords,
      script_words: scriptWords,
      script_coverage:
        scriptWords === null || scriptWords === 0 ? null : words.length / scriptWords,
    },
    monotonic,
    violations,
  };
}

function ratio(value: number): string {
  return value.toFixed(4);
}

/**
 * Apply the R-008-3 gate to a derivation. Coverage is compared with `>=` on the
 * computed ratio so exactly 99/100 words passes and 98/100 does not.
 */
export function validateWordTimings(result: WordTimingResult): WordTimingValidation {
  const failures: string[] = [];
  const { coverage } = result;

  if (result.words.length === 0) {
    failures.push('no word timings were derived from the alignment');
  }
  if (coverage.character_coverage < MIN_WORD_COVERAGE) {
    failures.push(
      `character_coverage ${ratio(coverage.character_coverage)} < ${MIN_WORD_COVERAGE} (R-008-3)`,
    );
  }
  if (coverage.word_coverage < MIN_WORD_COVERAGE) {
    failures.push(
      `word_coverage ${ratio(coverage.word_coverage)} < ${MIN_WORD_COVERAGE} (R-008-3)`,
    );
  }
  if (coverage.script_coverage !== null && coverage.script_coverage < MIN_WORD_COVERAGE) {
    failures.push(
      `script_coverage ${ratio(coverage.script_coverage)} < ${MIN_WORD_COVERAGE}: ` +
        `${result.words.length} timed words for ${coverage.script_words} script words (R-008-3)`,
    );
  }
  if (!result.monotonic) {
    failures.push(
      `word timestamps are not monotonic: ${result.violations.filter((v) => v.kind === 'non_monotonic').length} ` +
        'word(s) start before the preceding word ends (R-008-3)',
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Duration of the narration as the alignment describes it: the last finite
 * character end time. The worker may refine this with ffprobe on the stored
 * audio; the alignment is the only duration the adapter can report.
 */
export function alignmentDurationSeconds(alignment: CharacterAlignment): number {
  let duration = 0;
  for (const end of alignment.character_end_times_seconds) {
    if (Number.isFinite(end) && end > duration) duration = end;
  }
  return duration;
}
