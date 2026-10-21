/**
 * The verbatim-run scan — R-003-2, US-017.
 *
 * "No contiguous run of **≥8 words** from any stored reference appears verbatim
 * in generated script or narration, verified by an automated 8-gram substring
 * scan over all final generated text; the gram length is configurable (default
 * 8)."
 *
 * Two properties make this an actual protection rather than a keyword filter:
 *
 * 1. **Normalisation is symmetric.** Reference text and generated text go through
 *    the same casefold/punctuation/whitespace normalisation, so re-punctuating or
 *    re-casing a stolen sentence does not launder it. The reported words are the
 *    normalised ones.
 * 2. **The reported run is maximal.** A 10-word lift produces one violation
 *    naming 10 words, not three overlapping 8-word windows: the operator gets the
 *    size of the problem, and storage does not fill with near-duplicate rows.
 *
 * A run longer than the gram length still contains a gram-length run, so
 * `gram = 8` catches every run of 8 or more words — which is what R-003-2 asks
 * for. The knob exists because the PRD makes it configurable, not because a
 * smaller default would be acceptable.
 */

/** R-003-2's default gram length. */
export const DEFAULT_GRAM_LENGTH = 8;

/** A stored series reference. `source_text` is never sent to a provider (R-003-3). */
export interface ReferenceSource {
  readonly id: string;
  readonly title?: string | null;
  readonly source_text: string;
}

/** One field of generated text. `field` is the path the operator sees. */
export interface GeneratedField {
  readonly field: string;
  readonly text: string;
}

export interface EightGramOptions {
  /** R-003-2's configurable gram length. Must be a positive integer. */
  readonly gram?: number;
}

export interface EightGramViolation {
  readonly reference_id: string;
  readonly reference_title: string | null;
  readonly field: string;
  readonly gram_length: number;
  /** 0-based word index in the generated field where the run starts. */
  readonly word_index: number;
  /** The normalised words of the (maximal) matching run. */
  readonly words: readonly string[];
  /** `words` joined by single spaces — what the operator is shown. */
  readonly text: string;
}

export interface EightGramScanResult {
  readonly pass: boolean;
  readonly gram_length: number;
  readonly references_scanned: number;
  readonly fields_scanned: number;
  readonly violations: readonly EightGramViolation[];
  /** `script_revision.eight_gram_violations` / `ScriptView.eight_gram.violations`. */
  readonly violation_strings: readonly string[];
}

/** The prose fields of a script document: every field a provider generated. */
export interface ScriptText {
  readonly hook: string;
  readonly narration: string;
  readonly ending: string;
  readonly title: string;
  readonly description: string;
  readonly hashtags?: readonly string[] | null;
}

const WORD_SEPARATOR = '\u0000';

/**
 * Normalise text to comparable words: NFKC, lowercase, smart quotes folded to
 * `'`, everything that is not a letter/digit/apostrophe becomes a separator.
 * Hyphens and em dashes split words; apostrophes inside a word are kept.
 */
export function normaliseWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .split(' ')
    .map((word) => word.replace(/^'+/, '').replace(/'+$/, ''))
    .filter((word) => word.length > 0);
}

interface IndexedReference {
  readonly source: ReferenceSource;
  readonly tokens: readonly string[];
  /** Every n-gram of this reference → the start indices where it occurs. */
  readonly index: ReadonlyMap<string, readonly number[]>;
}

function indexReference(source: ReferenceSource, gram: number): IndexedReference {
  const tokens = normaliseWords(source.source_text);
  const index = new Map<string, number[]>();
  for (let start = 0; start + gram <= tokens.length; start += 1) {
    const key = tokens.slice(start, start + gram).join(WORD_SEPARATOR);
    const existing = index.get(key);
    if (existing === undefined) index.set(key, [start]);
    else existing.push(start);
  }
  return { source, tokens, index };
}

/** The longest run starting at `start` that this reference also contains at `referenceStart`. */
function extensionLength(
  generated: readonly string[],
  start: number,
  reference: IndexedReference,
  referenceStart: number,
  gram: number,
): number {
  let length = gram;
  while (
    start + length < generated.length &&
    referenceStart + length < reference.tokens.length &&
    generated[start + length] === reference.tokens[referenceStart + length]
  ) {
    length += 1;
  }
  return length;
}

function violationLabel(violation: EightGramViolation): string {
  const label = violation.reference_title ?? violation.reference_id;
  const at = `word ${violation.word_index + 1}`;
  return (
    `reference "${label}" (${violation.reference_id}): ${violation.words.length}-word ` +
    `verbatim run in ${violation.field} at ${at}: "${violation.text}"`
  );
}

function assertGram(gram: number): void {
  if (!Number.isInteger(gram) || gram < 1) {
    throw new RangeError(`gram length must be a positive integer, got ${String(gram)}`);
  }
}

/**
 * Scan generated fields for verbatim runs of `gram` words (default 8) present in
 * any reference. Fields are scanned in order; a run never spans two fields.
 */
export function scanForVerbatimRuns(
  generated: readonly GeneratedField[],
  references: readonly ReferenceSource[],
  options: EightGramOptions = {},
): EightGramScanResult {
  const gram = options.gram ?? DEFAULT_GRAM_LENGTH;
  assertGram(gram);

  const indexed = references.map((reference) => indexReference(reference, gram));
  const violations: EightGramViolation[] = [];

  for (const field of generated) {
    const tokens = normaliseWords(field.text);
    let start = 0;
    while (start + gram <= tokens.length) {
      const key = tokens.slice(start, start + gram).join(WORD_SEPARATOR);
      let advance = 1;
      let matched = false;

      for (const reference of indexed) {
        const starts = reference.index.get(key);
        if (starts === undefined) continue;

        let best = gram;
        for (const referenceStart of starts) {
          const length = extensionLength(tokens, start, reference, referenceStart, gram);
          if (length > best) best = length;
        }

        const words = tokens.slice(start, start + best);
        violations.push({
          reference_id: reference.source.id,
          reference_title: reference.source.title ?? null,
          field: field.field,
          gram_length: gram,
          word_index: start,
          words,
          text: words.join(' '),
        });
        matched = true;
        if (best > advance) advance = best;
      }

      start += matched ? advance : 1;
    }
  }

  return {
    pass: violations.length === 0,
    gram_length: gram,
    references_scanned: references.length,
    fields_scanned: generated.length,
    violations,
    violation_strings: violations.map(violationLabel),
  };
}

/** Every provider-generated text field of a script, in display order. */
export function scriptFields(script: ScriptText): GeneratedField[] {
  const fields: GeneratedField[] = [
    { field: 'hook', text: script.hook },
    { field: 'narration', text: script.narration },
    { field: 'ending', text: script.ending },
    { field: 'title', text: script.title },
    { field: 'description', text: script.description },
  ];
  if (script.hashtags !== undefined && script.hashtags !== null && script.hashtags.length > 0) {
    fields.push({ field: 'hashtags', text: script.hashtags.join(' ') });
  }
  return fields;
}

/** R-003-2 over a whole script document. */
export function scanScript(
  script: ScriptText,
  references: readonly ReferenceSource[],
  options: EightGramOptions = {},
): EightGramScanResult {
  return scanForVerbatimRuns(scriptFields(script), references, options);
}
